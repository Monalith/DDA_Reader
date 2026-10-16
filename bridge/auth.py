"""Authentication for the hosted DDA Lab (Google sign-in + e-mail code), mirroring the
Kitchen on Stage flow: OAuth code flow with a state cookie → signed, httpOnly ``session``
cookie → ``/api/auth/me``.

Contract that other modules rely on (keep it):

    router: APIRouter                       # mounted by dda_lab_bridge.py (prefix /api/auth)
    class User(BaseModel): id, email, name, avatar_url | None, role ('user' | 'admin')
    def auth_enabled() -> bool              # False when GOOGLE_CLIENT_ID is unset (local / desktop use)
    def current_user(request) -> User | None   # from the session cookie; a synthetic local user when auth is disabled
    def require_user(request) -> User       # FastAPI dependency: 401 when not signed in
    def require_admin(request) -> User      # 403 unless role == 'admin' (ADMIN_EMAILS env, comma separated)
    def install(app) -> None                # middleware: when auth is enabled, unauthenticated /lab/ → 302 /login

Env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_SECRET (≥32 chars), APP_URL
(https://motoracelaps.com), ADMIN_EMAILS, RESEND_API_KEY + MAIL_FROM for e-mail codes.

Env is read per request (not at import), so tests can monkeypatch it.

Sessions: the cookie carries a signed ``{"sid": ...}``; the row in ``sessions`` makes
logout a real revocation. The role is derived from ADMIN_EMAILS on every request, so
removing an address from the list demotes it without a DB edit.
"""
from __future__ import annotations

import hashlib
import hmac
import html
import logging
import os
import re
import secrets
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import quote, urlencode

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from itsdangerous import BadSignature, URLSafeTimedSerializer
from pydantic import BaseModel

from bridge import db

log = logging.getLogger("dda_lab.auth")

router = APIRouter(prefix="/api/auth", tags=["auth"])

SESSION_COOKIE = "session"
STATE_COOKIE = "oauth_state"
SESSION_DAYS = 30
STATE_MAX_AGE = 600
OTP_TTL_S = 600
OTP_MAX_ATTEMPTS = 5
DEFAULT_REDIRECT = "/lab/"
EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"
RESEND_URL = "https://api.resend.com/emails"


class User(BaseModel):
    id: str
    email: str
    name: str = ""
    avatar_url: str | None = None
    role: str = "user"


def auth_enabled() -> bool:
    return bool(os.environ.get("GOOGLE_CLIENT_ID"))


LOCAL_USER = User(id="local", email="local@dda-lab", name="Local user", role="admin")


# --------------------------------------------------------------------------- #
# helpers                                                                     #
# --------------------------------------------------------------------------- #

def _now() -> datetime:
    return datetime.now(timezone.utc)


def _ts(d: datetime) -> str:
    return d.strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _secret() -> str:
    s = os.environ.get("SESSION_SECRET", "")
    if len(s) < 32:
        raise HTTPException(status_code=503, detail="SESSION_SECRET is not set (needs at least 32 characters)")
    return s


def _serializer(salt: str) -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(_secret(), salt=salt)


def _app_url(request: Request) -> str:
    base = os.environ.get("APP_URL") or str(request.base_url)
    return base.rstrip("/")


def _secure(request: Request) -> bool:
    return _app_url(request).startswith("https://")


def admin_emails() -> set[str]:
    return {e.strip().lower() for e in os.environ.get("ADMIN_EMAILS", "").split(",") if e.strip()}


def _role_for(email: str) -> str:
    return "admin" if email.lower() in admin_emails() else "user"


def safe_redirect(target: str | None) -> str:
    """Only same-origin relative paths: '/x' but never '//host', '/\\host' or 'scheme:'."""
    if not target or not target.startswith("/") or target.startswith("//") or target.startswith("/\\"):
        return DEFAULT_REDIRECT
    if any(c in target for c in "\r\n\t") or "\\" in target.split("?")[0]:
        return DEFAULT_REDIRECT
    return target


