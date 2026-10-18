"""Intent-to-Outcome Engine: goal → reviewable plan → workflow.

The plan is a proposal, never an action. The user reviews and edits tasks,
dependencies, tools and models before anything is compiled into a workflow,
and compiling does not run anything. Model-generated plans are validated
against the tool registry, and approval requirements are re-derived from
policy (a model can't mark a send as "no approval needed").
"""

from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError

from ..llm import available_models, complete, extract_json, price_for
from ..security.content import SYSTEM_RULES, wrap_untrusted
from ..security.policy import TOOLS

TaskKind = Literal["research", "fetch", "analyze", "draft", "transform", "decide", "act", "save", "monitor", "deliver"]


class PlanTask(BaseModel):
    id: str = Field(pattern=r"^[a-z][a-z0-9_]{0,39}$")
    title: str = Field(min_length=1, max_length=160)
    description: str = Field("", max_length=1000)
    kind: TaskKind
    depends_on: list[str] = []
    tool: str | None = None
    model: str | None = None
    needs_approval: bool = False
    approval_reasons: list[str] = []
    risk: Literal["low", "medium", "high"] = "low"
    params: dict[str, Any] = {}


class Plan(BaseModel):
    goal: str
    interpreted_as: str
    assumptions: list[str] = []
    success_criteria: list[str] = []
    open_questions: list[str] = []
    inputs: list[dict[str, Any]] = []
    tasks: list[PlanTask]
    warnings: list[str] = []
    planner: Literal["model", "rules"] = "rules"
    estimate: dict[str, Any] = {}


INTENTS: dict[str, re.Pattern[str]] = {
    "monitor": re.compile(r"\b(monitor|track|watch|keep an eye|alert me|notify me when|every (day|week|morning|monday)|weekly|daily)\b", re.I),
    "compare": re.compile(r"\b(compare|comparison|versus|vs\.?|pros and cons|trade-?offs?|which is better)\b", re.I),
    "research": re.compile(r"\b(research|find|look up|investigate|evidence|sources|studies|market|landscape|what (is|are)|latest|news)\b", re.I),
    "summarize": re.compile(r"\b(summari[sz]e|summary|tl;?dr|digest|brief|overview|recap)\b", re.I),
    "draft": re.compile(r"\b(write|draft|compose|reply|blog post|newsletter|announcement|proposal|outline)\b", re.I),
    "email": re.compile(r"\b(e-?mail|send (it|this|them)? ?to)\b", re.I),
    "webhook": re.compile(r"\b(slack|teams|webhook|post (it|this)? ?to)\b", re.I),
    "github": re.compile(r"\b(github|issue|ticket|bug report)\b", re.I),
    "save": re.compile(r"\b(save|store|file|add (it |this )?to (my )?(workspace|project|notes|knowledge))\b", re.I),
    "approve": re.compile(r"\b(let me (review|approve|check)|before (sending|posting|publishing)|with my approval)\b", re.I),
}
URL_RE = re.compile(r"https?://[^\s)>\]]+")
EMAIL_RE = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")
REPO_RE = re.compile(r"\b([A-Za-z0-9-]+/[A-Za-z0-9_.-]+)\b")


def _topic(goal: str) -> str:
    t = URL_RE.sub("", goal)
    t = re.sub(r"^\s*(please\s+)?(can you\s+|could you\s+|i want to\s+|help me\s+)?", "", t, flags=re.I)
    t = re.sub(r"\b(research|find|look up|investigate|summari[sz]e|summary|cited|citations?|sources?|with|write|draft|compose|monitor|track|compare|and|then|email|send|save|it|this|to|me|a|an|the|brief|report|about|on|for|my|workspace|weekly|daily|every week|every day|latest|news|please)\b", " ", t, flags=re.I)
    t = EMAIL_RE.sub("", t)
    t = re.sub(r"\s+", " ", t).strip(" .,;:-")
    return t[:120] or goal[:120]


def _task(id: str, title: str, kind: str, deps: list[str], **kw: Any) -> PlanTask:
    return PlanTask(id=id, title=title, kind=kind, depends_on=deps, **kw)  # type: ignore[arg-type]


