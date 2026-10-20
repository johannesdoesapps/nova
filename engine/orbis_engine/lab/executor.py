"""Workflow execution.

Run states
    queued → running ⇄ waiting_approval → succeeded | failed | rejected | cancelled | budget_exceeded
    running → interrupted (worker/engine stopped mid-run) → running (resume)
    failed / budget_exceeded / interrupted → running (resume: re-runs only unfinished steps)

Step states
    pending → running → succeeded | failed | skipped
    running → retrying → running
    running → waiting_approval → running (approved) | failed (rejected)
    pending → blocked (an upstream step failed) | cancelled

Steps execute one at a time in topological order so runs are reproducible
and logs are easy to follow. Outputs are checkpointed after every step, which
is what makes resume-after-failure possible.
"""

from __future__ import annotations

import hashlib
import json
import threading
import time
from datetime import UTC, datetime
from typing import Any

from ..auth import Identity
from ..db import Database, approvals, now_iso, outbox, run_events, runs, workflow_versions
from ..errors import EngineError
from ..llm import complete, default_model, estimate_cost, estimate_tokens, extract_json, price_for
from ..security.content import SYSTEM_RULES, detect_sensitive, redact, scan_injection, wrap_untrusted
from ..security.policy import TOOLS, approvals_for_action, approvals_for_model_call
from . import tools_impl
from .expressions import evaluate, referenced_inputs, referenced_nodes, render
from .models import Node, WorkflowSpec
from .validate import parse_spec, topo_order

TERMINAL_RUN = {"succeeded", "failed", "rejected", "cancelled", "budget_exceeded"}
TERMINAL_STEP = {"succeeded", "failed", "skipped", "blocked", "cancelled"}
TRUST_ORDER = {"trusted": 0, "generated": 1, "untrusted": 2}

_running: set[str] = set()
_lock = threading.Lock()


class WaitForApproval(Exception):
    def __init__(self, approval_id: str):
        self.approval_id = approval_id


class BudgetExceeded(Exception):
    pass


def payload_hash(payload: Any) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()


def _parse_ts(s: str) -> float:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def worst(*levels: str) -> str:
    return max(levels or ("trusted",), key=lambda x: TRUST_ORDER[x])


