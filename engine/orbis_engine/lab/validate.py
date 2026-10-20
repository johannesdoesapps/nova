"""Static validation of a workflow before it can be published or run."""

from __future__ import annotations

from typing import Any

from pydantic import ValidationError

from ..errors import EngineError
from ..llm import price_for
from ..security.policy import TOOLS
from .expressions import evaluate, names_in, referenced_inputs, referenced_nodes
from .models import WorkflowSpec

TRANSFORM_OPS = {"template", "extract_json", "regex_extract", "pick", "join", "truncate", "count", "lowercase", "split_lines"}
RETRIEVAL_SOURCES = {"web_search", "workspace", "radar", "url"}


def parse_spec(raw: Any) -> WorkflowSpec:
    try:
        return WorkflowSpec.model_validate(raw)
    except ValidationError as e:
        raise EngineError("bad_request", "Workflow definition is invalid.", [{"path": ".".join(str(p) for p in err["loc"]), "message": err["msg"]} for err in e.errors()[:20]]) from None


def topo_order(spec: WorkflowSpec) -> list[str]:
    ids = [n.id for n in spec.nodes]
    deps = {n.id: set(n.depends_on) | ({n.when.node} if n.when else set()) for n in spec.nodes}
    order: list[str] = []
    ready = [i for i in ids if not deps[i]]
    remaining = {i: set(d) for i, d in deps.items()}
    while ready:
        cur = ready.pop(0)
        order.append(cur)
        for i in ids:
            if cur in remaining[i]:
                remaining[i].discard(cur)
                if not remaining[i] and i not in order and i not in ready:
                    ready.append(i)
    if len(order) != len(ids):
        raise EngineError("bad_request", "The workflow has a cycle; steps must form a directed acyclic graph.")
    return order


def ancestors(spec: WorkflowSpec) -> dict[str, set[str]]:
    by = {n.id: n for n in spec.nodes}
    memo: dict[str, set[str]] = {}

    def anc(i: str) -> set[str]:
        if i in memo:
            return memo[i]
        n = by[i]
        direct = set(n.depends_on) | ({n.when.node} if n.when else set())
        out = set(direct)
        for d in direct:
            if d in by:
                out |= anc(d)
        memo[i] = out
        return out

    return {i: anc(i) for i in by}


