"""Safe import/export. A workspace can always be taken out in a documented,
self-describing JSON bundle, and bundles are validated before anything is
written. Secrets (OAuth tokens, share tokens) are never exported."""

from __future__ import annotations

import hashlib
import json
from typing import Any

from ..auth import Identity
from ..db import Database, collections, comments, item_versions, now_iso, workspace_items, workspace_members
from ..errors import EngineError
from ..security.content import scan_injection
from .service import ITEM_TYPES, MAX_ITEM_BYTES, create_item, create_workspace, require, upsert_collection

FORMAT = "orbis-workspace"
FORMAT_VERSION = 1
MAX_BUNDLE_BYTES = 10_000_000
MAX_ITEMS = 5000


def _digest(items: list[dict[str, Any]]) -> str:
    return hashlib.sha256(json.dumps(items, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def export_workspace(db: Database, ident: Identity, wid: str, *, include_history: bool = False, include_comments: bool = True, include_members: bool = False) -> dict[str, Any]:
    w, role = require(db, ident, wid, "export")
    if include_members:
        require(db, ident, wid, "manage_members")
    items = []
    for it in db.select(workspace_items, {"workspace_id": wid, "deleted_at": None}, order_by="created_at"):
        entry: dict[str, Any] = {"id": it["id"], "type": it["type"], "title": it["title"], "data": it["data"], "created_at": it["created_at"], "updated_at": it["updated_at"], "version": it["current_version"], "source": it["source"]}
        if include_history:
            entry["history"] = [{"version": v["version"], "title": v["title"], "data": v["data"], "created_at": v["created_at"], "change_note": v["change_note"]} for v in db.select(item_versions, {"item_id": it["id"]}, order_by="version")]
        if include_comments:
            entry["comments"] = [{"author_name": c["author_name"], "body": c["body"], "resolved": c["resolved"], "created_at": c["created_at"]} for c in db.select(comments, {"item_id": it["id"], "deleted_at": None}, order_by="created_at")]
        items.append(entry)
    bundle = {
        "format": FORMAT,
        "format_version": FORMAT_VERSION,
        "exported_at": now_iso(),
        "exported_by_role": role,
        "workspace": {"name": w["name"], "description": w["description"]},
        "items": items,
        "collections": [{"name": c["name"], "description": c["description"], "item_ids": c["item_ids"]} for c in db.select(collections, {"workspace_id": wid})],
        "members": [{"email": m["email"], "role": m["role"]} for m in db.select(workspace_members, {"workspace_id": wid})] if include_members else [],
        "manifest": {"item_count": len(items), "items_sha256": _digest(items), "excludes": ["oauth tokens", "share-link tokens", "connector credentials"] + ([] if include_members else ["member emails"])},
    }
    db.audit(ident.sub, "workspace_export", workspace_id=wid, data={"items": len(items), "history": include_history, "members": include_members})
    return bundle


def import_bundle(db: Database, ident: Identity, bundle: Any, *, dry_run: bool = True, workspace_id: str | None = None) -> dict[str, Any]:
    if not isinstance(bundle, dict):
        raise EngineError("bad_request", "Not an ORBIS workspace bundle.")
    if len(json.dumps(bundle, default=str)) > MAX_BUNDLE_BYTES:
        raise EngineError("payload_too_large", "Bundle is larger than 10 MB.")
    if bundle.get("format") != FORMAT or bundle.get("format_version") != FORMAT_VERSION:
        raise EngineError("bad_request", f"Unsupported bundle format (expected {FORMAT} v{FORMAT_VERSION}).")
    items = bundle.get("items")
    if not isinstance(items, list) or len(items) > MAX_ITEMS:
        raise EngineError("bad_request", f"Bundle must contain a list of at most {MAX_ITEMS} items.")
    warnings: list[str] = []
    stripped = [{k: i.get(k) for k in ("id", "type", "title", "data", "created_at", "updated_at", "version", "source")} | ({"history": i["history"]} if "history" in i else {}) | ({"comments": i["comments"]} if "comments" in i else {}) for i in items if isinstance(i, dict)]
    manifest = bundle.get("manifest") or {}
    if manifest.get("items_sha256") and manifest["items_sha256"] != _digest(items):
        warnings.append("Checksum mismatch: the bundle was modified after export. Review it before importing.")
    accepted, dropped = [], 0
    flagged = 0
    for i in stripped:
        if i.get("type") not in ITEM_TYPES or not isinstance(i.get("data"), dict) or len(json.dumps(i["data"])) > MAX_ITEM_BYTES:
            dropped += 1
            continue
        if scan_injection(json.dumps(i["data"], ensure_ascii=False)):
            flagged += 1
        accepted.append(i)
    if dropped:
        warnings.append(f"{dropped} item(s) have an unknown type or are too large and will be skipped.")
    if flagged:
        warnings.append(f"{flagged} item(s) contain instruction-like text. They are imported as untrusted data and can't steer workflows.")
    if bundle.get("members"):
        warnings.append("Member lists are never imported automatically; invite people yourself.")
    report = {"dry_run": dry_run, "workspace_name": str((bundle.get("workspace") or {}).get("name", "Imported workspace"))[:200], "items": len(accepted), "skipped": dropped, "collections": len(bundle.get("collections") or []), "warnings": warnings}
    if dry_run:
        return report
    if workspace_id:
        require(db, ident, workspace_id, "edit_items")
        wid = workspace_id
    else:
        wid = create_workspace(db, ident, report["workspace_name"], str((bundle.get("workspace") or {}).get("description", ""))[:2000])["id"]
    id_map: dict[str, str] = {}
    for i in accepted:
        created = create_item(db, ident, wid, {"type": i["type"], "title": str(i.get("title") or "Untitled"), "data": i["data"]}, source={"imported": True, "untrusted": True, "original_id": str(i.get("id"))[:64]})
        id_map[str(i.get("id"))] = created["id"]
    for c in (bundle.get("collections") or [])[:200]:
        if isinstance(c, dict):
            upsert_collection(db, ident, wid, str(c.get("name", "Collection")), [id_map[x] for x in c.get("item_ids", []) if x in id_map], str(c.get("description") or ""))
    db.audit(ident.sub, "workspace_import", workspace_id=wid, data={"items": len(accepted)})
    return {**report, "dry_run": False, "workspace_id": wid}