def _client_ip(request: Request) -> str:
    host = request.client.host if request.client else ""
    if host in ("127.0.0.1", "::1", "testclient", ""):  # behind nginx
        fwd = request.headers.get("x-real-ip") or request.headers.get("x-forwarded-for", "").split(",")[0]
        if fwd.strip():
            return fwd.strip()
    return host or "?"


class _RateLimiter:
    """In-memory sliding window; good enough for one uvicorn process."""

    def __init__(self) -> None:
        self._hits: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def hit(self, key: str, limit: int, window_s: float) -> bool:
        now = time.monotonic()
        with self._lock:
            hits = [t for t in self._hits.get(key, []) if now - t < window_s]
            ok = len(hits) < limit
            if ok:
                hits.append(now)
            self._hits[key] = hits
            if len(self._hits) > 10_000:  # bound memory
                for k in [k for k, v in self._hits.items() if not v or now - v[-1] > window_s]:
                    del self._hits[k]
            return ok

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


rate_limiter = _RateLimiter()


# --------------------------------------------------------------------------- #
# users + sessions                                                            #
# --------------------------------------------------------------------------- #

def _row_to_user(row) -> User:
    return User(
        id=row["id"], email=row["email"], name=row["name"] or "", avatar_url=row["avatar_url"],
        role=_role_for(row["email"]),
    )


def upsert_user(email: str, provider: str, name: str = "", avatar_url: str | None = None) -> User:
    email = email.strip().lower()
    role = _role_for(email)
    now = _ts(_now())
    with db.connect() as con:
        row = con.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        if row is None:
            uid = uuid.uuid4().hex
            con.execute(
                "INSERT INTO users (id, email, name, avatar_url, provider, role, last_login_at) VALUES (?,?,?,?,?,?,?)",
                (uid, email, name or email.split("@")[0], avatar_url, provider, role, now),
            )
        else:
            uid = row["id"]
            con.execute(
                "UPDATE users SET name = ?, avatar_url = ?, role = ?, last_login_at = ? WHERE id = ?",
                (name or row["name"], avatar_url or row["avatar_url"], role, now, uid),
            )
        row = con.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
    return _row_to_user(row)


def _create_session(user: User) -> str:
    sid = secrets.token_urlsafe(24)
    with db.connect() as con:
        con.execute("DELETE FROM sessions WHERE expires_at < ?", (_ts(_now()),))
        con.execute(
            "INSERT INTO sessions (id, user_id, expires_at) VALUES (?,?,?)",
            (sid, user.id, _ts(_now() + timedelta(days=SESSION_DAYS))),
        )
    return _serializer("session").dumps({"sid": sid})


def _set_session_cookie(resp, request: Request, user: User) -> None:
    resp.set_cookie(
        SESSION_COOKIE, _create_session(user), max_age=SESSION_DAYS * 86400, httponly=True,
        secure=_secure(request), samesite="lax", path="/",
    )


def _session_id(request: Request) -> str | None:
    raw = request.cookies.get(SESSION_COOKIE)
    if not raw or len(os.environ.get("SESSION_SECRET", "")) < 32:
        return None
    try:
        data = _serializer("session").loads(raw, max_age=SESSION_DAYS * 86400)
    except BadSignature:
        return None
    sid = data.get("sid") if isinstance(data, dict) else None
    return sid if isinstance(sid, str) else None


def current_user(request: Request) -> User | None:
    if not auth_enabled():
        return LOCAL_USER
    sid = _session_id(request)
    if not sid:
        return None
    with db.connect() as con:
        row = con.execute(
            "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?",
            (sid, _ts(_now())),
        ).fetchone()
    return _row_to_user(row) if row else None


def require_user(request: Request) -> User:
    u = current_user(request)
    if u is None:
        raise HTTPException(status_code=401, detail="sign in required")
    return u


def require_admin(request: Request) -> User:
    u = require_user(request)
    if u.role != "admin":
        raise HTTPException(status_code=403, detail="admin only")
    return u