class Executor:
    def __init__(self, db: Database, run_id: str, identity: Identity, *, mocks: dict[str, Any] | None = None, sleep=time.sleep):
        self.db = db
        self.run_id = run_id
        self.identity = identity
        self.mocks = mocks or {}
        self.sleep = sleep
        row = db.get(runs, id=run_id)
        if not row or row["owner_id"] != identity.sub:
            raise EngineError("not_found", "Run not found.")
        self.row = row
        ver = db.get(workflow_versions, workflow_id=row["workflow_id"], version=row["version"])
        if not ver:
            raise EngineError("not_found", "Workflow version not found.")
        self.spec: WorkflowSpec = parse_spec(ver["spec"])
        self.by = {n.id: n for n in self.spec.nodes}
        self.order = topo_order(self.spec)
        self.state: dict[str, Any] = row["state"]
        self.mode: str = row["mode"]
        self.inputs: dict[str, Any] = row["inputs"]
        self.sensitive_values = [str(self.inputs.get(i.name)) for i in self.spec.inputs if i.sensitive and self.inputs.get(i.name) not in (None, "")]

    # ─── persistence helpers ───────────────────────────────────────────────
    def log(self, type_: str, message: str, *, step: str | None = None, level: str = "info", data: Any = None) -> None:
        seq = self.db.count(run_events, {"run_id": self.run_id}) + 1
        msg = redact(message, self.sensitive_values)
        safe = json.loads(redact(json.dumps(data, default=str), self.sensitive_values)) if data is not None else None
        self.db.insert(run_events, run_id=self.run_id, seq=seq, ts=now_iso(), level=level, step_id=step, type=type_, message=msg, data=safe)

    def save(self, status: str | None = None, error: str | None = None, finished: bool = False) -> None:
        values: dict[str, Any] = {"state": self.state, "updated_at": now_iso(), "heartbeat_at": now_iso()}
        if status:
            values["status"] = status
            self.row["status"] = status
        if error is not None:
            values["error"] = error
        if finished:
            values["finished_at"] = now_iso()
        self.db.update(runs, {"id": self.run_id}, **values)

    def step(self, nid: str) -> dict[str, Any]:
        return self.state["steps"][nid]

    def cancelled(self) -> bool:
        r = self.db.get(runs, id=self.run_id)
        return bool(r and r["cancel_requested"])

    def ctx(self) -> dict[str, Any]:
        return {"inputs": self.inputs, "nodes": {k: {"output": v.get("output"), "status": v["status"]} for k, v in self.state["steps"].items()}}

    def trust_of(self, config: Any) -> str:
        return worst(*[self.step(r).get("trust", "trusted") for r in referenced_nodes(config) if r in self.state["steps"]])

    # ─── main loop ─────────────────────────────────────────────────────────
    def run(self) -> str:
        with _lock:
            if self.run_id in _running:
                return self.row["status"]
            _running.add(self.run_id)
        try:
            return self._run()
        finally:
            with _lock:
                _running.discard(self.run_id)

    def _run(self) -> str:
        if self.row["status"] in TERMINAL_RUN:
            return self.row["status"]
        if self.row["status"] != "running":
            self.log("run_started" if not self.state.get("started_at") else "run_resumed", "Run started." if not self.state.get("started_at") else "Run resumed.")
        self.state.setdefault("started_at", now_iso())
        self.save("running")
        budget = self.spec.budget
        while True:
            if self.cancelled():
                for nid in self.order:
                    if self.step(nid)["status"] not in TERMINAL_STEP:
                        self.step(nid)["status"] = "cancelled"
                self.log("run_cancelled", "Run cancelled by user.", level="warn")
                self.save("cancelled", finished=True)
                return "cancelled"
            elapsed = time.time() - _parse_ts(self.state["started_at"]) - self.state.get("paused_s", 0)
            if elapsed > budget.max_duration_s:
                return self._stop_budget(f"Time limit of {budget.max_duration_s}s reached.")
            nid = self._next_ready()
            if nid is None:
                break
            if self.state["usage"]["steps_run"] >= budget.max_steps:
                return self._stop_budget(f"Step limit of {budget.max_steps} reached.")
            try:
                self._execute(self.by[nid])
            except WaitForApproval as w:
                self.step(nid)["status"] = "waiting_approval"
                self.step(nid)["approval_id"] = w.approval_id
                self.state["waiting_since"] = now_iso()
                self.log("approval_requested", f"Waiting for approval before “{self.by[nid].name}”.", step=nid, level="warn", data={"approval_id": w.approval_id})
                self.save("waiting_approval")
                return "waiting_approval"
            except BudgetExceeded as b:
                self.step(nid)["status"] = "failed"
                self.step(nid)["error"] = str(b)
                return self._stop_budget(str(b))
            self.save()
        return self._finish()

    def _stop_budget(self, reason: str) -> str:
        for nid in self.order:
            if self.step(nid)["status"] in ("pending", "running", "retrying"):
                self.step(nid)["status"] = "cancelled"
        self.log("budget_exceeded", reason, level="error")
        self.save("budget_exceeded", error=reason, finished=True)
        return "budget_exceeded"

    def _finish(self) -> str:
        steps = self.state["steps"]
        outs = self.spec.outputs or [n.id for n in self.spec.nodes if n.type == "output"]
        self.state["outputs"] = {o: steps[o].get("output") for o in outs if steps.get(o, {}).get("status") == "succeeded"}
        if any(s.get("rejected") for s in steps.values()):
            status, err = "rejected", "An approval was rejected."
        elif any(s["status"] == "failed" for s in steps.values()):
            status, err = "failed", next(s.get("error") for s in steps.values() if s["status"] == "failed")
        else:
            status, err = "succeeded", None
        self.log("run_finished", f"Run {status}.", level="info" if status == "succeeded" else "error")
        self.save(status, error=err, finished=True)
        return status

    def _next_ready(self) -> str | None:
        steps = self.state["steps"]
        for nid in self.order:
            st = steps[nid]
            if st["status"] != "pending":
                continue
            n = self.by[nid]
            deps = list(n.depends_on) + ([n.when.node] if n.when else [])
            if any(steps[d]["status"] not in TERMINAL_STEP for d in deps):
                continue
            if any(steps[d]["status"] in ("failed", "blocked", "cancelled") for d in deps):
                st["status"] = "blocked"
                st["error"] = "An upstream step did not finish."
                self.log("step_blocked", f"“{n.name}” blocked: an upstream step did not finish.", step=nid, level="warn")
                continue
            if n.when:
                b = steps[n.when.node]
                if b["status"] == "skipped" or bool(b.get("output")) != n.when.equals:
                    st["status"] = "skipped"
                    st["skipped_reason"] = f"Branch {n.when.node} was {b.get('output')!r}."
                    self.log("step_skipped", f"“{n.name}” skipped (branch {n.when.node}).", step=nid)
                    continue
            if n.depends_on and all(steps[d]["status"] == "skipped" for d in n.depends_on):
                st["status"] = "skipped"
                st["skipped_reason"] = "All upstream steps were skipped."
                self.log("step_skipped", f"“{n.name}” skipped (all inputs skipped).", step=nid)
                continue
            return nid
        return None

    # ─── one step, with retries ────────────────────────────────────────────
    def _execute(self, n: Node) -> None:
        st = self.step(n.id)
        st["status"] = "running"
        st.setdefault("attempts", 0)
        st["started_at"] = st.get("started_at") or now_iso()
        self.save()
        while True:
            st["attempts"] += 1
            t0 = time.monotonic()
            try:
                if n.id in self.mocks:
                    out, trust = self.mocks[n.id], "trusted"
                    self.log("step_mocked", f"“{n.name}” used a test fixture.", step=n.id)
                else:
                    out, trust = self._dispatch(n)
                st.update(status="succeeded", output=out, trust=trust, finished_at=now_iso(), duration_ms=int((time.monotonic() - t0) * 1000), error=None)
                self.state["usage"]["steps_run"] += 1
                self.log("step_succeeded", f"“{n.name}” succeeded.", step=n.id, data={"trust": trust, "duration_ms": st["duration_ms"]})
                return
            except (WaitForApproval, BudgetExceeded):
                st["attempts"] -= 1
                raise
            except EngineError as e:
                can_retry = e.code in n.retry.retry_on and st["attempts"] < n.retry.max_attempts
                if can_retry and not self.cancelled():
                    delay = min(60.0, n.retry.backoff_s * (2 ** (st["attempts"] - 1)))
                    st["status"] = "retrying"
                    self.log("step_retrying", f"“{n.name}” failed ({e.code}: {e.message}); retry {st['attempts'] + 1}/{n.retry.max_attempts} in {delay:.1f}s.", step=n.id, level="warn")
                    self.save()
                    self.sleep(delay)
                    st["status"] = "running"
                    continue
                st.update(status="failed", error=f"{e.code}: {e.message}", finished_at=now_iso())
                self.state["usage"]["steps_run"] += 1
                self.log("step_failed", f"“{n.name}” failed: {e.message}", step=n.id, level="error", data={"code": e.code, "attempts": st["attempts"]})
                return
            except Exception as e:  # noqa: BLE001 - never let one step crash the engine
                st.update(status="failed", error=f"internal: {type(e).__name__}", finished_at=now_iso())
                self.log("step_failed", f"“{n.name}” failed unexpectedly ({type(e).__name__}).", step=n.id, level="error")
                return

    def _dispatch(self, n: Node) -> tuple[Any, str]:
        c = n.config
        if n.type == "input":
            return dict(self.inputs), "trusted"
        if n.type == "transform":
            return self._transform(n), self.trust_of(c)
        if n.type == "branch":
            v = bool(evaluate(c["condition"], self.ctx()))
            t = worst(*[self.step(x).get("trust", "trusted") for x in _cond_names(c["condition"]) if x in self.state["steps"]])
            if t == "untrusted":
                self.step(n.id).setdefault("flags", []).append("branch_on_untrusted")
            self.log("branch_evaluated", f"Condition {c['condition']!r} → {v}.", step=n.id)
            return v, "trusted"
        if n.type == "output":
            return render(c["value"], self.ctx()), self.trust_of(c)
        if n.type == "retrieval":
            return self._retrieval(n), "untrusted"
        if n.type == "model_call":
            return self._model_call(n)
        if n.type == "approval":
            message = render(c.get("message", "Please review before continuing."), self.ctx())
            shown = {r: self.step(r).get("output") for r in (c.get("show") or []) if r in self.state["steps"]}
            self._gate(n, [("explicit_gate", str(message))], {"message": message, "show": shown})
            return {"approved": True}, "trusted"
        if n.type == "action":
            return self._action(n)
        raise EngineError("bad_request", f"Unknown step type {n.type}.")

    # ─── approvals ─────────────────────────────────────────────────────────
    def _gate(self, n: Node, kinds: list[tuple[str, str]], payload: Any) -> None:
        """Raise WaitForApproval unless the user approved this exact payload for this step."""
        if not kinds:
            return
        h = payload_hash(payload)
        existing = self.db.select(approvals, {"run_id": self.run_id, "step_id": n.id, "payload_hash": h}, order_by="created_at", desc=True, limit=1)
        if self.mode == "test":
            self.log("approval_auto_test", f"Test mode: approval for “{n.name}” auto-granted ({', '.join(k for k, _ in kinds)}).", step=n.id)
            return
        if existing:
            a = existing[0]
            if a["status"] == "approved":
                self.log("approval_used", f"Approved by {a['decided_by']}.", step=n.id)
                return
            if a["status"] == "rejected":
                self.step(n.id)["rejected"] = True
                raise EngineError("forbidden", f"Rejected{': ' + a['note'] if a['note'] else ''}.")
            raise WaitForApproval(a["id"])
        aid = self.db.insert(
            approvals,
            id=_uuid(), run_id=self.run_id, step_id=n.id, owner_id=self.identity.sub,
            kinds=[k for k, _ in kinds], reasons=[r for _, r in kinds],
            payload=json.loads(redact(json.dumps(payload, default=str), [])), payload_hash=h,
            status="pending", created_at=now_iso(),
        )["id"]
        raise WaitForApproval(aid)

    # ─── step types ────────────────────────────────────────────────────────
    def _transform(self, n: Node) -> Any:
        c = n.config
        op = c["op"]
        if op == "template":
            return render(c.get("template", ""), self.ctx())
        val = render(c["input"], self.ctx())
        if op == "extract_json":
            j = extract_json(val if isinstance(val, str) else json.dumps(val))
            if j is None:
                raise EngineError("bad_request", "No JSON object found in the input.")
            return j
        if op == "regex_extract":
            import re

            pattern = str(c.get("pattern", ""))
            if len(pattern) > 200:
                raise EngineError("bad_request", "Pattern too long.")
            text = str(val)[:100_000]
            try:
                return [m.group(int(c.get("group", 0))) for m in re.finditer(pattern, text)][:200]
            except (re.error, IndexError) as e:
                raise EngineError("bad_request", f"Regex error: {e}") from None
        if op == "pick":
            cur = val
            for part in str(c.get("path", "")).split("."):
                if not part:
                    continue
                cur = cur.get(part) if isinstance(cur, dict) else (cur[int(part)] if isinstance(cur, list) and part.isdigit() and int(part) < len(cur) else None)
            return cur
        if op == "join":
            items = val if isinstance(val, list) else [val]
            f = c.get("field")
            fmt = c.get("format")
            parts = []
            for i, x in enumerate(items, 1):
                if fmt and isinstance(x, dict):
                    parts.append(str(fmt).replace("{n}", str(i)).format_map(_SafeDict(x)))
                else:
                    parts.append(str(x.get(f, "")) if f and isinstance(x, dict) else (x if isinstance(x, str) else json.dumps(x)))
            return str(c.get("separator", "\n")).join(parts)
        if op == "truncate":
            return str(val)[: int(c.get("max_chars", 2000))]
        if op == "count":
            return len(val) if isinstance(val, (list, dict, str)) else 0
        if op == "lowercase":
            return str(val).lower()
        if op == "split_lines":
            return [l.strip() for l in str(val).splitlines() if l.strip()]
        raise EngineError("bad_request", f"Unknown transform {op}.")

    def _retrieval(self, n: Node) -> Any:
        c = n.config
        src = c["source"]
        k = int(c.get("top_k", 5))
        if src == "web_search":
            self._require_tool("web.search")
            res = tools_impl.web_search(str(render(c["query"], self.ctx())), k, timeout_s=n.timeout_s)
            if res.get("simulated"):
                self.log("notice", res["notice"], step=n.id, level="warn")
            out = res["results"]
        elif src == "url":
            self._require_tool("http.get")
            out = [tools_impl.http_get(str(render(c["url"], self.ctx())), self.spec.permissions.network_domains, timeout_s=n.timeout_s)]
        elif src == "workspace":
            from ..workspace.service import search_items

            out = search_items(self.db, self.identity, str(render(c.get("workspace_id", ""), self.ctx())), str(render(c["query"], self.ctx())), k)
        else:
            from ..radar.service import search_items as radar_search

            out = radar_search(self.db, self.identity, str(render(c["query"], self.ctx())), k)
        findings = sorted({f for item in out for f in scan_injection(json.dumps(item, ensure_ascii=False))})
        if findings:
            self.step(n.id)["flags"] = [f"injection:{f}" for f in findings]
            self.state["injection_seen"] = True
            self.log("injection_warning", f"Retrieved content contains instruction-like text ({', '.join(findings)}). It is treated as data only.", step=n.id, level="warn")
        self.log("retrieved", f"Retrieved {len(out)} item(s) from {src}.", step=n.id)
        return out

    def _model_call(self, n: Node) -> tuple[Any, str]:
        c = n.config
        model = c.get("model") or "default"
        if model == "default":
            model = default_model()
        external = not model.startswith("demo:")
        if external and not self.spec.permissions.allow_external_models:
            raise EngineError("forbidden", "External models are disabled for this workflow.")
        trust = self.trust_of(c)

        def wrap(path: str, value: Any) -> str | None:
            parts = path.split(".")
            if parts[0] == "nodes" and self.step(parts[1]).get("trust") == "untrusted":
                text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=1)
                return wrap_untrusted(text, f"step:{parts[1]}")
            return None

        prompt = str(render(c["prompt"], self.ctx(), wrap))
        system = SYSTEM_RULES + ("\n\n" + str(render(c["system"], self.ctx())) if c.get("system") else "")
        sensitive_inputs = [i.name for i in self.spec.inputs if i.sensitive and i.name in referenced_inputs(c)]
        gates = approvals_for_model_call(external=external and self.mode == "live", sensitive_inputs=sensitive_inputs, sensitive_found=detect_sensitive(prompt), allow_sensitive=self.spec.permissions.share_sensitive_with_models)
        self._gate(n, gates, {"model": model, "prompt_preview": prompt[:1500], "sensitive_inputs": sensitive_inputs})

        max_tokens = int(c.get("max_tokens", 1200))
        u = self.state["usage"]
        b = self.spec.budget
        if u["model_calls"] + 1 > b.max_model_calls:
            raise BudgetExceeded(f"Model-call limit of {b.max_model_calls} reached.")
        est_in = estimate_tokens(system + prompt)
        if u["input_tokens"] + u["output_tokens"] + est_in + max_tokens > b.max_tokens:
            raise BudgetExceeded(f"Token limit of {b.max_tokens} would be exceeded.")
        price = price_for(model)
        if price is None:
            if b.unknown_price_policy == "block":
                raise BudgetExceeded(f"{model} has no verified price and the budget blocks unpriced models.")
        else:
            worst_case = (est_in * price[0] + max_tokens * price[1]) / 1_000_000
            if u["cost_usd"] + worst_case > b.max_cost_usd:
                raise BudgetExceeded(f"Cost limit of ${b.max_cost_usd:.2f} would be exceeded (worst case ${u['cost_usd'] + worst_case:.4f}).")
        if self.mode == "test" and model.startswith(("openai:", "huggingface:")):
            model = "demo:alpha"  # tests never call paid models
        res = complete(model, system, prompt, max_tokens=max_tokens, temperature=c.get("temperature"), json_mode=c.get("output") == "json", timeout_s=n.timeout_s)
        u["model_calls"] += 1
        u["input_tokens"] += res.input_tokens
        u["output_tokens"] += res.output_tokens
        if res.cost_usd is None:
            u["cost_unknown_calls"] += 1
        else:
            u["cost_usd"] = round(u["cost_usd"] + res.cost_usd, 8)
        self.step(n.id)["model"] = {"id": model, "served": res.served_model, "simulated": res.simulated, "input_tokens": res.input_tokens, "output_tokens": res.output_tokens, "estimated": res.tokens_estimated, "cost_usd": res.cost_usd, "latency_ms": res.latency_ms}
        self.log("model_called", f"{model} responded in {res.latency_ms} ms ({res.input_tokens}+{res.output_tokens} tokens).", step=n.id, data={"simulated": res.simulated, "cost_usd": res.cost_usd})
        out: Any = res.text
        if c.get("output") == "json":
            j = extract_json(res.text)
            if j is None:
                raise EngineError("upstream_error", "The model did not return valid JSON.")
            out = j
        # Model output is generated text; if any input was untrusted the output is too.
        return out, worst(trust, "generated")

    def _require_tool(self, tool_id: str) -> None:
        if tool_id not in self.spec.permissions.tools:
            raise EngineError("forbidden", f"Tool {tool_id} is not granted to this workflow.")
        from .service import user_granted_tools

        if tool_id not in user_granted_tools(self.db, self.identity.sub):
            raise EngineError("forbidden", f"You have not enabled the {tool_id} tool. Enable it in AI Lab → Tools.")

    def _action(self, n: Node) -> tuple[Any, str]:
        c = n.config
        tool = TOOLS.get(c.get("tool", ""))
        if not tool:
            raise EngineError("bad_request", "Unknown tool.")
        params = render(c.get("params") or {}, self.ctx())
        missing = [p for p in tool.required_params if params.get(p) in (None, "", [], {})]
        if missing:
            # Never ask a person to approve (or perform) an action with blank parameters.
            raise EngineError("bad_request", f"{tool.name} is missing {', '.join(missing)} — the step that should provide it returned nothing.")
        dry_preview = self.mode == "dry_run" and tool.risk != "read"
        if not dry_preview:
            self._require_tool(tool.id)
        trust = self.trust_of(c.get("params") or {})
        text = json.dumps(params, ensure_ascii=False, default=str)
        sensitive = detect_sensitive(text) + [f"input:{i.name}" for i in self.spec.inputs if i.sensitive and i.name in referenced_inputs(c)]
        kinds = approvals_for_action(tool, untrusted_params=trust == "untrusted", sensitive_found=sensitive)
        if tool.risk == "internal_write" and trust == "untrusted" and self.state.get("injection_seen"):
            kinds.append(("untrusted_parameters", "This write uses content that contained instruction-like text."))
        if dry_preview:
            from .service import user_granted_tools

            blockers = []
            if tool.id not in self.spec.permissions.tools:
                blockers.append("add it to this workflow's permissions")
            if tool.id not in user_granted_tools(self.db, self.identity.sub):
                blockers.append("enable it in AI Lab → Tool permissions")
            msg = f"Dry run: {tool.name} not performed."
            if kinds:
                msg += f" A live run would pause for approval ({', '.join(k for k, _ in kinds)})."
            if blockers:
                msg += f" Before a live run: {' and '.join(blockers)}."
            self.log("dry_run_action", msg, step=n.id, level="warn" if blockers else "info")
            return {"simulated": True, "tool": tool.id, "params": params, "would_require_approval": [k for k, _ in kinds], "live_run_blockers": blockers}, trust
        self._gate(n, kinds, {"tool": tool.id, "params": params})
        key = payload_hash({"run": self.run_id, "step": n.id, "params": params})
        done = self.db.get(outbox, idempotency_key=key)
        if done and done["status"] in ("performed", "simulated"):
            self.log("idempotent_skip", f"{tool.name} already done for this payload; reusing the result.", step=n.id)
            return done["result"], trust
        result, status = self._perform(tool.id, params, n)
        self.db.insert(outbox, id=_uuid(), run_id=self.run_id, step_id=n.id, owner_id=self.identity.sub, tool=tool.id, payload=params, idempotency_key=key, status=status, result=result, created_at=now_iso())
        self.log("action_" + status, f"{tool.name}: {status}.", step=n.id, level="info" if status == "performed" else "warn")
        return result, trust

    def _perform(self, tool_id: str, p: dict[str, Any], n: Node) -> tuple[Any, str]:
        if self.mode == "test":
            return {"simulated": True, "tool": tool_id}, "simulated"
        if tool_id == "web.search":
            return tools_impl.web_search(str(p["query"]), int(p.get("top_k", 5)))["results"], "performed"
        if tool_id == "http.get":
            return tools_impl.http_get(str(p["url"]), self.spec.permissions.network_domains, n.timeout_s), "performed"
        if tool_id == "http.post":
            return tools_impl.http_post(str(p["url"]), p.get("body"), self.spec.permissions.network_domains, n.timeout_s), "performed"
        if tool_id == "email.send":
            return {"simulated": True, "note": "No email provider is configured; the message was written to the outbox and not sent.", "to": p["to"], "subject": p["subject"]}, "simulated"
        if tool_id in ("workspace.search", "workspace.create_item", "workspace.delete_item"):
            from ..workspace import service as ws

            if tool_id == "workspace.search":
                return ws.search_items(self.db, self.identity, str(p["workspace_id"]), str(p["query"]), int(p.get("top_k", 5))), "performed"
            if tool_id == "workspace.create_item":
                item = ws.create_item(self.db, self.identity, str(p["workspace_id"]), {"type": p.get("type", "note"), "title": str(p["title"])[:300], "data": {"body": str(p["body"])[:100_000], "created_by_workflow": self.run_id}})
                return {"item_id": item["id"], "title": item["title"]}, "performed"
            ws.delete_item(self.db, self.identity, str(p["workspace_id"]), str(p["item_id"]))
            return {"deleted": p["item_id"]}, "performed"
        if tool_id == "radar.create_watch":
            from ..radar.service import create_watch

            w = create_watch(self.db, self.identity, {"name": str(p["name"])[:120], "query": str(p["query"])[:300], "kind": p.get("kind", "topic")})
            return {"watch_id": w["id"]}, "performed"
        if tool_id == "github.create_issue":
            from ..connectors.github import create_issue

            return create_issue(self.db, self.identity, str(p["repo"]), str(p["title"]), str(p["body"])), "performed"
        raise EngineError("bad_request", f"Tool {tool_id} has no implementation.")


class _SafeDict(dict):
    def __missing__(self, key: str) -> str:
        return ""


def _cond_names(cond: str) -> list[str]:
    from .expressions import names_in

    return sorted(names_in(cond))


def _uuid() -> str:
    import uuid

    return str(uuid.uuid4())


def initial_state(spec: WorkflowSpec) -> dict[str, Any]:
    return {
        "steps": {n.id: {"status": "pending", "attempts": 0} for n in spec.nodes},
        "usage": {"model_calls": 0, "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0, "cost_unknown_calls": 0, "steps_run": 0},
        "outputs": {},
    }
