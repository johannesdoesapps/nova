"""Reusable workflow templates. Instantiating a template copies it into a new
draft workflow; nothing in a template can bypass approvals or permissions."""

from __future__ import annotations

from typing import Any

SAVE_IF_WORKSPACE = "len(input_workspace_id) > 0"


def _research_brief() -> dict[str, Any]:
    return {
        "name": "Research brief with citations",
        "description": "Search the web, write a cited brief, and optionally save it to a workspace.",
        "trigger": {"type": "manual"},
        "inputs": [
            {"name": "topic", "label": "Topic or question", "type": "string"},
            {"name": "audience", "label": "Audience", "type": "string", "required": False, "default": "a busy decision-maker"},
            {"name": "workspace_id", "label": "Workspace to save into (optional)", "type": "string", "required": False, "default": ""},
        ],
        "nodes": [
            {"id": "search", "type": "retrieval", "name": "Search the web", "config": {"source": "web_search", "query": "{{inputs.topic}}", "top_k": 6}, "retry": {"max_attempts": 2, "backoff_s": 2}, "position": {"x": 0, "y": 0}},
            {"id": "has_sources", "type": "branch", "name": "Any sources?", "config": {"condition": "len(search) > 0"}, "depends_on": ["search"], "position": {"x": 260, "y": 0}},
            {"id": "sources", "type": "transform", "name": "Number the sources", "config": {"op": "join", "input": "{{nodes.search.output}}", "format": "[{n}] {title} — {url}", "separator": "\n"}, "depends_on": ["search"], "position": {"x": 260, "y": 140}},
            {"id": "brief", "type": "model_call", "name": "Write the brief", "config": {"prompt": "Write a one-page brief on: {{inputs.topic}}\nAudience: {{inputs.audience}}\n\nUse ONLY these sources and cite them as [n]:\n{{nodes.search.output}}\n\nSay plainly where the sources are thin or disagree.", "max_tokens": 1500}, "depends_on": ["search", "sources"], "when": {"node": "has_sources", "equals": True}, "retry": {"max_attempts": 2, "backoff_s": 2}, "position": {"x": 520, "y": 0}},
            {"id": "no_sources", "type": "output", "name": "Nothing found", "config": {"value": "No web sources were retrieved for “{{inputs.topic}}”, so no brief was written (NOVA AI does not write unsourced briefs)."}, "when": {"node": "has_sources", "equals": False}, "position": {"x": 520, "y": 160}},
            {"id": "want_save", "type": "branch", "name": "Save to workspace?", "config": {"condition": SAVE_IF_WORKSPACE}, "depends_on": ["brief"], "position": {"x": 780, "y": 140}},
            {"id": "save", "type": "action", "name": "Save to workspace", "config": {"tool": "workspace.create_item", "params": {"workspace_id": "{{inputs.workspace_id}}", "title": "Brief: {{inputs.topic}}", "body": "{{nodes.brief.output}}\n\nSources:\n{{nodes.sources.output}}", "type": "research"}}, "depends_on": ["brief", "sources"], "when": {"node": "want_save", "equals": True}, "position": {"x": 1040, "y": 140}},
            {"id": "result", "type": "output", "name": "Brief", "config": {"value": "{{nodes.brief.output}}\n\nSources:\n{{nodes.sources.output}}"}, "depends_on": ["brief", "sources"], "position": {"x": 780, "y": 0}},
        ],
        "budget": {"max_cost_usd": 0.25, "max_model_calls": 4},
        "permissions": {"tools": ["web.search", "workspace.create_item"]},
        "outputs": ["result", "no_sources"],
    }


