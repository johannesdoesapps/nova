"""Project workspaces: members, items (chats, documents, research, graphs, tasks,
workflows, decisions, notes, links), versions, comments, collections, sharing."""

from __future__ import annotations

import hashlib
import json
import re
from datetime import UTC, datetime, timedelta
from typing import Any

from ..auth import Identity
from ..db import Database, collections, comments, item_versions, new_id, now_iso, shares, workspace_items, workspace_members, workspaces
from ..errors import EngineError
from ..security.crypto import random_token
from .permissions import ROLES, can, can_assign

ITEM_TYPES = ("note", "document", "research", "chat", "graph", "task", "workflow", "decision", "link", "dataset")
MAX_ITEM_BYTES = 500_000


def _role(db: Database, ident: Identity, wid: str) -> str | None:
    m = db.get(workspace_members, workspace_id=wid, user_id=ident.sub, status="active")
    if m:
        return m["role"]
    # Accept a pending invitation automatically when the invited email signs in.
    if ident.email:
        inv = db.get(workspace_members, workspace_id=wid, email=ident.email.lower(), status="invited")
        if inv:
            db.update(workspace_members, {"id": inv["id"]}, user_id=ident.sub, status="active", name=ident.name)
            db.audit(ident.sub, "invite_accepted", workspace_id=wid, target=ident.email)
            return inv["role"]
    return None


def require(db: Database, ident: Identity, wid: str, action: str) -> tuple[dict[str, Any], str]:
    w = db.get(workspaces, id=wid)
    if not w or w["deleted_at"]:
        raise EngineError("not_found", "Workspace not found.")
    role = _role(db, ident, wid)
    if role is None:
        raise EngineError("not_found", "Workspace not found.")  # don't reveal existence
    if not can(role, action):
        raise EngineError("forbidden", f"Your role ({role}) can't {action.replace('_', ' ')} in this workspace.")
    return w, role


def _json_size(v: Any) -> int:
    return len(json.dumps(v, default=str))


# ─── workspaces ─────────────────────────────────────────────────────────────
def create_workspace(db: Database, ident: Identity, name: str, description: str = "") -> dict[str, Any]:
    name = name.strip()[:200]
    if not name:
        raise EngineError("bad_request", "Name is required.")
    if db.count(workspaces, {"owner_id": ident.sub, "deleted_at": None}) >= 100:
        raise EngineError("rate_limited", "Workspace limit reached (100).")
    now = now_iso()
    w = db.insert(workspaces, id=new_id(), owner_id=ident.sub, name=name, description=description[:2000], visibility="private", created_at=now, updated_at=now, deleted_at=None)
    db.insert(workspace_members, id=new_id(), workspace_id=w["id"], user_id=ident.sub, email=(ident.email or ident.sub).lower(), name=ident.name, role="owner", status="active", invited_by=None, created_at=now)
    db.audit(ident.sub, "workspace_create", workspace_id=w["id"], owner_id=ident.sub)
    return w


def list_workspaces(db: Database, ident: Identity) -> list[dict[str, Any]]:
    mine = {m["workspace_id"]: m["role"] for m in db.select(workspace_members, {"user_id": ident.sub, "status": "active"})}
    if ident.email:
        for inv in db.select(workspace_members, {"email": ident.email.lower(), "status": "invited"}):
            mine.setdefault(inv["workspace_id"], "invited:" + inv["role"])
    out = []
    for w in db.select(workspaces, {"id": list(mine) or ["-"], "deleted_at": None}, order_by="updated_at", desc=True):
        out.append({**w, "role": mine[w["id"]], "item_count": db.count(workspace_items, {"workspace_id": w["id"], "deleted_at": None}), "member_count": db.count(workspace_members, {"workspace_id": w["id"]})})
    return out


def get_workspace(db: Database, ident: Identity, wid: str) -> dict[str, Any]:
    w, role = require(db, ident, wid, "read")
    items = db.select(workspace_items, {"workspace_id": wid, "deleted_at": None}, order_by="updated_at", desc=True, limit=500)
    for it in items:
        it["comment_count"] = db.count(comments, {"item_id": it["id"], "deleted_at": None, "resolved": False})
        it["preview"] = _preview(it["data"])
        it.pop("data")
    return {
        **w,
        "role": role,
        "permissions": {a: can(role, a) for a in ("comment", "edit_items", "manage_members", "create_share_links", "publish_to_community", "export", "change_visibility", "delete_workspace", "manage_connectors")},
        "members": db.select(workspace_members, {"workspace_id": wid}, order_by="created_at"),
        "items": items,
        "collections": db.select(collections, {"workspace_id": wid}, order_by="created_at"),
        "shares": [_share_out(s) for s in db.select(shares, {"workspace_id": wid, "revoked_at": None})] if can(role, "create_share_links") else [],
    }


