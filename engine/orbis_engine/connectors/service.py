"""Connections: OAuth (PKCE), encrypted tokens, consent records, sync status,
conflicts, revocation and data deletion."""

from __future__ import annotations

import base64
import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlencode

import httpx

from ..auth import Identity
from ..config import settings
from ..db import Database, consent_log, connections, item_versions, new_id, now_iso, oauth_states, sync_conflicts, workspace_items
from ..errors import EngineError
from ..security.crypto import decrypt_json, encrypt_json
from .registry import BY_ID, status_of

IDLE_SYNC = {"status": "never", "last_sync_at": None, "last_success_at": None, "counts": {}, "error": None, "cursor": None}


def _redirect_uri() -> str:
    return f"{settings().public_base_url}/api/engine/connectors/oauth/callback"


def _public(c: dict[str, Any]) -> dict[str, Any]:
    out = {k: v for k, v in c.items() if k not in ("token_ciphertext", "token_key_id")}
    out["has_token"] = bool(c.get("token_ciphertext"))
    out["connector"] = BY_ID[c["connector_id"]].name if c["connector_id"] in BY_ID else c["connector_id"]
    return out


def list_connections(db: Database, ident: Identity) -> list[dict[str, Any]]:
    return [_public(c) for c in db.select(connections, {"owner_id": ident.sub}, order_by="created_at", desc=True)]


def get_connection(db: Database, ident: Identity, cid: str) -> dict[str, Any]:
    c = db.get(connections, id=cid)
    if not c or c["owner_id"] != ident.sub:
        raise EngineError("not_found", "Connection not found.")
    return c


def consents(db: Database, ident: Identity) -> list[dict[str, Any]]:
    return db.select(consent_log, {"owner_id": ident.sub}, order_by="created_at", desc=True, limit=200)


def _record_consent(db: Database, ident: Identity, connector_id: str, connection_id: str | None, action: str, scopes: list[str], purpose: str) -> None:
    db.insert(consent_log, id=new_id(), owner_id=ident.sub, connector_id=connector_id, connection_id=connection_id, action=action, scopes=scopes, purpose=purpose[:500], created_at=now_iso())


def connect_no_auth(db: Database, ident: Identity, connector_id: str, config: dict[str, Any], workspace_id: str | None) -> dict[str, Any]:
    spec = BY_ID.get(connector_id)
    if not spec or status_of(spec) not in ("available", "available_limited"):
        raise EngineError("bad_request", "This connector is not available.")
    if workspace_id:
        from ..workspace.service import require

        require(db, ident, workspace_id, "manage_connectors")
    clean: dict[str, Any] = {}
    if connector_id == "rss":
        url = str(config.get("url", "")).strip()
        if not url.startswith(("https://", "http://")):
            raise EngineError("bad_request", "Enter the feed's http(s) URL.")
        clean = {"url": url[:2048]}
    elif connector_id == "github":
        repos = [r.strip() for r in config.get("repos", []) if isinstance(r, str) and r.count("/") == 1][:10]
        if not repos:
            raise EngineError("bad_request", "List at least one public repository as owner/name.")
        clean = {"repos": repos, "mode": "public_read_only"}
    else:
        raise EngineError("bad_request", "This connector needs OAuth.")
    now = now_iso()
    c = db.insert(connections, id=new_id(), owner_id=ident.sub, workspace_id=workspace_id, connector_id=connector_id, status="active", scopes=[], account_label=clean.get("url") or ", ".join(clean.get("repos", [])), token_ciphertext=None, token_key_id=None, token_expires_at=None, config=clean, sync=dict(IDLE_SYNC), created_at=now, updated_at=now, revoked_at=None)
    _record_consent(db, ident, connector_id, c["id"], "granted", [], f"Read public data from {c['account_label']} into {'workspace ' + workspace_id if workspace_id else 'your account'}.")
    db.audit(ident.sub, "connection_create", owner_id=ident.sub, workspace_id=workspace_id, target=c["id"])
    return _public(c)