# --------------------------------------------------------------------------- #
# routes                                                                      #
# --------------------------------------------------------------------------- #

@router.get("/me")
def me(request: Request) -> dict:
    u = current_user(request)
    return {"user": u.model_dump() if u else None, "authEnabled": auth_enabled()}


def _login_error(request: Request, code: str) -> RedirectResponse:
    resp = RedirectResponse(f"{_app_url(request)}/login?error={quote(code)}", status_code=302)
    resp.delete_cookie(STATE_COOKIE, path="/")
    return resp


@router.get("/google")
def google_start(request: Request, redirect: str = DEFAULT_REDIRECT):
    client_id = os.environ.get("GOOGLE_CLIENT_ID")
    if not client_id:
        return JSONResponse(status_code=503, content={"error": "Google login not configured"})
    state = secrets.token_urlsafe(24)
    callback = f"{_app_url(request)}/api/auth/google/callback"
    url = GOOGLE_AUTH_URL + "?" + urlencode({
        "client_id": client_id, "redirect_uri": callback, "response_type": "code",
        "scope": "openid email profile", "state": state, "prompt": "select_account",
    })
    resp = RedirectResponse(url, status_code=302)
    cookie = _serializer("oauth-state").dumps({"state": state, "redirect": safe_redirect(redirect), "callback": callback})
    resp.set_cookie(STATE_COOKIE, cookie, max_age=STATE_MAX_AGE, httponly=True,
                    secure=_secure(request), samesite="lax", path="/")
    return resp


def _google_exchange(code: str, callback: str) -> dict:
    """code → userinfo dict (raises on failure). Separate so tests can monkeypatch it."""
    with httpx.Client(timeout=10) as c:
        tok = c.post(GOOGLE_TOKEN_URL, data={
            "code": code, "client_id": os.environ.get("GOOGLE_CLIENT_ID", ""),
            "client_secret": os.environ.get("GOOGLE_CLIENT_SECRET", ""),
            "redirect_uri": callback, "grant_type": "authorization_code",
        }).json()
        access = tok.get("access_token")
        if not access:
            raise ValueError("token")
        return c.get(GOOGLE_USERINFO_URL, headers={"Authorization": f"Bearer {access}"}).json()


@router.get("/google/callback")
def google_callback(request: Request, code: str | None = None, state: str | None = None, error: str | None = None):
    if error:
        return _login_error(request, "oauth")
    raw = request.cookies.get(STATE_COOKIE)
    if not raw or not code:
        return _login_error(request, "state" if code else "oauth")
    try:
        saved = _serializer("oauth-state").loads(raw, max_age=STATE_MAX_AGE)
    except BadSignature:
        return _login_error(request, "state")
    if not isinstance(saved, dict) or not state or not hmac.compare_digest(str(saved.get("state", "")), state):
        return _login_error(request, "state")
    try:
        profile = _google_exchange(code, saved.get("callback") or f"{_app_url(request)}/api/auth/google/callback")
    except ValueError:
        return _login_error(request, "token")
    except Exception:  # network / JSON
        log.exception("google token exchange failed")
        return _login_error(request, "token")
    email = profile.get("email")
    if not email or profile.get("email_verified") is False:
        return _login_error(request, "profile")
    user = upsert_user(email, "google", profile.get("name") or email, profile.get("picture"))
    resp = RedirectResponse(f"{_app_url(request)}{safe_redirect(saved.get('redirect'))}", status_code=302)
    resp.delete_cookie(STATE_COOKIE, path="/")
    _set_session_cookie(resp, request, user)
    return resp


def _hash_code(email: str, code: str) -> str:
    return hashlib.sha256(f"{email}:{code}:{_secret()}".encode()).hexdigest()


