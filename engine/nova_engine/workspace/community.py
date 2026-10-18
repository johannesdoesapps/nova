"""Community: publish reusable templates and collections, discover, fork, report.

Publishing is always an explicit act. Content is copied into an immutable
post (later edits to the source don't leak), scanned for sensitive data and
secrets (publishing is blocked when found unless the user confirms after
editing), and moderated by reports: three reports hide a post pending review.
"""

from __future__ import annotations

import json
import re
from typing import Any

from ..auth import Identity
from ..db import Database, community_posts, community_reports, new_id, now_iso, radar_watches, workflows, workspace_items
from ..errors import EngineError
from ..lab.templates import list_templates
from ..lab.validate import parse_spec
from ..security.content import detect_sensitive, scan_injection
from .service import create_item, require

KINDS = ("workflow_template", "watch_template", "collection")
LICENSES = ("CC-BY-4.0", "CC0-1.0", "MIT", "All rights reserved")
HIDE_AFTER_REPORTS = 3


def _sanitize_workflow(spec: dict[str, Any]) -> dict[str, Any]:
    spec = parse_spec(spec).model_dump()
    for i in spec["inputs"]:
        if i.get("sensitive") or (isinstance(i.get("default"), str) and detect_sensitive(i["default"])):
            i["default"] = None  # never publish someone's recipient, key or phone number
    return spec


def publish(db: Database, ident: Identity, kind: str, source_id: str, title: str, description: str, license: str = "CC-BY-4.0", workspace_id: str | None = None, acknowledge_sensitive: bool = False) -> dict[str, Any]:
    if ident.is_guest:
        raise EngineError("forbidden", "Sign in to publish to the community.")
    if kind not in KINDS or license not in LICENSES:
        raise EngineError("bad_request", "Unsupported kind or license.")
    if kind == "workflow_template":
        w = db.get(workflows, id=source_id)
        if not w or w["owner_id"] != ident.sub:
            raise EngineError("not_found", "Workflow not found.")
        content: Any = {"spec": _sanitize_workflow(w["draft"])}
    elif kind == "watch_template":
        wt = db.get(radar_watches, id=source_id)
        if not wt or wt["owner_id"] != ident.sub:
            raise EngineError("not_found", "Watch not found.")
        d = wt["data"]
        content = {"watch": {k: d.get(k) for k in ("name", "kind", "query", "keywords", "exclude_keywords", "sources", "frequency", "sensitivity")}}
    else:
        if not workspace_id:
            raise EngineError("bad_request", "workspace_id is required to publish a collection.")
        require(db, ident, workspace_id, "publish_to_community")
        from ..db import collections

        c = db.get(collections, id=source_id, workspace_id=workspace_id)
        if not c:
            raise EngineError("not_found", "Collection not found.")
        items = db.select(workspace_items, {"id": c["item_ids"] or ["-"], "deleted_at": None})
        content = {"collection": {"name": c["name"], "description": c["description"], "items": [{"type": i["type"], "title": i["title"], "data": i["data"]} for i in items]}}
    text = json.dumps(content, ensure_ascii=False)
    if len(text) > 1_000_000:
        raise EngineError("payload_too_large", "Too large to publish (1 MB max).")
    found = detect_sensitive(text)
    if found and not acknowledge_sensitive:
        raise EngineError("conflict", f"This content appears to contain {', '.join(found)}. Remove it, or confirm you intend to publish it.", {"sensitive": found})
    title = title.strip()[:200]
    if len(title) < 3:
        raise EngineError("bad_request", "Give it a title.")
    post = db.insert(community_posts, id=new_id(), kind=kind, title=title, description=description.strip()[:4000], author_id=ident.sub, author_name=ident.display, license=license, content=content, status="published", forks=0, reports=0, created_at=now_iso())
    db.audit(ident.sub, "community_publish", owner_id=ident.sub, target=post["id"], data={"kind": kind, "sensitive_acknowledged": found})
    return {k: v for k, v in post.items() if k != "content"}