def start_oauth(db: Database, ident: Identity, connector_id: str, capability: str, workspace_id: str | None) -> dict[str, Any]:
    spec = BY_ID.get(connector_id)
    if not spec or spec.auth != "oauth2" or not spec.implemented:
        raise EngineError("bad_request", "This connector does not support OAuth yet.")
    if ident.is_guest:
        raise EngineError("forbidden", "Sign in before connecting accounts.")
    s = settings()
    client_id = s.github_client_id if connector_id == "github" else s.google_client_id
    if not client_id:
        raise EngineError("not_configured", f"{spec.name} OAuth is not set up on this server (the operator must register an OAuth app).")
    scopes = spec.capabilities.get(capability)
    if scopes is None:
        raise EngineError("bad_request", f"Unknown capability {capability!r}.")
    state = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    now = datetime.now(UTC)
    db.insert(oauth_states, state_hash=hashlib.sha256(state.encode()).hexdigest(), owner_id=ident.sub, connector_id=connector_id, workspace_id=workspace_id, code_verifier=verifier, created_at=now_iso(), expires_at=(now + timedelta(minutes=10)).isoformat().replace("+00:00", "Z"))
    params = {"client_id": client_id, "redirect_uri": _redirect_uri(), "state": state, "code_challenge": challenge, "code_challenge_method": "S256", "scope": " ".join(scopes)}
    if connector_id == "google_drive":
        params |= {"response_type": "code", "access_type": "offline", "prompt": "consent"}
    return {"authorize_url": f"{spec.authorize_url}?{urlencode(params)}", "scopes": scopes, "expires_in_s": 600}