def send_mail(to: str, subject: str, html_body: str, text: str) -> None:
    """Resend REST API. Raises on failure. Tests monkeypatch this."""
    key = os.environ.get("RESEND_API_KEY")
    if not key:
        raise RuntimeError("RESEND_API_KEY is not set")
    sender = os.environ.get("MAIL_FROM") or "MotoRaceLaps <onboarding@resend.dev>"
    r = httpx.post(RESEND_URL, timeout=10, headers={"Authorization": f"Bearer {key}"},
                   json={"from": sender, "to": [to], "subject": subject, "html": html_body, "text": text})
    if r.status_code >= 300:
        raise RuntimeError(f"Resend {r.status_code}: {r.text[:200]}")


def send_otp_email(email: str, code: str) -> None:
    send_mail(
        email,
        f"{code} — your MotoRaceLaps sign-in code",
        f"""<div style="font-family:sans-serif;max-width:420px;margin:0 auto;padding:32px 24px">
  <h2 style="margin:0 0 8px;color:#111">Sign in to MotoRaceLaps</h2>
  <p style="color:#555;margin:0 0 24px">Use this code to sign in.</p>
  <div style="background:#fff3e8;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px">
    <span style="font-size:40px;font-weight:700;letter-spacing:10px;color:#ff6a00">{code}</span>
  </div>
  <p style="color:#999;font-size:13px;margin:0">Valid for 10 minutes. Do not share this code.
  If you did not ask for it, ignore this e-mail.</p>
</div>""",
        f"Your MotoRaceLaps sign-in code: {code}\nValid for 10 minutes. Do not share this code.",
    )


class SendOtpBody(BaseModel):
    email: str


class VerifyOtpBody(BaseModel):
    email: str
    code: str


def _norm_email(raw: str) -> str:
    email = (raw or "").strip().lower()
    if len(email) > 254 or not EMAIL_RE.match(email):
        raise HTTPException(status_code=400, detail="Invalid e-mail address")
    return email


@router.post("/send-otp")
def send_otp(body: SendOtpBody, request: Request):
    if not auth_enabled():
        raise HTTPException(status_code=404, detail="sign-in is disabled on this server")
    email = _norm_email(body.email)
    if not os.environ.get("RESEND_API_KEY"):
        raise HTTPException(status_code=503, detail="E-mail sign-in is not configured on this server (RESEND_API_KEY). Use Google instead.")
    _secret()
    ip = _client_ip(request)
    if not rate_limiter.hit(f"otp-email:{email}", 3, 600) or not rate_limiter.hit(f"otp-ip:{ip}", 10, 600):
        raise HTTPException(status_code=429, detail="Too many requests — please wait 10 minutes")
    code = f"{secrets.randbelow(1_000_000):06d}"
    with db.connect() as con:
        con.execute("DELETE FROM otp_codes WHERE email = ? OR expires_at < ?", (email, _ts(_now())))
        con.execute("INSERT INTO otp_codes (email, code_hash, expires_at) VALUES (?,?,?)",
                    (email, _hash_code(email, code), _ts(_now() + timedelta(seconds=OTP_TTL_S))))
    try:
        send_otp_email(email, code)
    except Exception as e:  # don't leave a code nobody received
        log.warning("send-otp failed for %s: %s", email, e)
        with db.connect() as con:
            con.execute("DELETE FROM otp_codes WHERE email = ?", (email,))
        raise HTTPException(status_code=502, detail="Could not send the e-mail — try again or use Google") from None
    return {"sent": True}


