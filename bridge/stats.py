"""Usage statistics: the app posts small event batches; admins read summaries.

AGENT B implements this module. Contract:

    router: APIRouter                        # mounted by dda_lab_bridge.py (prefix /api/stats)
    POST /api/stats/events   {events: [{event, ts?, props?}], anonId}   -> {"ok": true}   (any visitor; rate-limited, size-capped)
    GET  /api/stats/summary?days=30                                      -> admin only (bridge.auth.require_admin)
    GET  /api/stats/me                                                    -> the signed-in user's own counts (optional)

Storage: bridge.db ``usage_events`` table (already created by bridge/db.py MIGRATIONS).
"""
from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(prefix="/api/stats", tags=["stats"])
