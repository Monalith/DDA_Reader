"""Usage statistics: the app posts small event batches; admins read summaries.

Contract:

    router: APIRouter                        # mounted by dda_lab_bridge.py (prefix /api/stats)
    POST /api/stats/events   {events: [{event, ts?, props?}], anonId}   -> {"ok": true, "stored": n}
                             (any visitor; rate-limited per anonId, size-capped; never errors on storage)
    GET  /api/stats/summary?days=30                                      -> admin only (bridge.auth.require_admin)
    GET  /api/stats/me                                                    -> the signed-in user's own counts

Storage: bridge.db ``usage_events`` table (created by bridge/db.py MIGRATIONS).
``session_key`` = sha256(anonId + UTC day): one "session" per browser per day.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
import threading
import time
from collections import deque
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from bridge import auth as _auth
from bridge import db as _db

log = logging.getLogger("dda_lab.stats")

router = APIRouter(prefix="/api/stats", tags=["stats"])

MAX_EVENTS_PER_BATCH = 50
MAX_PROPS_BYTES = 2048
RATE_LIMIT_EVENTS = 600
RATE_LIMIT_WINDOW_S = 600.0
_EVENT_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")

# Feature-usage tiles on the dashboard: event name -> count.
FEATURE_EVENTS = [
    "file_open",
    "example_open",
    "lap_select",
    "template_apply",
    "math_add",
    "marker_add",
    "sim_enable",
    "video_open",
    "export",
]


class EventIn(BaseModel):
    event: str = Field(max_length=64)
    ts: str | None = Field(default=None, max_length=40)
    props: dict[str, Any] | None = None


class EventsIn(BaseModel):
    anonId: str = Field(min_length=1, max_length=64)
    events: list[EventIn] = Field(max_length=500)  # more than 500 is rejected; >50 is truncated


# ---- rate limit ---------------------------------------------------------------
_rl_lock = threading.Lock()
_rl: dict[str, deque[tuple[float, int]]] = {}


def _rate_allow(anon_id: str, n: int, now: float | None = None) -> int:
    """How many of ``n`` events this anonId may still store in the sliding window."""
    now = time.monotonic() if now is None else now
    with _rl_lock:
        q = _rl.setdefault(anon_id, deque())
        while q and now - q[0][0] > RATE_LIMIT_WINDOW_S:
            q.popleft()
        used = sum(c for _, c in q)
        allowed = max(0, min(n, RATE_LIMIT_EVENTS - used))
        if allowed:
            q.append((now, allowed))
        if len(_rl) > 20000:  # bound memory: drop idle entries
            for k in [k for k, v in _rl.items() if not v]:
                _rl.pop(k, None)
        return allowed


def reset_rate_limit() -> None:
    with _rl_lock:
        _rl.clear()


# ---- helpers ------------------------------------------------------------------
def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _norm_ts(ts: str | None, now: datetime) -> str:
    """Client timestamps are trusted only within ±1 day of server time."""
    if ts:
        try:
            t = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            if t.tzinfo is None:
                t = t.replace(tzinfo=timezone.utc)
            t = t.astimezone(timezone.utc)
            if abs((t - now).total_seconds()) <= 86400:
                return t.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
        except (ValueError, TypeError):
            pass
    return now.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _session_key(anon_id: str, day: str) -> str:
    return hashlib.sha256(f"{anon_id}{day}".encode()).hexdigest()[:32]


def _user_of(request: Request):
    try:
        return _auth.current_user(request)
    except Exception:  # noqa: BLE001 — auth problems must not break ingest
        return None


# ---- endpoints ----------------------------------------------------------------
MAX_BODY_BYTES = 256 * 1024


@router.post("/events")
async def post_events(request: Request) -> dict:
    """Body is JSON, whatever the Content-Type: navigator.sendBeacon posts text/plain
    (a CORS-safelisted type) so the dev setup (vite :5190 → bridge :8777) needs no preflight."""
    raw = await request.body()
    if len(raw) > MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail="batch too large")
    try:
        body = EventsIn.model_validate(json.loads(raw or b"{}"))
    except (ValueError, TypeError) as e:  # JSONDecodeError and ValidationError are ValueErrors
        raise HTTPException(status_code=400, detail="bad events batch") from e
    now = datetime.now(timezone.utc)
    rows: list[tuple] = []
    user = _user_of(request)
    uid = user.id if user else None
    for ev in body.events[:MAX_EVENTS_PER_BATCH]:
        if not _EVENT_RE.match(ev.event):
            continue
        props_s = None
        if ev.props:
            try:
                props_s = json.dumps(ev.props, separators=(",", ":"), ensure_ascii=False, default=str)
            except (TypeError, ValueError):
                props_s = None
            if props_s is not None and len(props_s.encode()) > MAX_PROPS_BYTES:
                props_s = None
        ts = _norm_ts(ev.ts, now)
        rows.append((ts, uid, body.anonId, _session_key(body.anonId, ts[:10]), ev.event, props_s))
    allowed = _rate_allow(body.anonId, len(rows)) if rows else 0
    rows = rows[:allowed]
    if not rows:
        return {"ok": True, "stored": 0}
    try:
        with _db.connect() as con:
            con.executemany(
                "INSERT INTO usage_events(ts, user_id, anon_id, session_key, event, props) VALUES (?,?,?,?,?,?)",
                rows,
            )
    except Exception:  # noqa: BLE001 — stats must never error to the client
        log.exception("stats: storing %d events failed", len(rows))
        return {"ok": True, "stored": 0}
    return {"ok": True, "stored": len(rows)}


def _table_columns(con, table: str) -> set[str]:
    try:
        return {r[1] for r in con.execute(f"PRAGMA table_info({table})").fetchall()}
    except Exception:  # noqa: BLE001
        return set()


def _top_prop(con, since: str, event: str, key: str, limit: int = 15) -> list[dict]:
    try:
        rows = con.execute(
            """SELECT json_extract(props, ?) AS v, COUNT(*) AS n FROM usage_events
               WHERE ts >= ? AND event = ? AND props IS NOT NULL AND json_valid(props)
               GROUP BY v HAVING v IS NOT NULL ORDER BY n DESC, v LIMIT ?""",
            (f"$.{key}", since, event, limit),
        ).fetchall()
        return [{key: str(r["v"]), "count": r["n"]} for r in rows]
    except Exception:  # noqa: BLE001 — old SQLite without JSON1
        log.exception("stats: top %s.%s failed", event, key)
        return []


def build_summary(days: int) -> dict:
    now = datetime.now(timezone.utc)
    start_day = (now - timedelta(days=days - 1)).date()
    since = start_day.isoformat()
    out: dict[str, Any] = {"days": days, "since": since, "generatedAt": _now_iso()}
    with _db.connect() as con:
        t = con.execute(
            """SELECT COUNT(*) AS events,
                      COUNT(DISTINCT session_key) AS sessions,
                      COUNT(DISTINCT user_id) AS users,
                      COUNT(DISTINCT CASE WHEN user_id IS NULL THEN anon_id END) AS anonymous
               FROM usage_events WHERE ts >= ?""",
            (since,),
        ).fetchone()
        out["totals"] = {k: t[k] or 0 for k in ("events", "sessions", "users", "anonymous")}

        per = {
            r["day"]: r
            for r in con.execute(
                """SELECT substr(ts,1,10) AS day, COUNT(*) AS events,
                          COUNT(DISTINCT session_key) AS sessions, COUNT(DISTINCT user_id) AS users
                   FROM usage_events WHERE ts >= ? GROUP BY day""",
                (since,),
            ).fetchall()
        }
        series = []
        for i in range(days):
            d = (start_day + timedelta(days=i)).isoformat()
            r = per.get(d)
            series.append({
                "day": d,
                "sessions": r["sessions"] if r else 0,
                "events": r["events"] if r else 0,
                "users": r["users"] if r else 0,
            })
        out["series"] = series

        out["topEvents"] = [
            {"event": r["event"], "count": r["n"]}
            for r in con.execute(
                """SELECT event, COUNT(*) AS n FROM usage_events WHERE ts >= ?
                   GROUP BY event ORDER BY n DESC, event LIMIT 25""",
                (since,),
            ).fetchall()
        ]
        out["files"] = _top_prop(con, since, "file_open", "ext")
        out["examples"] = _top_prop(con, since, "example_open", "name")
        fe = {r["event"]: r["n"] for r in con.execute(
            f"""SELECT event, COUNT(*) AS n FROM usage_events WHERE ts >= ?
                AND event IN ({",".join("?" * len(FEATURE_EVENTS))}) GROUP BY event""",
            (since, *FEATURE_EVENTS),
        ).fetchall()}
        out["features"] = {k: fe.get(k, 0) for k in FEATURE_EVENTS}

        users: list[dict] = []
        try:
            cols = _table_columns(con, "users")
            if {"id", "email"} <= cols:
                name_sql = "u.name" if "name" in cols else "''"
                rows = con.execute(
                    f"""SELECT u.email AS email, {name_sql} AS name, MAX(e.ts) AS last_seen, COUNT(*) AS events
                        FROM usage_events e JOIN users u ON u.id = e.user_id
                        WHERE e.ts >= ? GROUP BY u.id ORDER BY last_seen DESC LIMIT 200""",
                    (since,),
                ).fetchall()
                users = [dict(r) for r in rows]
            # users not (yet) in the users table, e.g. the synthetic local admin
            known = {u["email"] for u in users}
            extra = con.execute(
                f"""SELECT e.user_id AS uid, MAX(e.ts) AS last_seen, COUNT(*) AS events FROM usage_events e
                    WHERE e.ts >= ? AND e.user_id IS NOT NULL
                    {"AND e.user_id NOT IN (SELECT id FROM users)" if {"id"} <= cols else ""}
                    GROUP BY e.user_id ORDER BY last_seen DESC LIMIT 50""",
                (since,),
            ).fetchall()
            for r in extra:
                if r["uid"] not in known:
                    users.append({"email": r["uid"], "name": "", "last_seen": r["last_seen"], "events": r["events"]})
        except Exception:  # noqa: BLE001
            log.exception("stats: users list failed")
        out["users"] = users
    return out


@router.get("/summary")
def summary(request: Request, days: int = Query(30, ge=1, le=365)) -> dict:
    _auth.require_admin(request)
    try:
        return build_summary(days)
    except Exception as e:  # noqa: BLE001
        log.exception("stats: summary failed")
        raise HTTPException(status_code=500, detail="stats unavailable") from e


@router.get("/me")
def me(request: Request) -> dict:
    user = _auth.require_user(request)
    try:
        with _db.connect() as con:
            r = con.execute(
                "SELECT COUNT(*) AS events, COUNT(DISTINCT session_key) AS sessions, MAX(ts) AS last_seen "
                "FROM usage_events WHERE user_id = ?",
                (user.id,),
            ).fetchone()
            return {"events": r["events"] or 0, "sessions": r["sessions"] or 0, "last_seen": r["last_seen"]}
    except Exception:  # noqa: BLE001
        log.exception("stats: me failed")
        return {"events": 0, "sessions": 0, "last_seen": None}