@router.post("/verify-otp")
def verify_otp(body: VerifyOtpBody, request: Request):
    if not auth_enabled():
        raise HTTPException(status_code=404, detail="sign-in is disabled on this server")
    email = _norm_email(body.email)
    code = re.sub(r"\s+", "", body.code or "")
    if not rate_limiter.hit(f"verify-ip:{_client_ip(request)}", 30, 600):
        raise HTTPException(status_code=429, detail="Too many attempts — please wait 10 minutes")
    with db.connect() as con:
        row = con.execute(
            "SELECT rowid, code_hash, attempts FROM otp_codes WHERE email = ? AND expires_at > ? ORDER BY rowid DESC LIMIT 1",
            (email, _ts(_now())),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=401, detail="Invalid or expired code")
        if row["attempts"] >= OTP_MAX_ATTEMPTS:
            con.execute("DELETE FROM otp_codes WHERE email = ?", (email,))
            con.commit()
            raise HTTPException(status_code=429, detail="Too many wrong codes — request a new one")
        if not (re.fullmatch(r"\d{6}", code) and hmac.compare_digest(row["code_hash"], _hash_code(email, code))):
            con.execute("UPDATE otp_codes SET attempts = attempts + 1 WHERE rowid = ?", (row["rowid"],))
            con.commit()
            raise HTTPException(status_code=401, detail="Invalid or expired code")
        con.execute("DELETE FROM otp_codes WHERE email = ?", (email,))
    user = upsert_user(email, "email")
    resp = JSONResponse(content={"user": user.model_dump()})
    _set_session_cookie(resp, request, user)
    return resp


@router.post("/logout")
def logout(request: Request):
    sid = _session_id(request)
    if sid:
        with db.connect() as con:
            con.execute("DELETE FROM sessions WHERE id = ?", (sid,))
    resp = JSONResponse(content={"ok": True})
    resp.delete_cookie(SESSION_COOKIE, path="/", secure=_secure(request), httponly=True, samesite="lax")
    return resp


# --------------------------------------------------------------------------- #
# /login page + /lab/ gate                                                    #
# --------------------------------------------------------------------------- #

ERRORS = {
    "state": "The sign-in link expired or was opened in another browser. Please try again.",
    "oauth": "Google sign-in was cancelled.",
    "token": "Google sign-in failed. Please try again.",
    "profile": "Google did not share a verified e-mail address.",
}

LOGIN_HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · MotoRaceLaps</title>
<style>
:root{--bg:#0e1116;--panel:#151a21;--border:#262d37;--fg:#e6e9ef;--dim:#8b95a5;--accent:#ff6a00;--bad:#ff4d4f;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--fg);
font:14px/1.45 Inter,system-ui,-apple-system,'Segoe UI',sans-serif;padding:16px}
.card{width:100%;max-width:380px;background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:28px 24px}
.brand{font-weight:800;font-size:22px;letter-spacing:.3px;margin:0 0 4px}.brand span{color:var(--accent)}
.sub{color:var(--dim);margin:0 0 22px}
.btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:11px 14px;border-radius:8px;
border:1px solid var(--border);background:#fff;color:#1f1f1f;font:inherit;font-weight:600;text-decoration:none;cursor:pointer}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#111}
.btn:disabled{opacity:.6;cursor:default}
.or{display:flex;align-items:center;gap:10px;color:var(--dim);font-size:12px;margin:20px 0}
.or:before,.or:after{content:"";flex:1;height:1px;background:var(--border)}
label{display:block;font-size:12px;color:var(--dim);margin:0 0 6px}
input{width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--fg);font:inherit;margin:0 0 12px}
input:focus{outline:2px solid var(--accent);outline-offset:-1px}
#code{letter-spacing:6px;font-size:20px;text-align:center}
.msg{min-height:20px;font-size:13px;margin:4px 0 8px}.msg.err{color:var(--bad)}.msg.ok{color:var(--dim)}
.link{background:none;border:0;color:var(--dim);font:inherit;font-size:12px;cursor:pointer;padding:6px 0;text-decoration:underline}
.note{color:var(--dim);font-size:12px;margin:22px 0 0;text-align:center}
[hidden]{display:none!important}
</style></head><body>
<main class="card">
  <h1 class="brand">MotoRace<span>Laps</span></h1>
  <p class="sub">Sign in to open the lab.</p>
  <p class="msg err" id="err" role="alert">__ERROR__</p>
  <a class="btn" id="google" href="/api/auth/google">
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
    Continue with Google</a>
  <div class="or">or use an e-mail code</div>
  <form id="f-email">
    <label for="email">E-mail</label>
    <input id="email" type="email" autocomplete="email" required placeholder="you@example.com">
    <button class="btn primary" type="submit" id="send">Send me a code</button>
  </form>
  <form id="f-code" hidden>
    <label for="code">6-digit code sent to <b id="sent-to"></b></label>
    <input id="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required placeholder="000000">
    <button class="btn primary" type="submit" id="verify">Sign in</button>
    <button class="link" type="button" id="back">Use a different e-mail</button>
  </form>
  <p class="msg ok" id="info" aria-live="polite"></p>
  <p class="note">Your files never leave your browser &mdash; we only store your name and e-mail.</p>