def validate(spec: WorkflowSpec) -> dict[str, Any]:
    errors: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []
    by = {}
    for n in spec.nodes:
        if n.id in by:
            errors.append({"node": n.id, "message": "Duplicate step id."})
        by[n.id] = n
    input_names = {i.name for i in spec.inputs}
    for n in spec.nodes:
        for d in n.depends_on:
            if d not in by:
                errors.append({"node": n.id, "message": f"Depends on unknown step {d!r}."})
        if n.when and (n.when.node not in by or by[n.when.node].type != "branch"):
            errors.append({"node": n.id, "message": "`when` must point at a branch step."})
    if errors:
        return {"valid": False, "errors": errors, "warnings": warnings, "order": [], "estimate": None}
    try:
        order = topo_order(spec)
    except EngineError as e:
        return {"valid": False, "errors": [{"node": "", "message": e.message}], "warnings": warnings, "order": [], "estimate": None}
    anc = ancestors(spec)

    model_calls = 0
    token_cap = 0
    unknown_price = False
    max_cost = 0.0
    consequential: list[str] = []
    for n in spec.nodes:
        c = n.config
        for ref in referenced_nodes(c):
            if ref not in by:
                errors.append({"node": n.id, "message": f"References unknown step {ref!r}."})
            elif ref not in anc[n.id]:
                errors.append({"node": n.id, "message": f"Uses output of {ref!r} but does not depend on it (add it to depends_on)."})
        for ref in referenced_inputs(c):
            if ref not in input_names:
                errors.append({"node": n.id, "message": f"References unknown input {ref!r}."})
        if n.type == "model_call":
            if not isinstance(c.get("prompt"), str) or not c["prompt"].strip():
                errors.append({"node": n.id, "message": "A model call needs a prompt."})
            mt = int(c.get("max_tokens", 1200))
            if not 1 <= mt <= 8000:
                errors.append({"node": n.id, "message": "max_tokens must be 1–8000."})
            if c.get("output", "text") not in ("text", "json"):
                errors.append({"node": n.id, "message": "output must be text or json."})
            model = c.get("model") or "default"
            if model != "default" and not spec.permissions.allow_external_models and not str(model).startswith("demo:"):
                errors.append({"node": n.id, "message": "External models are disabled in this workflow's permissions."})
            model_calls += n.retry.max_attempts
            token_cap += mt * n.retry.max_attempts
            p = price_for(model) if model != "default" else None
            if p is None:
                unknown_price = True
            else:
                max_cost += (mt * p[1] + 4000 * p[0]) / 1_000_000 * n.retry.max_attempts
        elif n.type == "retrieval":
            src = c.get("source")
            if src not in RETRIEVAL_SOURCES:
                errors.append({"node": n.id, "message": f"source must be one of {sorted(RETRIEVAL_SOURCES)}."})
            if src == "web_search" and "web.search" not in spec.permissions.tools:
                errors.append({"node": n.id, "message": "Web search needs the web.search tool in permissions."})
            if src == "url":
                if "http.get" not in spec.permissions.tools:
                    errors.append({"node": n.id, "message": "URL fetch needs the http.get tool in permissions."})
                if not spec.permissions.network_domains:
                    errors.append({"node": n.id, "message": "URL fetch needs at least one allowed network domain."})
            if src in ("web_search", "workspace", "radar") and not c.get("query"):
                errors.append({"node": n.id, "message": "Retrieval needs a query."})
            if src == "url" and not c.get("url"):
                errors.append({"node": n.id, "message": "URL fetch needs a url."})
            if not 1 <= int(c.get("top_k", 5)) <= 10:
                errors.append({"node": n.id, "message": "top_k must be 1–10."})
        elif n.type == "transform":
            if c.get("op") not in TRANSFORM_OPS:
                errors.append({"node": n.id, "message": f"op must be one of {sorted(TRANSFORM_OPS)}."})
            if "input" not in c and c.get("op") != "template":
                errors.append({"node": n.id, "message": "Transform needs an input."})
        elif n.type == "branch":
            cond = c.get("condition")
            if not isinstance(cond, str) or not cond.strip():
                errors.append({"node": n.id, "message": "Branch needs a condition."})
            else:
                try:
                    evaluate(cond, {"inputs": {}, "nodes": {}})
                except EngineError as e:
                    if "disallowed" in e.message or "Invalid" in e.message or "Only" in e.message:
                        errors.append({"node": n.id, "message": e.message})
                for name in names_in(cond):
                    if name not in by:
                        errors.append({"node": n.id, "message": f"Condition references unknown step {name!r}."})
                    elif name not in anc[n.id]:
                        errors.append({"node": n.id, "message": f"Condition uses {name!r}; add it to depends_on."})
        elif n.type == "action":
            tool = TOOLS.get(str(c.get("tool")))
            if not tool:
                errors.append({"node": n.id, "message": f"Unknown tool {c.get('tool')!r}."})
                continue
            if tool.id not in spec.permissions.tools:
                errors.append({"node": n.id, "message": f"Tool {tool.id} is not granted in this workflow's permissions."})
            params = c.get("params") or {}
            for p in tool.required_params:
                if p not in params:
                    errors.append({"node": n.id, "message": f"{tool.id} needs parameter {p!r}."})
            if tool.consequential:
                consequential.append(n.id)
                if not any(by[a].type == "approval" for a in anc[n.id]):
                    warnings.append({"node": n.id, "message": f"{tool.name} is consequential: ORBIS AI will pause for your approval before it runs."})
            if tool.id in ("http.get", "http.post") and not spec.permissions.network_domains:
                errors.append({"node": n.id, "message": "HTTP tools need allowed network domains."})
        elif n.type == "output":
            if "value" not in c:
                errors.append({"node": n.id, "message": "Output needs a value."})
    for o in spec.outputs:
        if o not in by:
            errors.append({"node": o, "message": "Declared output step does not exist."})
    if spec.trigger.type in ("schedule", "radar_signal") and consequential:
        warnings.append({"node": "", "message": "Unattended triggers will stop at each consequential step until someone approves it."})
    if model_calls > spec.budget.max_model_calls:
        warnings.append({"node": "", "message": f"Up to {model_calls} model calls (with retries) exceed the budget of {spec.budget.max_model_calls}; the run will stop when it is reached."})
    if unknown_price:
        warnings.append({"node": "", "message": "Some model prices are not verified, so the cost limit can't be enforced exactly; the model-call and token limits still apply." if spec.budget.unknown_price_policy == "allow_with_call_limit" else "Some model prices are unknown and the budget policy blocks unpriced models."})
    return {
        "valid": not errors,
        "errors": errors,
        "warnings": warnings,
        "order": order,
        "estimate": {
            "model_calls_max": model_calls,
            "output_tokens_max": token_cap,
            "cost_usd_max": None if unknown_price else round(max_cost, 4),
            "consequential_steps": consequential,
        },
    }