def finish_oauth(db: Database, ident: Identity, state: str, code: str) -> dict[str, Any]:
    h = hashlib.sha256(state.encode()).hexdigest()
    st = db.get(oauth_states, state_hash=h)
    db.delete(oauth_states, state_hash=h)  # single use
    if not st or st["owner_id"] != ident.sub or st["expires_at"] < now_iso():
        raise EngineError("forbidden", "This sign-in link is invalid or expired. Start the connection again.")
    spec = BY_ID[st["connector_id"]]
    s = settings()
    if spec.id != "github":
        raise EngineError("not_configured", "Only GitHub OAuth is implemented in this release.")
    r = httpx.post(spec.token_url or "", headers={"Accept": "application/json"}, data={"client_id": s.github_client_id, "client_secret": s.github_client_secret, "code": code, "redirect_uri": _redirect_uri(), "code_verifier": st["code_verifier"]}, timeout=20)
    j = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    token = j.get("access_token")
    if not token:
        raise EngineError("upstream_error", f"GitHub did not issue a token ({j.get('error', r.status_code)}).")
    granted = [x for x in str(j.get("scope", "")).split(",") if x]
    login = None
    try:
        u = httpx.get("https://api.github.com/user", headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"}, timeout=15)
        login = u.json().get("login")
    except httpx.HTTPError:
        pass
    cid = new_id()
    ct, kid = encrypt_json({"access_token": token}, aad=f"{cid}:{ident.sub}")
    now = now_iso()
    db.insert(connections, id=cid, owner_id=ident.sub, workspace_id=st["workspace_id"], connector_id=spec.id, status="active", scopes=granted, account_label=login or "GitHub account", token_ciphertext=ct, token_key_id=kid, token_expires_at=None, config={"repos": [], "mode": "oauth"}, sync=dict(IDLE_SYNC), created_at=now, updated_at=now, revoked_at=None)
    _record_consent(db, ident, spec.id, cid, "granted", granted, "Access GitHub with the scopes shown, to mirror issues and create issues after approval.")
    db.audit(ident.sub, "connection_oauth", owner_id=ident.sub, target=cid, data={"scopes": granted})
    return _public(db.get(connections, id=cid))  # type: ignore[arg-type]


def token_for(db: Database, conn: dict[str, Any]) -> str | None:
    if not conn.get("token_ciphertext"):
        return None
    return decrypt_json(conn["token_ciphertext"], conn["token_key_id"], aad=f"{conn['id']}:{conn['owner_id']}").get("access_token")


def update_config(db: Database, ident: Identity, cid: str, config: dict[str, Any]) -> dict[str, Any]:
    c = get_connection(db, ident, cid)
    new = dict(c["config"])
    if c["connector_id"] == "github" and "repos" in config:
        new["repos"] = [r.strip() for r in config["repos"] if isinstance(r, str) and r.count("/") == 1][:10]
    if "workspace_id" in config:
        from ..workspace.service import require

        require(db, ident, str(config["workspace_id"]), "manage_connectors")
        db.update(connections, {"id": cid}, workspace_id=str(config["workspace_id"]))
    db.update(connections, {"id": cid}, config=new, updated_at=now_iso())
    return _public(db.get(connections, id=cid))  # type: ignore[arg-type]


def disconnect(db: Database, ident: Identity, cid: str, delete_data: bool) -> dict[str, Any]:
    c = get_connection(db, ident, cid)
    revoke_result = "nothing to revoke (no stored credentials)"
    token = None
    try:
        token = token_for(db, c)
    except EngineError:
        revoke_result = "stored token could not be decrypted; it has been deleted locally — also revoke it at the provider"
    s = settings()
    if token and c["connector_id"] == "github" and s.github_client_id and s.github_client_secret:
        try:
            r = httpx.request("DELETE", f"https://api.github.com/applications/{s.github_client_id}/grant", auth=(s.github_client_id, s.github_client_secret), json={"access_token": token}, timeout=15)
            revoke_result = "revoked at GitHub" if r.status_code in (204, 404) else f"GitHub returned {r.status_code}; revoke manually at github.com/settings/applications"
        except httpx.HTTPError:
            revoke_result = "could not reach GitHub; revoke manually at github.com/settings/applications"
    db.update(connections, {"id": cid}, status="revoked", token_ciphertext=None, token_key_id=None, revoked_at=now_iso(), updated_at=now_iso())
    _record_consent(db, ident, c["connector_id"], cid, "revoked", c["scopes"], f"Disconnected ({revoke_result}).")
    deleted = 0
    if delete_data:
        for it in db.select(workspace_items, {"workspace_id": c["workspace_id"]} if c["workspace_id"] else {"created_by": ident.sub}):
            if (it.get("source") or {}).get("connection_id") == cid:
                db.delete(item_versions, item_id=it["id"])
                db.delete(workspace_items, id=it["id"])
                deleted += 1
        db.delete(sync_conflicts, connection_id=cid)
        _record_consent(db, ident, c["connector_id"], cid, "data_deleted", [], f"Deleted {deleted} synced item(s) and their history.")
    db.audit(ident.sub, "connection_disconnect", owner_id=ident.sub, target=cid, data={"delete_data": delete_data, "deleted": deleted, "revocation": revoke_result})
    return {"revocation": revoke_result, "deleted_items": deleted}


# ─── sync with conflict handling ────────────────────────────────────────────
def upsert_synced(db: Database, ident: Identity, conn: dict[str, Any], key: str, remote_version: str, item: dict[str, Any], counts: dict[str, int]) -> None:
    """Mirror one remote record. Remote wins unless someone edited the local copy since the last sync, in which case a conflict is recorded instead of overwriting."""
    from ..workspace.service import create_item, update_item

    wid = conn["workspace_id"]
    existing = next((i for i in db.select(workspace_items, {"workspace_id": wid, "deleted_at": None}) if (i.get("source") or {}).get("key") == key and (i.get("source") or {}).get("connection_id") == conn["id"]), None)
    source = {"connector": conn["connector_id"], "connection_id": conn["id"], "key": key, "untrusted": True}
    if not existing:
        created = create_item(db, ident, wid, item, source={**source, "synced_version": 1}, remote_version=remote_version)
        counts["created"] = counts.get("created", 0) + 1
        _ = created
        return
    if existing["remote_version"] == remote_version:
        counts["unchanged"] = counts.get("unchanged", 0) + 1
        return
    locally_edited = existing["current_version"] > int((existing.get("source") or {}).get("synced_version", existing["current_version"]))
    if locally_edited:
        if not db.get(sync_conflicts, connection_id=conn["id"], item_id=existing["id"], status="open"):
            db.insert(sync_conflicts, id=new_id(), connection_id=conn["id"], owner_id=ident.sub, item_id=existing["id"], local={"title": existing["title"], "data": existing["data"], "version": existing["current_version"]}, remote={**item, "remote_version": remote_version}, status="open", resolution=None, created_at=now_iso(), resolved_at=None)
        counts["conflicts"] = counts.get("conflicts", 0) + 1
        return
    updated = update_item(db, ident, wid, existing["id"], item, note=f"Synced from {conn['connector_id']}")
    db.update(workspace_items, {"id": existing["id"]}, remote_version=remote_version, source={**source, "synced_version": updated["current_version"]})
    counts["updated"] = counts.get("updated", 0) + 1


def list_conflicts(db: Database, ident: Identity, cid: str) -> list[dict[str, Any]]:
    get_connection(db, ident, cid)
    return db.select(sync_conflicts, {"connection_id": cid, "status": "open"}, order_by="created_at")


def resolve_conflict(db: Database, ident: Identity, conflict_id: str, keep: str) -> None:
    from ..workspace.service import update_item

    c = db.get(sync_conflicts, id=conflict_id)
    if not c or c["owner_id"] != ident.sub or c["status"] != "open":
        raise EngineError("not_found", "Conflict not found.")
    conn = get_connection(db, ident, c["connection_id"])
    it = db.get(workspace_items, id=c["item_id"])
    if keep not in ("local", "remote"):
        raise EngineError("bad_request", "keep must be local or remote.")
    if keep == "remote" and it:
        updated = update_item(db, ident, conn["workspace_id"], it["id"], {"title": c["remote"].get("title"), "data": c["remote"].get("data")}, note="Conflict resolved: kept remote")
        db.update(workspace_items, {"id": it["id"]}, remote_version=c["remote"].get("remote_version"), source={**(it["source"] or {}), "synced_version": updated["current_version"]})
    elif it:
        # Keep local edits; record the remote version as seen so the same change doesn't conflict again.
        db.update(workspace_items, {"id": it["id"]}, remote_version=c["remote"].get("remote_version"), source={**(it["source"] or {}), "synced_version": it["current_version"]})
    db.update(sync_conflicts, {"id": conflict_id}, status="resolved", resolution=keep, resolved_at=now_iso())


def sync(db: Database, ident: Identity, cid: str) -> dict[str, Any]:
    c = get_connection(db, ident, cid)
    if c["status"] != "active":
        raise EngineError("conflict", "This connection is not active.")
    if not c["workspace_id"]:
        raise EngineError("bad_request", "Choose a workspace for this connection first.")
    from ..workspace.service import require

    require(db, ident, c["workspace_id"], "edit_items")
    started = now_iso()
    db.update(connections, {"id": cid}, sync={**c["sync"], "status": "running", "last_sync_at": started})
    counts: dict[str, int] = {}
    try:
        if c["connector_id"] == "github":
            from .github import sync_issues

            extra = sync_issues(db, ident, c, counts)
        elif c["connector_id"] == "rss":
            from .rss import sync_feed

            extra = sync_feed(db, ident, c, counts)
        else:
            raise EngineError("bad_request", "Sync is not implemented for this connector.")
        status = "partial" if extra.get("errors") else "ok"
        new_sync = {"status": status, "last_sync_at": started, "last_success_at": now_iso(), "counts": counts, "error": "; ".join(extra.get("errors", []))[:500] or None, "cursor": extra.get("cursor"), "rate_limit_remaining": extra.get("rate_limit_remaining")}
    except EngineError as e:
        new_sync = {**c["sync"], "status": "error", "last_sync_at": started, "error": e.message, "counts": counts}
        db.update(connections, {"id": cid}, sync=new_sync, updated_at=now_iso())
        raise
    db.update(connections, {"id": cid}, sync=new_sync, updated_at=now_iso())
    return _public(db.get(connections, id=cid))  # type: ignore[arg-type]
