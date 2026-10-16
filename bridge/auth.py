"""Authentication for the hosted DDA Lab (Google sign-in + e-mail code), mirroring the
Kitchen on Stage flow: OAuth code flow with a state cookie → signed, httpOnly ``session``
cookie → ``/api/auth/me``.

AGENT A implements this module. Contract that other modules rely on (keep it):

    router: APIRouter                       # mounted by dda_lab_bridge.py (prefix /api/auth)
    class User(BaseModel): id, email, name, avatar_url | None, role ('user' | 'admin')
    def auth_enabled() -> bool              # False when GOOGLE_CLIENT_ID is unset (local / desktop use)
    def current_user(request) -> User | None   # from the session cookie; a synthetic local user when auth is disabled
    def require_user(request) -> User       # FastAPI dependency: 401 when not signed in
    def require_admin(request) -> User      # 403 unless role == 'admin' (ADMIN_EMAILS env, comma separated)
    def install(app) -> None                # middleware: when auth is enabled, unauthenticated /lab/ → 302 /login

Env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_SECRET (≥32 chars), APP_URL
(https://motoracelaps.com), ADMIN_EMAILS, RESEND_API_KEY + MAIL_FROM for e-mail codes.
"""
from __future__ import annotations

import os

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

router = APIRouter(prefix="/api/auth", tags=["auth"])


class User(BaseModel):
    id: str
    email: str
    name: str = ""
    avatar_url: str | None = None
    role: str = "user"


def auth_enabled() -> bool:
    return bool(os.environ.get("GOOGLE_CLIENT_ID"))


LOCAL_USER = User(id="local", email="local@dda-lab", name="Local user", role="admin")


def current_user(request: Request) -> User | None:
    # TODO(agent A): decode the signed session cookie
    if not auth_enabled():
        return LOCAL_USER
    return None


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


@router.get("/me")
def me(request: Request) -> dict:
    u = current_user(request)
    return {"user": u.model_dump() if u else None, "authEnabled": auth_enabled()}


def install(app) -> None:
    """TODO(agent A): gate /lab/ behind the session when auth is enabled."""
    return None