def rules_plan(goal: str, *, model: str | None = None) -> Plan:
    g = goal.strip()
    has = {k: bool(p.search(g)) for k, p in INTENTS.items()}
    urls = URL_RE.findall(g)
    emails = EMAIL_RE.findall(g)
    repos = [r for r in REPO_RE.findall(g) if not r.startswith(("http", "www")) and "." not in r.split("/")[0]] if has["github"] else []
    topic = _topic(g)
    model = model or available_models()[0]["id"]
    tasks: list[PlanTask] = []
    assumptions: list[str] = []
    questions: list[str] = []
    inputs: list[dict[str, Any]] = [{"name": "topic", "label": "Topic", "type": "string", "default": topic}]
    evidence: list[str] = []

    if urls:
        tasks.append(_task("fetch", f"Read {urls[0]}", "fetch", [], tool="http.get", params={"url": urls[0]}, description="Fetch the page you linked. Its text is treated as untrusted data."))
        evidence.append("fetch")
        assumptions.append(f"Only the domain {urls[0].split('/')[2]} will be allowed for fetching.")
    if has["research"] or has["compare"] or (not urls and (has["summarize"] or has["draft"] or has["monitor"]) and not has["draft"]):
        tasks.append(_task("research", f"Search the web for “{topic}”", "research", [], tool="web.search", params={"query": topic}, description="Collect up to 6 sources with titles, URLs and dates."))
        evidence.append("research")
        assumptions.append("Web search uses the configured provider; the query text is sent to it.")
    if has["compare"]:
        tasks.append(_task("analyze", "Compare the options side by side", "analyze", evidence[:], model=model, description="A table of criteria with which source supports each point."))
    last = tasks[-1].id if tasks else None
    if has["draft"] or has["email"] or has["webhook"] or has["github"]:
        deps = [t.id for t in tasks if t.kind in ("research", "fetch", "analyze")]
        what = "email" if has["email"] else "GitHub issue" if has["github"] else "message" if has["webhook"] else "draft"
        tasks.append(_task("draft", f"Write the {what}", "draft", deps, model=model, description="Grounded in the collected material; uncertain points are marked."))
        last = "draft"
    elif evidence or has["summarize"]:
        tasks.append(_task("synthesize", "Write a cited summary", "analyze", [t.id for t in tasks], model=model, description="Every claim cites a source number; gaps are stated."))
        last = "synthesize"
    if not tasks:
        tasks.append(_task("synthesize", "Work through the goal", "analyze", [], model=model, description="No research or action was detected, so this is a single model step."))
        last = "synthesize"
        assumptions.append("No sources or actions were detected in the goal; the model answers from its own knowledge, which may be outdated.")
    if has["approve"] and (has["email"] or has["webhook"] or has["github"]):
        tasks.append(_task("review", "You review before anything is sent", "decide", [last]))
        last = "review"
    if has["email"]:
        to = emails[0] if emails else None
        inputs.append({"name": "to", "label": "Recipient email", "type": "string", "sensitive": True, **({"default": to} if to else {})})
        if not to:
            questions.append("Who should receive the email?")
        tasks.append(_task("send_email", "Send the email", "act", [last], tool="email.send"))
        last = "send_email"
    if has["webhook"]:
        inputs.append({"name": "webhook", "label": "Webhook URL", "type": "string"})
        questions.append("Which webhook URL should receive the message, and which domain should be allowed?")
        tasks.append(_task("post", "Post to the webhook", "act", [last], tool="http.post"))
        last = "post"
    if has["github"]:
        inputs.append({"name": "repo", "label": "Repository (owner/name)", "type": "string", **({"default": repos[0]} if repos else {})})
        if not repos:
            questions.append("Which GitHub repository should the issue go to?")
        tasks.append(_task("open_issue", "Open the GitHub issue", "act", [last], tool="github.create_issue"))
        last = "open_issue"
    if has["save"]:
        inputs.append({"name": "workspace_id", "label": "Workspace", "type": "string"})
        questions.append("Which workspace should the result be saved to?")
        content_task = next((t.id for t in reversed(tasks) if t.kind in ("draft", "analyze")), last)
        tasks.append(_task("save", "Save the result to your workspace", "save", [content_task], tool="workspace.create_item"))
    if has["monitor"]:
        tasks.append(_task("watch", f"Follow “{topic}” in Signal Radar", "monitor", [], tool="radar.create_watch", params={"name": topic, "query": topic}, description="Radar checks run on the schedule the NOVA worker supports; it is not continuous."))
        assumptions.append("Monitoring is created as a Radar watch; checks happen when the scheduled worker runs.")
    content_task = next((t.id for t in reversed(tasks) if t.kind in ("draft", "analyze")), None)
    tasks.append(_task("deliver", "Show the result", "deliver", [content_task] if content_task else [tasks[-1].id]))

    criteria = ["Every factual statement cites one of the collected sources."] if evidence else []
    if has["email"] or has["webhook"] or has["github"]:
        criteria.append("Nothing is sent until you approve the exact content.")
    if has["save"]:
        criteria.append("The result is saved as a new item in your workspace.")
    criteria.append("You can read every step's input, output and log.")
    return finalize(Plan(goal=g, interpreted_as=f"{', '.join(k for k, v in has.items() if v) or 'answer'} — topic “{topic}”", assumptions=assumptions, success_criteria=criteria, open_questions=questions, inputs=inputs, tasks=tasks, planner="rules"))