</main>
<script>
(function(){
  var qs=new URLSearchParams(location.search), r=qs.get('redirect')||'/lab/';
  if(r.charAt(0)!=='/'||r.indexOf('//')===0||r.indexOf('/\\\\')===0) r='/lab/';
  document.getElementById('google').href='/api/auth/google?redirect='+encodeURIComponent(r);
  var $=function(id){return document.getElementById(id)}, err=$('err'), info=$('info'), email='';
  function say(e,i){err.textContent=e||'';info.textContent=i||'';}
  async function post(path,body){
    var res=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    var j={};try{j=await res.json();}catch(_){}
    if(!res.ok) throw new Error(typeof j.detail==='string'?j.detail:'Something went wrong ('+res.status+')');
    return j;
  }
  $('f-email').addEventListener('submit',async function(ev){
    ev.preventDefault(); email=$('email').value.trim(); $('send').disabled=true; say('','Sending…');
    try{await post('/api/auth/send-otp',{email:email}); $('sent-to').textContent=email;
      $('f-email').hidden=true; $('f-code').hidden=false; $('code').focus(); say('','Check your inbox (and spam folder).');}
    catch(e){say(e.message,'');} finally{$('send').disabled=false;}
  });
  $('f-code').addEventListener('submit',async function(ev){
    ev.preventDefault(); $('verify').disabled=true; say('','Checking…');
    try{await post('/api/auth/verify-otp',{email:email,code:$('code').value.trim()}); say('','Signed in — opening the lab…'); location.replace(r);}
    catch(e){say(e.message,''); $('verify').disabled=false;}
  });
  $('back').addEventListener('click',function(){$('f-code').hidden=true;$('f-email').hidden=false;$('code').value='';say('','');});
})();
</script>
</body></html>"""


def login_page(request: Request):
    target = safe_redirect(request.query_params.get("redirect"))
    if not auth_enabled() or current_user(request) is not None:
        return RedirectResponse(target, status_code=302)
    msg = ERRORS.get(request.query_params.get("error") or "", "")
    if request.query_params.get("error") and not msg:
        msg = "Sign-in failed. Please try again."
    return HTMLResponse(LOGIN_HTML.replace("__ERROR__", html.escape(msg)),
                        headers={"Cache-Control": "no-store", "X-Frame-Options": "DENY"})


GATED_PATHS = {"/lab", "/lab/", "/lab/index.html"}


def install(app) -> None:
    """/login page + (when auth is enabled) unauthenticated GET /lab/ → 302 /login?redirect=…"""
    app.add_api_route("/login", login_page, methods=["GET"], include_in_schema=False)
    app.add_api_route("/login/", login_page, methods=["GET"], include_in_schema=False)

    @app.middleware("http")
    async def _lab_gate(request: Request, call_next):
        if (request.method in ("GET", "HEAD") and request.url.path in GATED_PATHS and auth_enabled()
                and current_user(request) is None):
            target = "/lab/" + (f"?{request.url.query}" if request.url.query else "")
            return RedirectResponse("/login?" + urlencode({"redirect": target}), status_code=302)
        resp = await call_next(request)
        if request.url.path in GATED_PATHS and auth_enabled():
            resp.headers["Cache-Control"] = "no-store"  # never serve the gated entry page from cache
        return resp
