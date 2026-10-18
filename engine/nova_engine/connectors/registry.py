"""Connector catalog. Status is honest: 'available' means implemented and
usable now, 'needs_setup' means implemented but the operator must register an
OAuth app, 'planned' means designed but not built, and 'not_planned' records
providers we deliberately skip (no suitable API, prohibitive terms or cost)."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Literal

from ..config import settings


@dataclass(frozen=True)
class ConnectorSpec:
    id: str
    name: str
    category: str
    auth: Literal["none", "oauth2", "api_key"]
    priority: Literal["P0", "P1", "P2", "P3", "—"]
    value: str
    feasibility: str
    capabilities: dict[str, list[str]] = field(default_factory=dict)  # capability -> minimal scopes
    syncs: str = ""
    writes: str = ""
    revocation: str = ""
    api_notes: str = ""
    implemented: bool = False
    authorize_url: str | None = None
    token_url: str | None = None


CATALOG: list[ConnectorSpec] = [
    ConnectorSpec("rss", "RSS / Atom feeds", "Sources", "none", "P0", "Follow blogs, journals, changelogs and newsletters with no account.", "High — open standard, no auth.",
                  {"read": []}, syncs="Feed entries → workspace links (deduplicated by URL).", revocation="Delete the connection; nothing is stored at a provider.", implemented=True),
    ConnectorSpec("github", "GitHub", "Engineering", "oauth2", "P0", "Mirror issues and releases into project context; open issues from workflows.", "High — documented REST API, OAuth and GitHub Apps.",
                  {"read_public": [], "create_issues_public_repos": ["public_repo"], "read_write_private_repos": ["repo"]},
                  syncs="Issues of chosen repositories → workspace tasks (read-only mirror).", writes="Create issue (always after your approval).",
                  revocation="Disconnect revokes the grant via GitHub's API; you can also revoke at github.com/settings/applications.",
                  api_notes="OAuth App scopes are coarse (public_repo / repo). A GitHub App with per-repository permissions is the recommended production setup. Public repositories can be mirrored without signing in (60 requests/hour).",
                  implemented=True, authorize_url="https://github.com/login/oauth/authorize", token_url="https://github.com/login/oauth/access_token"),
    ConnectorSpec("arxiv", "arXiv", "Research", "none", "P0", "Track new papers for research questions.", "High — public Atom API (rate-limit friendly use required).", {"read": []}, syncs="Used as a Signal Radar source.", implemented=True),
    ConnectorSpec("hacker_news", "Hacker News", "Sources", "none", "P1", "Early technology discussion signals.", "High — public Algolia search API.", {"read": []}, syncs="Used as a Signal Radar source (discussion = unconfirmed).", implemented=True),
    ConnectorSpec("google_drive", "Google Drive", "Documents", "oauth2", "P1", "Bring documents into projects for research and Claim DNA.", "Medium — drive.file scope needs the Google Picker; broad drive.readonly is a restricted scope requiring Google verification.",
                  {"pick_files": ["https://www.googleapis.com/auth/drive.file"]}, syncs="Files you pick → workspace documents (text export).",
                  revocation="Disconnect calls Google's token revocation endpoint.", api_notes="Uses drive.file so NOVA AI only sees files you explicitly choose.", implemented=False,
                  authorize_url="https://accounts.google.com/o/oauth2/v2/auth", token_url="https://oauth2.googleapis.com/token"),
    ConnectorSpec("notion", "Notion", "Documents", "oauth2", "P1", "Import knowledge bases and decisions.", "Medium — public OAuth integrations; users choose pages to share.", {"read_selected_pages": ["(page-level grant chosen in Notion)"]}, syncs="Selected pages → workspace documents.", implemented=False),
    ConnectorSpec("slack_webhook", "Slack (incoming webhook)", "Communication", "none", "P1", "Send digests and workflow results to a channel.", "High — webhooks need no OAuth; the URL itself is the secret.", {"post_to_one_channel": []}, writes="Post messages via AI Lab's http.post (approval required).", implemented=True, api_notes="Store the webhook URL as a workflow input; the domain must be allow-listed."),
    ConnectorSpec("zotero", "Zotero", "Research", "api_key", "P2", "Bring reference libraries into research projects.", "Medium — Web API with per-user keys and read-only key option.", {"read_library": ["read-only key"]}, implemented=False),
    ConnectorSpec("google_calendar", "Google Calendar", "Productivity", "oauth2", "P3", "Schedule-aware digests and tasks.", "Medium — sensitive scope verification.", {"read_events": ["https://www.googleapis.com/auth/calendar.events.readonly"]}, implemented=False),
    ConnectorSpec("gmail", "Gmail", "Communication", "oauth2", "P3", "Draft replies with research context.", "Low — restricted scopes require a paid third-party security assessment.", {"compose_drafts": ["https://www.googleapis.com/auth/gmail.compose"]}, implemented=False),
    ConnectorSpec("x_twitter", "X (Twitter)", "Sources", "oauth2", "—", "Social signals.", "Not planned — API access is paid and terms restrict storage and analysis.", {}, implemented=False),
    ConnectorSpec("linkedin", "LinkedIn", "Sources", "oauth2", "—", "Professional signals.", "Not planned — no general-purpose API for this use.", {}, implemented=False),
]

BY_ID = {c.id: c for c in CATALOG}


def status_of(c: ConnectorSpec) -> str:
    if c.priority == "—":
        return "not_planned"
    if not c.implemented:
        return "planned"
    s = settings()
    if c.id == "github" and not (s.github_client_id and s.github_client_secret):
        return "available_limited"  # public read-only mirror works; OAuth needs an app
    return "available"


def catalog() -> list[dict]:
    return [{**asdict(c), "status": status_of(c)} for c in CATALOG]