PLANNER_PROMPT = """Plan how to accomplish the user's goal as a small set of tasks.
Allowed task kinds: research, fetch, analyze, draft, transform, decide, act, save, monitor, deliver.
Allowed tools (only for research/fetch/act/save/monitor): {tools}.
Return JSON: {{"interpreted_as": str, "assumptions": [str], "success_criteria": [str], "open_questions": [str],
"tasks": [{{"id": "snake_case", "title": str, "description": str, "kind": str, "depends_on": [ids], "tool": str|null}}]}}
Keep it to at most 8 tasks and end with one "deliver" task. Do not claim anything is done."""


def model_plan(goal: str, model: str) -> Plan | None:
    system = SYSTEM_RULES + "\n\n" + PLANNER_PROMPT.format(tools=", ".join(TOOLS))
    try:
        res = complete(model, system, "Goal (written by the user):\n" + wrap_untrusted(goal, "user-goal"), max_tokens=1500, json_mode=True, timeout_s=45)
    except Exception:  # noqa: BLE001 - fall back to rules
        return None
    if res.simulated:
        return None
    data = extract_json(res.text)
    if not isinstance(data, dict):
        return None
    try:
        tasks = [PlanTask.model_validate({**t, "model": model if t.get("kind") in ("analyze", "draft") else None}) for t in data.get("tasks", [])][:8]
        plan = Plan(goal=goal, interpreted_as=str(data.get("interpreted_as", ""))[:300], assumptions=[str(x)[:300] for x in data.get("assumptions", [])][:8], success_criteria=[str(x)[:300] for x in data.get("success_criteria", [])][:8], open_questions=[str(x)[:300] for x in data.get("open_questions", [])][:8], inputs=[{"name": "topic", "type": "string", "default": _topic(goal)}], tasks=tasks, planner="model")
    except ValidationError:
        return None
    return finalize(plan)


def finalize(plan: Plan) -> Plan:
    """Enforce policy and compute the estimate. Runs on every plan, including user-edited ones."""
    ids = {t.id for t in plan.tasks}
    warnings = []
    for t in plan.tasks:
        t.depends_on = [d for d in t.depends_on if d in ids and d != t.id]
        if t.tool and t.tool not in TOOLS:
            warnings.append(f"Task {t.id}: tool {t.tool!r} is not available and was removed.")
            t.tool = None
        spec = TOOLS.get(t.tool or "")
        reasons = []
        if spec and spec.consequential:
            reasons.append("consequential_action" if spec.risk == "external_send" else "irreversible_change")
        if t.kind == "decide":
            reasons.append("explicit_gate")
        t.needs_approval = bool(reasons)
        t.approval_reasons = reasons
        t.risk = "high" if spec and spec.risk == "irreversible" else "medium" if reasons or (spec and spec.data_egress) else "low"
    model_tasks = [t for t in plan.tasks if t.kind in ("analyze", "draft")]
    prices = [price_for(t.model or "") for t in model_tasks]
    plan.estimate = {
        "model_calls": len(model_tasks),
        "cost_usd_max": None if any(p is None for p in prices) else round(sum((4000 * p[0] + 1500 * p[1]) / 1e6 for p in prices if p), 4),
        "approvals": [t.id for t in plan.tasks if t.needs_approval],
        "external_services": sorted({TOOLS[t.tool].name for t in plan.tasks if t.tool and TOOLS[t.tool].data_egress}),
    }
    if plan.estimate["cost_usd_max"] is None:
        warnings.append("Model prices are not verified, so the cost estimate is unavailable; model-call limits still apply.")
    plan.warnings = warnings + [w for w in plan.warnings if w not in warnings]
    return plan