def _examples() -> list[dict[str, Any]]:
    return [
        {"id": f"example:{t['id']}", "kind": "workflow_template", "title": t["name"], "description": t["description"], "author_id": "nova", "author_name": "NOVA AI (built-in example)", "license": "CC0-1.0", "status": "published", "forks": 0, "reports": 0, "created_at": "2026-10-18T00:00:00.000Z", "example": True}
        for t in list_templates()
    ]


def list_posts(db: Database, kind: str | None = None, q: str | None = None, limit: int = 60) -> list[dict[str, Any]]:
    where: dict[str, Any] = {"status": "published"}
    if kind:
        where["kind"] = kind
    rows = [{k: v for k, v in r.items() if k != "content"} for r in db.select(community_posts, where, order_by="created_at", desc=True, limit=500)]
    rows += [e for e in _examples() if not kind or e["kind"] == kind]
    if q:
        terms = [t for t in re.findall(r"\w+", q.lower()) if len(t) > 1]
        rows = [r for r in rows if all(t in (r["title"] + " " + r["description"]).lower() for t in terms)]
    return rows[:limit]


def get_post(db: Database, post_id: str) -> dict[str, Any]:
    if post_id.startswith("example:"):
        tid = post_id.split(":", 1)[1]
        t = next((x for x in list_templates() if x["id"] == tid), None)
        if not t:
            raise EngineError("not_found", "Post not found.")
        return {**next(e for e in _examples() if e["id"] == post_id), "content": {"spec": t["spec"]}}
    p = db.get(community_posts, id=post_id)
    if not p or p["status"] != "published":
        raise EngineError("not_found", "Post not found.")
    p["injection_warnings"] = scan_injection(json.dumps(p["content"], ensure_ascii=False))
    return p


def fork(db: Database, ident: Identity, post_id: str, workspace_id: str | None = None) -> dict[str, Any]:
    p = get_post(db, post_id)
    c = p["content"]
    if p["kind"] == "workflow_template":
        from ..lab.service import create_workflow

        spec = c["spec"]
        spec["name"] = f"{spec['name']} (from community)"[:200]
        w = create_workflow(db, ident, spec)
        result = {"workflow_id": w["id"]}
    elif p["kind"] == "watch_template":
        from ..radar.service import create_watch

        w = create_watch(db, ident, c["watch"])
        result = {"watch_id": w["id"]}
    else:
        if not workspace_id:
            raise EngineError("bad_request", "Choose a workspace to copy the collection into.")
        ids = []
        for it in c["collection"]["items"][:500]:
            created = create_item(db, ident, workspace_id, it, source={"community_post": post_id, "untrusted": True})
            ids.append(created["id"])
        result = {"workspace_id": workspace_id, "items": len(ids)}
    if not post_id.startswith("example:"):
        db.update(community_posts, {"id": post_id}, forks=p["forks"] + 1)
    db.audit(ident.sub, "community_fork", owner_id=ident.sub, target=post_id)
    return result


def report(db: Database, ident: Identity, post_id: str, reason: str) -> dict[str, Any]:
    if post_id.startswith("example:"):
        raise EngineError("bad_request", "Built-in examples can't be reported; send feedback instead.")
    p = db.get(community_posts, id=post_id)
    if not p:
        raise EngineError("not_found", "Post not found.")
    if db.get(community_reports, post_id=post_id, reporter=ident.sub):
        raise EngineError("conflict", "You already reported this.")
    db.insert(community_reports, id=new_id(), post_id=post_id, reporter=ident.sub, reason=reason.strip()[:1000] or "unspecified", created_at=now_iso())
    n = p["reports"] + 1
    status = "hidden" if n >= HIDE_AFTER_REPORTS else p["status"]
    db.update(community_posts, {"id": post_id}, reports=n, status=status)
    return {"reports": n, "status": status}


def unpublish(db: Database, ident: Identity, post_id: str) -> None:
    p = db.get(community_posts, id=post_id)
    if not p or p["author_id"] != ident.sub:
        raise EngineError("not_found", "Post not found.")
    db.update(community_posts, {"id": post_id}, status="removed")
    db.audit(ident.sub, "community_unpublish", owner_id=ident.sub, target=post_id)