def _preview(data: dict[str, Any]) -> str:
    body = data.get("body") or data.get("summary") or data.get("decision") or data.get("text") or ""
    return re.sub(r"\s+", " ", str(body))[:200]


def update_workspace(db: Database, ident: Identity, wid: str, patch: dict[str, Any]) -> dict[str, Any]:
    action = "change_visibility" if "visibility" in patch else "manage_members"
    require(db, ident, wid, action)
    values: dict[str, Any] = {"updated_at": now_iso()}
    if "name" in patch:
        values["name"] = str(patch["name"]).strip()[:200] or "Untitled"
    if "description" in patch:
        values["description"] = str(patch["description"])[:2000]
    if "visibility" in patch:
        if patch["visibility"] not in ("private", "link", "public"):
            raise EngineError("bad_request", "visibility must be private, link or public.")
        values["visibility"] = patch["visibility"]
    db.update(workspaces, {"id": wid}, **values)
    db.audit(ident.sub, "workspace_update", workspace_id=wid, data=list(values))
    return db.get(workspaces, id=wid)  # type: ignore[return-value]


def delete_workspace(db: Database, ident: Identity, wid: str) -> None:
    require(db, ident, wid, "delete_workspace")
    now = now_iso()
    db.update(workspaces, {"id": wid}, deleted_at=now)
    db.update(shares, {"workspace_id": wid, "revoked_at": None}, revoked_at=now)
    db.audit(ident.sub, "workspace_delete", workspace_id=wid)


# ─── members ────────────────────────────────────────────────────────────────
def invite(db: Database, ident: Identity, wid: str, email: str, role: str) -> dict[str, Any]:
    _, actor = require(db, ident, wid, "manage_members")
    email = email.strip().lower()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        raise EngineError("bad_request", "Enter a valid email address.")
    if role not in ROLES or not can_assign(actor, role):
        raise EngineError("forbidden", f"You can't assign the {role} role.")
    if db.get(workspace_members, workspace_id=wid, email=email):
        raise EngineError("conflict", "That person is already a member or invited.")
    if db.count(workspace_members, {"workspace_id": wid}) >= 50:
        raise EngineError("rate_limited", "Member limit reached (50).")
    m = db.insert(workspace_members, id=new_id(), workspace_id=wid, user_id=None, email=email, name=None, role=role, status="invited", invited_by=ident.sub, created_at=now_iso())
    db.audit(ident.sub, "member_invite", workspace_id=wid, target=email, data={"role": role})
    return m


def change_role(db: Database, ident: Identity, wid: str, member_id: str, role: str) -> dict[str, Any]:
    _, actor = require(db, ident, wid, "manage_members")
    m = db.get(workspace_members, id=member_id, workspace_id=wid)
    if not m:
        raise EngineError("not_found", "Member not found.")
    if m["role"] == "owner":
        raise EngineError("forbidden", "Transfer ownership instead of changing the owner's role.")
    if not can_assign(actor, role) or (actor != "owner" and m["role"] == "admin"):
        raise EngineError("forbidden", "You can't make that change.")
    db.update(workspace_members, {"id": member_id}, role=role)
    db.audit(ident.sub, "member_role", workspace_id=wid, target=m["email"], data={"from": m["role"], "to": role})
    return {**m, "role": role}


def remove_member(db: Database, ident: Identity, wid: str, member_id: str) -> None:
    m = db.get(workspace_members, id=member_id, workspace_id=wid)
    if not m:
        raise EngineError("not_found", "Member not found.")
    if m["user_id"] != ident.sub:  # anyone may leave; removing others needs manage_members
        _, actor = require(db, ident, wid, "manage_members")
        if m["role"] in ("owner",) or (m["role"] == "admin" and actor != "owner"):
            raise EngineError("forbidden", "You can't remove this member.")
    elif m["role"] == "owner":
        raise EngineError("forbidden", "Transfer ownership before leaving.")
    db.delete(workspace_members, id=member_id)
    db.audit(ident.sub, "member_remove", workspace_id=wid, target=m["email"])