def _email_draft() -> dict[str, Any]:
    return {
        "name": "Draft and send an email (with approval)",
        "description": "Draft an email from your notes. NOVA AI pauses and shows you the exact message before anything is sent.",
        "inputs": [
            {"name": "to", "label": "Recipient email", "type": "string", "sensitive": True},
            {"name": "notes", "label": "What the email should say", "type": "text"},
            {"name": "tone", "label": "Tone", "type": "string", "required": False, "default": "friendly and concise"},
        ],
        "nodes": [
            {"id": "draft", "type": "model_call", "name": "Draft email", "config": {"prompt": "Draft a short email. Tone: {{inputs.tone}}.\nNotes from the sender:\n{{inputs.notes}}\n\nReturn JSON with keys subject and body.", "output": "json", "max_tokens": 800}, "position": {"x": 0, "y": 0}},
            {"id": "subject", "type": "transform", "name": "Subject", "config": {"op": "pick", "input": "{{nodes.draft.output}}", "path": "subject"}, "depends_on": ["draft"], "position": {"x": 260, "y": -60}},
            {"id": "body", "type": "transform", "name": "Body", "config": {"op": "pick", "input": "{{nodes.draft.output}}", "path": "body"}, "depends_on": ["draft"], "position": {"x": 260, "y": 60}},
            {"id": "send", "type": "action", "name": "Send email", "config": {"tool": "email.send", "params": {"to": "{{inputs.to}}", "subject": "{{nodes.subject.output}}", "body": "{{nodes.body.output}}"}}, "depends_on": ["subject", "body"], "position": {"x": 520, "y": 0}},
            {"id": "result", "type": "output", "name": "Result", "config": {"value": "{{nodes.send.output}}"}, "depends_on": ["send"], "position": {"x": 780, "y": 0}},
        ],
        "budget": {"max_cost_usd": 0.05, "max_model_calls": 2},
        "permissions": {"tools": ["email.send"], "share_sensitive_with_models": False},
        "outputs": ["result"],
    }


def _url_summary() -> dict[str, Any]:
    return {
        "name": "Summarise a page into a workspace",
        "description": "Fetch an allow-listed page, summarise it, and save the summary. Page text is untrusted: instructions inside it are ignored.",
        "inputs": [
            {"name": "url", "label": "Page URL (en.wikipedia.org)", "type": "string", "default": "https://en.wikipedia.org/wiki/Four-day_week"},
            {"name": "workspace_id", "label": "Workspace", "type": "string"},
        ],
        "nodes": [
            {"id": "page", "type": "retrieval", "name": "Fetch page", "config": {"source": "url", "url": "{{inputs.url}}"}, "retry": {"max_attempts": 3, "backoff_s": 2}, "position": {"x": 0, "y": 0}},
            {"id": "text", "type": "transform", "name": "Trim", "config": {"op": "truncate", "input": "{{nodes.page.output.0.text}}", "max_chars": 12000}, "depends_on": ["page"], "position": {"x": 260, "y": 0}},
            {"id": "summary", "type": "model_call", "name": "Summarise", "config": {"prompt": "Summarise this page in 6 bullet points, then list 3 open questions.\n\n{{nodes.text.output}}", "max_tokens": 800}, "depends_on": ["text"], "position": {"x": 520, "y": 0}},
            {"id": "save", "type": "action", "name": "Save summary", "config": {"tool": "workspace.create_item", "params": {"workspace_id": "{{inputs.workspace_id}}", "title": "Summary of {{inputs.url}}", "body": "{{nodes.summary.output}}\n\nSource: {{inputs.url}}", "type": "document"}}, "depends_on": ["summary"], "position": {"x": 780, "y": 0}},
            {"id": "result", "type": "output", "name": "Summary", "config": {"value": "{{nodes.summary.output}}"}, "depends_on": ["summary"], "position": {"x": 780, "y": 140}},
        ],
        "permissions": {"tools": ["http.get", "workspace.create_item"], "network_domains": ["en.wikipedia.org"]},
        "budget": {"max_cost_usd": 0.05, "max_model_calls": 2},
        "outputs": ["result"],
    }


