"""Tool registry and the approval policy.

The policy is enforced by the executor at the moment a step runs. It cannot
be relaxed by a workflow definition, a template, a model output or retrieved
content: the only way past an approval gate is an approval record created by
the signed-in user for that exact payload (bound by hash).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

Risk = Literal["read", "internal_write", "external_send", "irreversible"]

APPROVAL_KINDS = {
    "consequential_action": "Sends, posts or changes something outside ORBIS AI.",
    "irreversible_change": "Cannot be undone.",
    "sensitive_data_sharing": "Shares sensitive data with an external service or model provider.",
    "untrusted_parameters": "Parameters for this action came from untrusted content (web, documents, model output).",
    "explicit_gate": "The workflow asks for a human check here.",
}


@dataclass(frozen=True)
class ToolSpec:
    id: str
    name: str
    description: str
    risk: Risk
    data_egress: bool  # sends data to a third party
    required_params: tuple[str, ...] = ()
    connector: str | None = None
    default_granted: bool = False
    implementation: Literal["real", "simulated", "needs_config"] = "real"
    notes: str = ""
    param_hints: dict[str, str] = field(default_factory=dict)

    @property
    def consequential(self) -> bool:
        return self.risk in ("external_send", "irreversible")


TOOLS: dict[str, ToolSpec] = {
    t.id: t
    for t in [
        ToolSpec("web.search", "Web search", "Search the web via the configured provider (Tavily/Brave). Sends the query to that provider.", "read", True, ("query",), default_granted=True, notes="Query text leaves ORBIS AI."),
        ToolSpec("http.get", "Fetch URL", "GET a URL on an allow-listed domain and return its text.", "read", True, ("url",), default_granted=True, notes="Only domains listed in the workflow's network permissions."),
        ToolSpec("workspace.search", "Search workspace", "Search items in one of your workspaces.", "read", False, ("workspace_id", "query"), default_granted=True),
        ToolSpec("workspace.create_item", "Save to workspace", "Create a note/document item in a workspace you can edit.", "internal_write", False, ("workspace_id", "title", "body"), default_granted=True),
        ToolSpec("workspace.delete_item", "Delete workspace item", "Delete an item (and its versions) from a workspace.", "irreversible", False, ("workspace_id", "item_id")),
        ToolSpec("radar.create_watch", "Create radar watch", "Start following a topic in Signal Radar.", "internal_write", False, ("name", "query"), default_granted=True),
        ToolSpec("http.post", "HTTP POST", "POST JSON to an allow-listed URL (webhooks).", "external_send", True, ("url", "body")),
        ToolSpec("email.send", "Send email", "Send an email. Without SMTP configured, the message is written to the outbox and marked simulated.", "external_send", True, ("to", "subject", "body"), implementation="needs_config"),
        ToolSpec("github.create_issue", "Create GitHub issue", "Open an issue in a repository through your GitHub connection.", "external_send", True, ("repo", "title", "body"), connector="github"),
    ]
}


def approvals_for_action(tool: ToolSpec, *, untrusted_params: bool, sensitive_found: list[str]) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    if tool.risk == "external_send":
        out.append(("consequential_action", f"{tool.name}: {APPROVAL_KINDS['consequential_action']}"))
    if tool.risk == "irreversible":
        out.append(("irreversible_change", f"{tool.name}: {APPROVAL_KINDS['irreversible_change']}"))
    if tool.data_egress and sensitive_found:
        out.append(("sensitive_data_sharing", f"Detected {', '.join(sorted(set(sensitive_found)))} in data sent by {tool.name}."))
    if untrusted_params and tool.risk != "read":
        out.append(("untrusted_parameters", APPROVAL_KINDS["untrusted_parameters"]))
    return out


def approvals_for_model_call(*, external: bool, sensitive_inputs: list[str], sensitive_found: list[str], allow_sensitive: bool) -> list[tuple[str, str]]:
    if not external or allow_sensitive:
        return []
    reasons = []
    if sensitive_inputs:
        reasons.append(f"inputs marked sensitive ({', '.join(sensitive_inputs)})")
    if sensitive_found:
        reasons.append(f"detected {', '.join(sorted(set(sensitive_found)))}")
    if not reasons:
        return []
    return [("sensitive_data_sharing", "This model call would send " + " and ".join(reasons) + " to an external model provider.")]