def transfer_ownership(db: Database, ident: Identity, wid: str, member_id: str) -> None:
    require(db, ident, wid, "transfer_ownership")
    m = db.get(workspace_members, id=member_id, workspace_id=wid, status="active")
    if not m or m["user_id"] == ident.sub:
        raise EngineError("bad_request", "Choose another active member.")
    db.update(workspace_members, {"workspace_id": wid, "user_id": ident.sub}, role="admin")
    db.update(workspace_members, {"id": member_id}, role="owner")
    db.update(workspaces, {"id": wid}, owner_id=m["user_id"], updated_at=now_iso())
    db.audit(ident.sub, "ownership_transfer", workspace_id=wid, target=m["email"])


# ─── items & versions ───────────────────────────────────────────────────────
def _clean_item(payload: dict[str, Any]) -> tuple[str, str, dict[str, Any]]:
    t = payload.get("type", "note")
    if t not in ITEM_TYPES:
        raise EngineError("bad_request", f"type must be one of {', '.join(ITEM_TYPES)}.")
    title = str(payload.get("title", "")).strip()[:300] or "Untitled"
    data = payload.get("data") or {}
    if not isinstance(data, dict):
        raise EngineError("bad_request", "data must be an object.")
    if _json_size(data) > MAX_ITEM_BYTES:
        raise EngineError("payload_too_large", "Item is too large (500 KB max).")
    if t == "task":
        data.setdefault("status", "todo")
        if data["status"] not in ("todo", "doing", "done", "blocked"):
            raise EngineError("bad_request", "Task status must be todo, doing, done or blocked.")
    if t == "decision":
        data.setdefault("status", "proposed")
        if data["status"] not in ("proposed", "accepted", "rejected", "superseded"):
            raise EngineError("bad_request", "Decision status must be proposed, accepted, rejected or superseded.")
    if t == "link" and data.get("url") and not str(data["url"]).startswith(("https://", "http://")):
        raise EngineError("bad_request", "Links must be http(s).")
    return t, title, data


def create_item(db: Database, ident: Identity, wid: str, payload: dict[str, Any], source: dict[str, Any] | None = None, remote_version: str | None = None) -> dict[str, Any]:
    require(db, ident, wid, "edit_items")
    t, title, data = _clean_item(payload)
    if db.count(workspace_items, {"workspace_id": wid, "deleted_at": None}) >= 5000:
        raise EngineError("rate_limited", "Item limit reached (5000).")
    now = now_iso()
    item = db.insert(workspace_items, id=new_id(), workspace_id=wid, type=t, title=title, data=data, current_version=1, source=source, remote_version=remote_version, created_by=ident.sub, updated_by=ident.sub, created_at=now, updated_at=now, deleted_at=None)
    db.insert(item_versions, item_id=item["id"], version=1, title=title, data=data, author=ident.sub, change_note="Created", created_at=now)
    db.update(workspaces, {"id": wid}, updated_at=now)
    return item


def get_item(db: Database, ident: Identity, wid: str, item_id: str) -> dict[str, Any]:
    _, role = require(db, ident, wid, "read")
    it = db.get(workspace_items, id=item_id, workspace_id=wid)
    if not it or it["deleted_at"]:
        raise EngineError("not_found", "Item not found.")
    it["versions"] = [{k: v[k] for k in ("version", "title", "author", "change_note", "created_at")} for v in db.select(item_versions, {"item_id": item_id}, order_by="version", desc=True)]
    it["comments"] = db.select(comments, {"item_id": item_id, "deleted_at": None}, order_by="created_at")
    it["role"] = role
    return it


