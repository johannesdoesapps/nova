"""GitHub: mirror issues (read-only) and create issues (approval-gated in workflows)."""

from __future__ import annotations

from typing import Any

import httpx

from ..auth import Identity
from ..db import Database, connections
from ..errors import EngineError
from .service import token_for, upsert_synced

API = "https://api.github.com"


def _headers(token: str | None) -> dict[str, str]:
    h = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "NOVA-AI"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def sync_issues(db: Database, ident: Identity, conn: dict[str, Any], counts: dict[str, int], client: httpx.Client | None = None) -> dict[str, Any]:
    token = token_for(db, conn)
    errors: list[str] = []
    remaining = None
    c = client or httpx.Client(timeout=20)
    try:
        for repo in conn["config"].get("repos", []):
            r = c.get(f"{API}/repos/{repo}/issues", params={"state": "all", "per_page": 50, "sort": "updated"}, headers=_headers(token))
            remaining = r.headers.get("x-ratelimit-remaining", remaining)
            if r.status_code == 404:
                errors.append(f"{repo}: not found or not accessible")
                continue
            if r.status_code in (403, 429):
                errors.append(f"{repo}: rate limited by GitHub")
                continue
            if r.status_code >= 400:
                errors.append(f"{repo}: GitHub returned {r.status_code}")
                continue
            for issue in r.json():
                if "pull_request" in issue:
                    continue
                item = {
                    "type": "task",
                    "title": f"{repo}#{issue['number']}: {issue['title']}"[:300],
                    "data": {
                        "status": "done" if issue["state"] == "closed" else "todo",
                        "body": (issue.get("body") or "")[:20_000],
                        "url": issue["html_url"],
                        "labels": [l["name"] for l in issue.get("labels", []) if isinstance(l, dict)][:20],
                        "author": (issue.get("user") or {}).get("login"),
                    },
                }
                upsert_synced(db, ident, conn, f"{repo}#{issue['number']}", issue["updated_at"], item, counts)
    except httpx.HTTPError:
        raise EngineError("upstream_error", "Could not reach GitHub.") from None
    finally:
        if client is None:
            c.close()
    return {"errors": errors, "rate_limit_remaining": remaining}


def create_issue(db: Database, ident: Identity, repo: str, title: str, body: str) -> dict[str, Any]:
    if repo.count("/") != 1:
        raise EngineError("bad_request", "repo must be owner/name.")
    conns = [c for c in db.select(connections, {"owner_id": ident.sub, "connector_id": "github", "status": "active"}) if c.get("token_ciphertext")]
    if not conns:
        raise EngineError("not_configured", "Connect GitHub (with permission to create issues) in Integrations first.")
    conn = conns[0]
    if not {"public_repo", "repo"} & set(conn["scopes"]):
        raise EngineError("forbidden", "Your GitHub connection was granted read-only access. Reconnect with issue-creation permission.")
    r = httpx.post(f"{API}/repos/{repo}/issues", json={"title": title[:250], "body": body[:60_000]}, headers=_headers(token_for(db, conn)), timeout=20)
    if r.status_code == 429 or r.status_code == 403:
        raise EngineError("rate_limited", "GitHub refused the request (rate limit or permissions).")
    if r.status_code >= 400:
        raise EngineError("upstream_error" if r.status_code >= 500 else "bad_request", f"GitHub returned {r.status_code}.")
    j = r.json()
    return {"number": j.get("number"), "url": j.get("html_url")}