def _radar_digest() -> dict[str, Any]:
    return {
        "name": "Weekly signal digest to a webhook",
        "description": "Every week, summarise new Signal Radar items for a topic and post them to a team webhook — after your approval.",
        "trigger": {"type": "schedule", "config": {"every": "weekly", "at_hour_utc": 8}},
        "inputs": [
            {"name": "topic", "label": "Radar topic", "type": "string", "default": "AI regulation"},
            {"name": "webhook", "label": "Webhook URL (hooks.slack.com)", "type": "string", "default": "https://hooks.slack.com/services/XXX"},
        ],
        "nodes": [
            {"id": "signals", "type": "retrieval", "name": "Radar items", "config": {"source": "radar", "query": "{{inputs.topic}}", "top_k": 10}, "position": {"x": 0, "y": 0}},
            {"id": "any", "type": "branch", "name": "Anything new?", "config": {"condition": "len(signals) > 0"}, "depends_on": ["signals"], "position": {"x": 260, "y": 0}},
            {"id": "digest", "type": "model_call", "name": "Write digest", "config": {"prompt": "Write a 5-bullet digest of these signals. Label each as confirmed, reported or speculative exactly as given, and include its URL.\n{{nodes.signals.output}}", "max_tokens": 900}, "depends_on": ["signals"], "when": {"node": "any", "equals": True}, "position": {"x": 520, "y": 0}},
            {"id": "post", "type": "action", "name": "Post to webhook", "config": {"tool": "http.post", "params": {"url": "{{inputs.webhook}}", "body": {"text": "{{nodes.digest.output}}"}}}, "depends_on": ["digest"], "position": {"x": 780, "y": 0}},
            {"id": "result", "type": "output", "name": "Digest", "config": {"value": "{{nodes.digest.output}}"}, "depends_on": ["digest"], "position": {"x": 780, "y": 140}},
        ],
        "permissions": {"tools": ["http.post"], "network_domains": ["hooks.slack.com"]},
        "budget": {"max_cost_usd": 0.05, "max_model_calls": 2},
        "outputs": ["result"],
    }


def _github_issue() -> dict[str, Any]:
    return {
        "name": "Turn notes into a GitHub issue",
        "description": "Structure rough notes into an issue and open it in a repository through your GitHub connection, after approval.",
        "inputs": [
            {"name": "repo", "label": "Repository (owner/name)", "type": "string"},
            {"name": "notes", "label": "Notes", "type": "text"},
        ],
        "nodes": [
            {"id": "issue", "type": "model_call", "name": "Structure issue", "config": {"prompt": "Turn these notes into a GitHub issue. Return JSON with keys title and body (Markdown with Steps to reproduce / Expected / Actual if relevant).\n\n{{inputs.notes}}", "output": "json", "max_tokens": 900}, "position": {"x": 0, "y": 0}},
            {"id": "review", "type": "approval", "name": "Review issue text", "config": {"message": "Check the issue before it is created.", "show": ["issue"]}, "depends_on": ["issue"], "position": {"x": 260, "y": 0}},
            {"id": "create", "type": "action", "name": "Create issue", "config": {"tool": "github.create_issue", "params": {"repo": "{{inputs.repo}}", "title": "{{nodes.issue.output.title}}", "body": "{{nodes.issue.output.body}}"}}, "depends_on": ["review", "issue"], "position": {"x": 520, "y": 0}},
            {"id": "result", "type": "output", "name": "Issue", "config": {"value": "{{nodes.create.output}}"}, "depends_on": ["create"], "position": {"x": 780, "y": 0}},
        ],
        "permissions": {"tools": ["github.create_issue"]},
        "budget": {"max_cost_usd": 0.05, "max_model_calls": 2},
        "outputs": ["result"],
    }


TEMPLATES: dict[str, dict[str, Any]] = {
    "research-brief": {"category": "Research", "requires": ["Web search key for real results"], "build": _research_brief},
    "email-with-approval": {"category": "Communication", "requires": ["Email provider for real delivery (otherwise simulated)"], "build": _email_draft},
    "summarise-page": {"category": "Knowledge", "requires": ["A workspace"], "build": _url_summary},
    "radar-digest-webhook": {"category": "Monitoring", "requires": ["A Signal Radar watch", "A webhook domain you control"], "build": _radar_digest},
    "notes-to-github-issue": {"category": "Engineering", "requires": ["GitHub connection"], "build": _github_issue},
}


def list_templates() -> list[dict[str, Any]]:
    out = []
    for tid, t in TEMPLATES.items():
        spec = t["build"]()
        out.append({"id": tid, "name": spec["name"], "description": spec["description"], "category": t["category"], "requires": t["requires"], "node_count": len(spec["nodes"]), "tools": spec["permissions"]["tools"], "trigger": spec.get("trigger", {"type": "manual"})["type"], "spec": spec})
    return out


def template_spec(tid: str) -> dict[str, Any] | None:
    t = TEMPLATES.get(tid)
    return t["build"]() if t else None