def update_item(db: Database, ident: Identity, wid: str, item_id: str, payload: dict[str, Any], expected_version: int | None = None, note: str | None = None) -> dict[str, Any]:
    require(db, ident, wid, "edit_items")
    it = db.get(workspace_items, id=item_id, workspace_id=wid)
    if not it or it["deleted_at"]:
        raise EngineError("not_found", "Item not found.")
    if expected_version is not None and expected_version != it["current_version"]:
        # Optimistic concurrency: two editors can't silently overwrite each other.
        raise EngineError("conflict", f"This item changed (now version {it['current_version']}). Reload and re-apply your edit.", {"current_version": it["current_version"]})
    t, title, data = _clean_item({"type": it["type"], "title": payload.get("title", it["title"]), "data": payload.get("data", it["data"])})
    ver = it["current_version"] + 1
    now = now_iso()
    db.insert(item_versions, item_id=item_id, version=ver, title=title, data=data, author=ident.sub, change_note=(note or "")[:500] or None, created_at=now)
    db.update(workspace_items, {"id": item_id}, title=title, data=data, current_version=ver, updated_by=ident.sub, updated_at=now)
    db.update(workspaces, {"id": wid}, updated_at=now)
    return get_item(db, ident, wid, item_id)


def get_version(db: Database, ident: Identity, wid: str, item_id: str, version: int) -> dict[str, Any]:
    get_item(db, ident, wid, item_id)
    v = db.get(item_versions, item_id=item_id, version=version)
    if not v:
        raise EngineError("not_found", "Version not found.")
    return v


def restore_version(db: Database, ident: Identity, wid: str, item_id: str, version: int) -> dict[str, Any]:
    v = get_version(db, ident, wid, item_id, version)
    return update_item(db, ident, wid, item_id, {"title": v["title"], "data": v["data"]}, note=f"Restored version {version}")


def delete_item(db: Database, ident: Identity, wid: str, item_id: str) -> None:
    require(db, ident, wid, "delete_items")
    it = db.get(workspace_items, id=item_id, workspace_id=wid)
    if not it or it["deleted_at"]:
        raise EngineError("not_found", "Item not found.")
    db.update(workspace_items, {"id": item_id}, deleted_at=now_iso())
    db.audit(ident.sub, "item_delete", workspace_id=wid, target=item_id)


def search_items(db: Database, ident: Identity, wid: str, query: str, k: int = 5) -> list[dict[str, Any]]:
    """Lexical search (pgvector semantic search is the planned upgrade; see docs/ARCHITECTURE.md)."""
    require(db, ident, wid, "read")
    terms = [t for t in re.findall(r"\w+", query.lower()) if len(t) > 2]
    scored = []
    for it in db.select(workspace_items, {"workspace_id": wid, "deleted_at": None}, limit=5000):
        text = (it["title"] + " " + json.dumps(it["data"], ensure_ascii=False)).lower()
        score = sum(text.count(t) for t in terms) + 3 * sum(t in it["title"].lower() for t in terms)
        if score:
            scored.append((score, it))
    scored.sort(key=lambda x: -x[0])
    return [{"id": it["id"], "type": it["type"], "title": it["title"], "excerpt": _preview(it["data"]), "score": s} for s, it in scored[:k]]


# ─── comments ───────────────────────────────────────────────────────────────
def add_comment(db: Database, ident: Identity, wid: str, item_id: str, body: str, parent_id: str | None = None, anchor: str | None = None) -> dict[str, Any]:
    require(db, ident, wid, "comment")
    if not db.get(workspace_items, id=item_id, workspace_id=wid):
        raise EngineError("not_found", "Item not found.")
    body = body.strip()
    if not body or len(body) > 10_000:
        raise EngineError("bad_request", "Comment must be 1–10,000 characters.")
    if parent_id and not db.get(comments, id=parent_id, item_id=item_id):
        raise EngineError("not_found", "Parent comment not found.")
    now = now_iso()
    return db.insert(comments, id=new_id(), workspace_id=wid, item_id=item_id, parent_id=parent_id, author=ident.sub, author_name=ident.display, body=body, anchor=(anchor or None) and anchor[:500], resolved=False, created_at=now, updated_at=now, deleted_at=None)


def resolve_comment(db: Database, ident: Identity, wid: str, comment_id: str, resolved: bool = True) -> None:
    _, role = require(db, ident, wid, "comment")
    c = db.get(comments, id=comment_id, workspace_id=wid)
    if not c:
        raise EngineError("not_found", "Comment not found.")
    if c["author"] != ident.sub and not can(role, "edit_items"):
        raise EngineError("forbidden", "Only the author or an editor can resolve this.")
    db.update(comments, {"id": comment_id}, resolved=resolved, updated_at=now_iso())


