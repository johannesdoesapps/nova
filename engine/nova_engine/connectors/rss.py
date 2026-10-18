"""RSS/Atom connector: mirror feed entries into a workspace as links."""

from __future__ import annotations

from typing import Any

from ..auth import Identity
from ..db import Database
from ..radar.sources import fetch_feed
from .service import upsert_synced


def sync_feed(db: Database, ident: Identity, conn: dict[str, Any], counts: dict[str, int]) -> dict[str, Any]:
    entries = fetch_feed(db, conn["config"]["url"], limit=50)
    for e in entries:
        item = {"type": "link", "title": e["title"][:300], "data": {"url": e["url"], "summary": e.get("summary", "")[:5000], "published_at": e.get("published_at")}}
        upsert_synced(db, ident, conn, e["canonical_url"], e.get("published_at") or e["content_hash"], item, counts)
    return {"errors": []}
