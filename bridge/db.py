"""SQLite store for the bridge: users, sessions, OTP codes, usage events.

One file under DATA_DIR (``dda_lab.db``); WAL mode; migrations are idempotent
``CREATE TABLE IF NOT EXISTS`` statements applied on first use. Agents add their
own tables here (keep statements idempotent, never DROP).
"""
from __future__ import annotations

import os
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

_lock = threading.Lock()
_db_path: Path | None = None

MIGRATIONS: list[str] = [
    """CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        avatar_url TEXT,
        provider TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        last_login_at TEXT
    )""",
    """CREATE TABLE IF NOT EXISTS otp_codes (
        email TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0
    )""",
    """CREATE TABLE IF NOT EXISTS usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        user_id TEXT,
        anon_id TEXT,
        session_key TEXT,
        event TEXT NOT NULL,
        props TEXT
    )""",
    "CREATE INDEX IF NOT EXISTS otp_codes_email ON otp_codes(email)",
    """CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        expires_at TEXT NOT NULL
    )""",
    "CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)",
    "CREATE INDEX IF NOT EXISTS usage_events_ts ON usage_events(ts)",
    "CREATE INDEX IF NOT EXISTS usage_events_event ON usage_events(event)",
]


def configure(path: Path) -> None:
    """Point the store at a file (called once by the bridge at import time; tests override)."""
    global _db_path
    _db_path = path


def db_path() -> Path:
    if _db_path is None:
        return Path(os.environ.get("DDA_LAB_DB", "dda_lab.db"))
    return _db_path


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    """A connection with row access by name; migrations applied; commits on success."""
    p = db_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(p), timeout=10, check_same_thread=False)
    con.row_factory = sqlite3.Row
    try:
        with _lock:
            con.execute("PRAGMA journal_mode=WAL")
            for stmt in MIGRATIONS:
                con.execute(stmt)
        yield con
        con.commit()
    finally:
        con.close()