def delete_comment(db: Database, ident: Identity, wid: str, comment_id: str) -> None:
    _, role = require(db, ident, wid, "read")
    c = db.get(comments, id=comment_id, workspace_id=wid)
    if not c:
        raise EngineError("not_found", "Comment not found.")
    if c["author"] != ident.sub and not can(role, "manage_members"):
        raise EngineError("forbidden", "Only the author or an admin can delete this.")
    db.update(comments, {"id": comment_id}, deleted_at=now_iso(), body="[deleted]")


# ─── collections ────────────────────────────────────────────────────────────
def upsert_collection(db: Database, ident: Identity, wid: str, name: str, item_ids: list[str], description: str = "", cid: str | None = None) -> dict[str, Any]:
    require(db, ident, wid, "manage_collections")
    valid = {i["id"] for i in db.select(workspace_items, {"workspace_id": wid, "id": item_ids or ["-"], "deleted_at": None})}
    ids = [i for i in item_ids if i in valid][:1000]
    now = now_iso()
    if cid:
        if not db.get(collections, id=cid, workspace_id=wid):
            raise EngineError("not_found", "Collection not found.")
        db.update(collections, {"id": cid}, name=name[:200], description=description[:2000], item_ids=ids, updated_at=now)
        return db.get(collections, id=cid)  # type: ignore[return-value]
    return db.insert(collections, id=new_id(), workspace_id=wid, name=name[:200] or "Collection", description=description[:2000], item_ids=ids, created_by=ident.sub, created_at=now, updated_at=now)


def delete_collection(db: Database, ident: Identity, wid: str, cid: str) -> None:
    require(db, ident, wid, "manage_collections")
    db.delete(collections, id=cid, workspace_id=wid)


# ─── sharing ────────────────────────────────────────────────────────────────
def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _share_out(s: dict[str, Any]) -> dict[str, Any]:
    return {k: s[k] for k in ("id", "item_id", "role", "created_by", "created_at", "expires_at")}


def create_share(db: Database, ident: Identity, wid: str, role: str = "viewer", item_id: str | None = None, expires_days: int | None = 30) -> dict[str, Any]:
    w, _ = require(db, ident, wid, "create_share_links")
    if role not in ("viewer", "commenter"):
        raise EngineError("bad_request", "Share links can grant viewer or commenter access only.")
    if item_id and not db.get(workspace_items, id=item_id, workspace_id=wid):
        raise EngineError("not_found", "Item not found.")
    token = random_token(24)
    expires = (datetime.now(UTC) + timedelta(days=expires_days)).isoformat().replace("+00:00", "Z") if expires_days else None
    s = db.insert(shares, id=new_id(), workspace_id=wid, item_id=item_id, token_hash=_hash_token(token), role=role, created_by=ident.sub, created_at=now_iso(), expires_at=expires, revoked_at=None)
    if w["visibility"] == "private":
        db.update(workspaces, {"id": wid}, visibility="link")
    db.audit(ident.sub, "share_create", workspace_id=wid, target=item_id or wid, data={"role": role, "expires_at": expires})
    # The raw token is shown once; only its hash is stored.
    return {**_share_out(s), "token": token}


def revoke_share(db: Database, ident: Identity, wid: str, share_id: str) -> None:
    require(db, ident, wid, "create_share_links")
    if not db.update(shares, {"id": share_id, "workspace_id": wid}, revoked_at=now_iso()):
        raise EngineError("not_found", "Share link not found.")
    db.audit(ident.sub, "share_revoke", workspace_id=wid, target=share_id)


def open_share(db: Database, token: str) -> dict[str, Any]:
    s = db.get(shares, token_hash=_hash_token(token))
    if not s or s["revoked_at"] or (s["expires_at"] and s["expires_at"] < now_iso()):
        raise EngineError("not_found", "This link is invalid, expired or revoked.")
    w = db.get(workspaces, id=s["workspace_id"])
    if not w or w["deleted_at"]:
        raise EngineError("not_found", "This link is invalid, expired or revoked.")
    where: dict[str, Any] = {"workspace_id": w["id"], "deleted_at": None}
    if s["item_id"]:
        where["id"] = s["item_id"]
    items = db.select(workspace_items, where, order_by="updated_at", desc=True, limit=200)
    return {
        "workspace": {"name": w["name"], "description": w["description"]},
        "role": s["role"],
        "read_only": True,
        "items": [{"id": i["id"], "type": i["type"], "title": i["title"], "data": i["data"], "updated_at": i["updated_at"]} for i in items],
    }