def make_plan(goal: str, *, use_model: bool, model: str | None = None) -> Plan:
    model = model or available_models()[0]["id"]
    if use_model and not model.startswith("demo:"):
        p = model_plan(goal, model)
        if p:
            return p
    p = rules_plan(goal, model=model)
    if use_model:
        p.warnings.insert(0, "A model planner was not available (demo mode or invalid response), so the rule-based planner was used.")
    return p


def compile_plan(plan: Plan) -> dict[str, Any]:
    """Turn an approved plan into a draft workflow spec (nothing runs)."""
    nodes: list[dict[str, Any]] = []
    tools: set[str] = set()
    domains: set[str] = set()
    input_names = {i["name"] for i in plan.inputs}
    inputs = list(plan.inputs)
    out_of: dict[str, str] = {}  # task id -> node id holding its main output
    evidence_ids = [t.id for t in plan.tasks if t.kind in ("research", "fetch")]
    gate_id = "evidence_found"
    x = 0
    for t in plan.tasks:
        deps = [out_of.get(d, d) for d in t.depends_on]
        evidence_refs = "\n\n".join(f"{{{{nodes.{out_of.get(d, d)}.output}}}}" for d in t.depends_on)
        pos = {"x": x * 260, "y": 0}
        x += 1
        if t.kind == "research":
            tools.add("web.search")
            nodes.append({"id": t.id, "type": "retrieval", "name": t.title, "config": {"source": "web_search", "query": "{{inputs.topic}}" if "topic" in input_names else t.params.get("query", plan.goal[:200]), "top_k": 6}, "depends_on": deps, "retry": {"max_attempts": 2, "backoff_s": 2}, "position": pos})
        elif t.kind == "fetch":
            url = str(t.params.get("url", ""))
            tools.add("http.get")
            if url:
                domains.add(url.split("/")[2])
            nodes.append({"id": t.id, "type": "retrieval", "name": t.title, "config": {"source": "url", "url": url}, "depends_on": deps, "retry": {"max_attempts": 2}, "position": pos})
        elif t.kind in ("analyze", "draft", "transform"):
            if evidence_ids and gate_id not in out_of.values() and any(d in evidence_ids for d in _all_deps(plan, t.id)):
                # Don't write from nothing: if retrieval found no evidence, skip writing (and anything after it) and say so.
                cond = " or ".join(f"len({e}) > 0" for e in evidence_ids)
                nodes.append({"id": gate_id, "type": "branch", "name": "Any evidence found?", "config": {"condition": cond}, "depends_on": list(evidence_ids), "position": {"x": x * 260 - 130, "y": 160}})
                nodes.append({"id": "no_evidence", "type": "output", "name": "Nothing found", "config": {"value": "No evidence was retrieved for this goal, so nothing was written or sent. Check the search settings or try a different query."}, "when": {"node": gate_id, "equals": False}, "position": {"x": x * 260, "y": 320}})
                out_of["__gate"] = gate_id
            gated = {"when": {"node": gate_id, "equals": True}} if out_of.get("__gate") and any(d in evidence_ids for d in _all_deps(plan, t.id)) else {}
            instruction = t.description or t.title
            prompt = f"Goal: {plan.goal}\nTask: {t.title}. {instruction}\n" + (f"\nMaterial to use (cite as [n] where numbered):\n{evidence_refs}\n" if evidence_refs else "")
            if t.kind == "draft" and any(p.tool in ("email.send", "github.create_issue") for p in plan.tasks):
                prompt += '\nReturn JSON with keys "subject" and "body".' if any(p.tool == "email.send" for p in plan.tasks) else '\nReturn JSON with keys "title" and "body".'
                nodes.append({"id": t.id, "type": "model_call", "name": t.title, "config": {"prompt": prompt, "model": t.model or "default", "output": "json", "max_tokens": 1200}, "depends_on": deps, "retry": {"max_attempts": 2}, "position": pos, **gated})
            else:
                nodes.append({"id": t.id, "type": "model_call", "name": t.title, "config": {"prompt": prompt, "model": t.model or "default", "max_tokens": 1500}, "depends_on": deps, "retry": {"max_attempts": 2}, "position": pos, **gated})
        elif t.kind == "decide":
            nodes.append({"id": t.id, "type": "approval", "name": t.title, "config": {"message": "Review before continuing.", "show": deps}, "depends_on": deps, "position": pos})
        elif t.kind in ("act", "save", "monitor"):
            tool = t.tool or {"save": "workspace.create_item", "monitor": "radar.create_watch"}.get(t.kind, "email.send")
            tools.add(tool)
            src = next((out_of.get(d, d) for d in t.depends_on if any(n["id"] == out_of.get(d, d) and n["type"] in ("model_call", "approval") for n in nodes)), None)
            draft = next((n for n in nodes if n["type"] == "model_call" and n["config"].get("output") == "json"), None)
            body = "{{nodes.%s.output}}" % (src or (nodes[-1]["id"] if nodes else ""))
            if tool == "email.send":
                params = {"to": "{{inputs.to}}", "subject": "{{nodes.%s.output.subject}}" % draft["id"] if draft else plan.goal[:80], "body": "{{nodes.%s.output.body}}" % draft["id"] if draft else body}
            elif tool == "github.create_issue":
                params = {"repo": "{{inputs.repo}}", "title": "{{nodes.%s.output.title}}" % draft["id"] if draft else plan.goal[:80], "body": "{{nodes.%s.output.body}}" % draft["id"] if draft else body}
            elif tool == "http.post":
                params = {"url": "{{inputs.webhook}}", "body": {"text": body}}
            elif tool == "workspace.create_item":
                params = {"workspace_id": "{{inputs.workspace_id}}", "title": plan.goal[:120], "body": body}
                if "workspace_id" not in input_names:
                    inputs.append({"name": "workspace_id", "label": "Workspace", "type": "string"})
            elif tool == "radar.create_watch":
                params = {"name": t.params.get("name", plan.goal[:80]), "query": t.params.get("query", plan.goal[:200])}
            else:
                params = dict(t.params)
            needed_deps = sorted(set(deps) | ({draft["id"]} if draft and tool in ("email.send", "github.create_issue") else set()) | ({src} if src else set()))
            nodes.append({"id": t.id, "type": "action", "name": t.title, "config": {"tool": tool, "params": params}, "depends_on": needed_deps, "position": pos})
        elif t.kind == "deliver":
            src = deps[0] if deps else nodes[-1]["id"]
            nodes.append({"id": t.id, "type": "output", "name": t.title, "config": {"value": "{{nodes.%s.output}}" % src}, "depends_on": [src], "position": pos})
        out_of[t.id] = t.id
    return {
        "name": plan.goal[:80] or "New workflow",
        "description": f"Compiled from a plan ({plan.planner} planner): {plan.interpreted_as}"[:2000],
        "trigger": {"type": "manual"},
        "inputs": inputs,
        "nodes": nodes,
        "budget": {"max_cost_usd": 0.5, "max_model_calls": max(4, 2 * len([n for n in nodes if n["type"] == "model_call"]))},
        "permissions": {"tools": sorted(tools), "network_domains": sorted(domains)},
        "outputs": [n["id"] for n in nodes if n["type"] == "output"],
    }


def _all_deps(plan: Plan, tid: str) -> set[str]:
    by = {t.id: t for t in plan.tasks}
    seen: set[str] = set()
    stack = list(by[tid].depends_on) if tid in by else []
    while stack:
        d = stack.pop()
        if d in seen or d not in by:
            continue
        seen.add(d)
        stack.extend(by[d].depends_on)
    return seen
