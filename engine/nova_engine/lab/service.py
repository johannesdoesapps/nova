"""AI Lab persistence and orchestration: workflows, versions, runs, approvals, tests, tool grants."""

from __future__ import annotations

import difflib
import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from ..auth import Identity
from ..db import Database, approvals, now_iso, new_id, outbox, run_events, runs, tool_grants, workflow_versions, workflows
from ..errors import EngineError
from ..security.policy import TOOLS
from .executor import TERMINAL_RUN, Executor, initial_state
from .models import WorkflowSpec, WorkflowTestCase
from .validate import parse_spec, validate

_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="nova-run")
_sync = {"on": False}


def run_synchronously(flag: bool) -> None:
    """Tests run executors inline instead of on the thread pool."""
    _sync["on"] = flag


def spec_hash(spec: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(spec, sort_keys=True).encode()).hexdigest()


# ─── tool grants ────────────────────────────────────────────────────────────
def user_granted_tools(db: Database, user_id: str) -> set[str]:
    explicit = {r["tool"] for r in db.select(tool_grants, {"user_id": user_id})}
    defaults = {t.id for t in TOOLS.values() if t.default_granted}
    revoked = {t[1:] for t in explicit if t.startswith("-")}
    return (defaults | {t for t in explicit if not t.startswith("-")}) - revoked


def set_tool_grant(db: Database, ident: Identity, tool_id: str, granted: bool) -> set[str]:
    if tool_id not in TOOLS:
        raise EngineError("bad_request", "Unknown tool.")
    db.delete(tool_grants, user_id=ident.sub, tool=tool_id)
    db.delete(tool_grants, user_id=ident.sub, tool="-" + tool_id)
    db.insert(tool_grants, user_id=ident.sub, tool=tool_id if granted else "-" + tool_id, granted_at=now_iso())
    db.audit(ident.sub, "tool_grant" if granted else "tool_revoke", owner_id=ident.sub, target=tool_id)
    return user_granted_tools(db, ident.sub)


# ─── workflows & versions ───────────────────────────────────────────────────
def _own_workflow(db: Database, ident: Identity, wid: str) -> dict[str, Any]:
    w = db.get(workflows, id=wid)
    if not w or w["owner_id"] != ident.sub:
        raise EngineError("not_found", "Workflow not found.")
    return w


def create_workflow(db: Database, ident: Identity, spec_raw: dict[str, Any], template_id: str | None = None) -> dict[str, Any]:
    spec = parse_spec(spec_raw)
    if db.count(workflows, {"owner_id": ident.sub}) >= 200:
        raise EngineError("rate_limited", "Workflow limit reached (200).")
    now = now_iso()
    row = db.insert(workflows, id=new_id(), owner_id=ident.sub, name=spec.name, status="draft", latest_version=0, draft=spec.model_dump(), tests=[], template_id=template_id, created_at=now, updated_at=now)
    db.audit(ident.sub, "workflow_create", owner_id=ident.sub, target=row["id"])
    return row


def update_draft(db: Database, ident: Identity, wid: str, spec_raw: dict[str, Any], tests: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    w = _own_workflow(db, ident, wid)
    spec = parse_spec(spec_raw)
    values: dict[str, Any] = {"draft": spec.model_dump(), "name": spec.name, "updated_at": now_iso()}
    if tests is not None:
        values["tests"] = [WorkflowTestCase.model_validate(t).model_dump() for t in tests][:50]
    db.update(workflows, {"id": wid}, **values)
    return {**w, **values}


def get_workflow(db: Database, ident: Identity, wid: str) -> dict[str, Any]:
    w = _own_workflow(db, ident, wid)
    w["versions"] = [{k: v[k] for k in ("version", "spec_hash", "changelog", "created_at")} for v in db.select(workflow_versions, {"workflow_id": wid}, order_by="version", desc=True)]
    w["validation"] = validate(parse_spec(w["draft"]))
    w["draft_changed"] = not w["versions"] or spec_hash(w["draft"]) != w["versions"][0]["spec_hash"]
    return w


def list_workflows(db: Database, ident: Identity) -> list[dict[str, Any]]:
    return [{k: w[k] for k in ("id", "name", "status", "latest_version", "updated_at", "template_id")} for w in db.select(workflows, {"owner_id": ident.sub}, order_by="updated_at", desc=True, limit=200)]


def delete_workflow(db: Database, ident: Identity, wid: str) -> None:
    _own_workflow(db, ident, wid)
    active = [r for r in db.select(runs, {"workflow_id": wid}) if r["status"] not in TERMINAL_RUN]
    if active:
        raise EngineError("conflict", "Cancel active runs before deleting this workflow.")
    db.update(workflows, {"id": wid}, status="archived", updated_at=now_iso())
    db.audit(ident.sub, "workflow_archive", owner_id=ident.sub, target=wid)


def publish(db: Database, ident: Identity, wid: str, changelog: str = "") -> dict[str, Any]:
    w = _own_workflow(db, ident, wid)
    spec = parse_spec(w["draft"])
    v = validate(spec)
    if not v["valid"]:
        raise EngineError("bad_request", "Fix validation errors before publishing.", v["errors"])
    if w["tests"]:
        results = run_tests(db, ident, wid, use_draft=True)
        if not all(r["passed"] for r in results["results"]):
            raise EngineError("bad_request", "Workflow tests must pass before publishing.", results)
    h = spec_hash(w["draft"])
    latest = db.get(workflow_versions, workflow_id=wid, version=w["latest_version"]) if w["latest_version"] else None
    if latest and latest["spec_hash"] == h:
        return {"version": w["latest_version"], "unchanged": True}
    ver = w["latest_version"] + 1
    db.insert(workflow_versions, workflow_id=wid, version=ver, spec=w["draft"], spec_hash=h, changelog=changelog[:500] or None, created_by=ident.sub, created_at=now_iso())
    db.update(workflows, {"id": wid}, latest_version=ver, status="published", updated_at=now_iso())
    db.audit(ident.sub, "workflow_publish", owner_id=ident.sub, target=f"{wid}@{ver}")
    return {"version": ver, "unchanged": False}


def get_version(db: Database, ident: Identity, wid: str, version: int) -> dict[str, Any]:
    _own_workflow(db, ident, wid)
    v = db.get(workflow_versions, workflow_id=wid, version=version)
    if not v:
        raise EngineError("not_found", "Version not found.")
    return v


def diff_versions(db: Database, ident: Identity, wid: str, a: int, b: int) -> dict[str, Any]:
    va, vb = get_version(db, ident, wid, a)["spec"], get_version(db, ident, wid, b)["spec"]
    na, nb = {n["id"]: n for n in va["nodes"]}, {n["id"]: n for n in vb["nodes"]}
    text = "\n".join(difflib.unified_diff(json.dumps(va, indent=2, sort_keys=True).splitlines(), json.dumps(vb, indent=2, sort_keys=True).splitlines(), f"v{a}", f"v{b}", lineterm=""))
    return {
        "added": sorted(set(nb) - set(na)),
        "removed": sorted(set(na) - set(nb)),
        "changed": sorted(i for i in set(na) & set(nb) if na[i] != nb[i]),
        "settings_changed": [k for k in ("budget", "permissions", "trigger", "inputs", "outputs") if va.get(k) != vb.get(k)],
        "unified": text[:50_000],
    }


# ─── runs ───────────────────────────────────────────────────────────────────
def _coerce_inputs(spec: WorkflowSpec, given: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for i in spec.inputs:
        v = given.get(i.name, i.default)
        if v in (None, "") and i.required:
            raise EngineError("bad_request", f"Input {i.name!r} is required.")
        if v not in (None, ""):
            try:
                if i.type == "number":
                    v = float(v)
                elif i.type == "boolean":
                    v = v if isinstance(v, bool) else str(v).lower() in ("1", "true", "yes", "on")
                elif i.type == "json" and isinstance(v, str):
                    v = json.loads(v)
                else:
                    v = str(v)[:100_000]
            except (ValueError, TypeError):
                raise EngineError("bad_request", f"Input {i.name!r} is not a valid {i.type}.") from None
        out[i.name] = v
    return out


def start_run(db: Database, ident: Identity, wid: str, inputs: dict[str, Any], mode: str = "live", version: int | None = None, wait: bool = False) -> dict[str, Any]:
    w = _own_workflow(db, ident, wid)
    if w["status"] == "archived":
        raise EngineError("conflict", "This workflow is archived.")
    if mode not in ("live", "dry_run"):
        raise EngineError("bad_request", "mode must be live or dry_run.")
    if version is None and mode == "live" and not w["latest_version"]:
        # Live runs always pin an immutable published version; publishing is the user's explicit step.
        raise EngineError("conflict", "Publish the workflow before running it live (or start a dry run, which publishes nothing).")
    if mode == "dry_run" and version is None and (not w["latest_version"] or spec_hash(w["draft"]) != db.get(workflow_versions, workflow_id=wid, version=w["latest_version"])["spec_hash"]):
        version = _snapshot_draft(db, ident, w)
    version = version or w["latest_version"]
    v = db.get(workflow_versions, workflow_id=wid, version=version)
    if not v:
        raise EngineError("not_found", "Version not found.")
    spec = parse_spec(v["spec"])
    active = db.count(runs, {"owner_id": ident.sub, "status": ["queued", "running"]})
    if active >= 5:
        raise EngineError("rate_limited", "You already have 5 active runs. Wait for one to finish or cancel it.")
    now = now_iso()
    row = db.insert(runs, id=new_id(), workflow_id=wid, version=version, owner_id=ident.sub, status="queued", mode=mode, inputs=_coerce_inputs(spec, inputs), state=initial_state(spec), cancel_requested=False, created_at=now, updated_at=now)
    db.audit(ident.sub, "run_start", owner_id=ident.sub, target=row["id"], data={"workflow": wid, "version": version, "mode": mode})
    _launch(db, ident, row["id"], wait)
    return get_run(db, ident, row["id"])


def _snapshot_draft(db: Database, ident: Identity, w: dict[str, Any]) -> int:
    """Dry runs of an unpublished draft run against an immutable 'draft snapshot' version (negative numbers)."""
    spec = parse_spec(w["draft"])
    if not validate(spec)["valid"]:
        raise EngineError("bad_request", "Fix validation errors before a dry run.", validate(spec)["errors"])
    existing = [r["version"] for r in db.select(workflow_versions, {"workflow_id": w["id"]}) if r["version"] < 0]
    ver = min(existing, default=0) - 1
    db.insert(workflow_versions, workflow_id=w["id"], version=ver, spec=w["draft"], spec_hash=spec_hash(w["draft"]), changelog="draft snapshot (dry run)", created_by=ident.sub, created_at=now_iso())
    return ver


def _launch(db: Database, ident: Identity, run_id: str, wait: bool = False, mocks: dict[str, Any] | None = None, sleep=None) -> None:
    def go() -> None:
        kw = {"mocks": mocks}
        if sleep:
            kw["sleep"] = sleep
        Executor(db, run_id, ident, **kw).run()

    if wait or _sync["on"]:
        go()
    else:
        _pool.submit(go)


def get_run(db: Database, ident: Identity, run_id: str) -> dict[str, Any]:
    r = db.get(runs, id=run_id)
    if not r or r["owner_id"] != ident.sub:
        raise EngineError("not_found", "Run not found.")
    v = db.get(workflow_versions, workflow_id=r["workflow_id"], version=r["version"])
    r["spec"] = v["spec"] if v else None
    r["events"] = db.select(run_events, {"run_id": run_id}, order_by="seq")
    r["approvals"] = db.select(approvals, {"run_id": run_id}, order_by="created_at")
    r["outbox"] = db.select(outbox, {"run_id": run_id}, order_by="created_at")
    return r


def list_runs(db: Database, ident: Identity, workflow_id: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
    where: dict[str, Any] = {"owner_id": ident.sub}
    if workflow_id:
        where["workflow_id"] = workflow_id
    rows = db.select(runs, where, order_by="created_at", desc=True, limit=limit)
    names = {w["id"]: w["name"] for w in db.select(workflows, {"owner_id": ident.sub})}
    return [{"id": r["id"], "workflow_id": r["workflow_id"], "workflow_name": names.get(r["workflow_id"], "?"), "version": r["version"], "status": r["status"], "mode": r["mode"], "created_at": r["created_at"], "finished_at": r["finished_at"], "usage": r["state"].get("usage"), "error": r["error"]} for r in rows]


def cancel_run(db: Database, ident: Identity, run_id: str) -> dict[str, Any]:
    r = get_run(db, ident, run_id)
    if r["status"] in TERMINAL_RUN:
        return r
    db.update(runs, {"id": run_id}, cancel_requested=True, updated_at=now_iso())
    db.audit(ident.sub, "run_cancel", owner_id=ident.sub, target=run_id)
    if r["status"] in ("waiting_approval", "queued", "interrupted"):
        # Nothing is executing; finish the cancellation now.
        for a in db.select(approvals, {"run_id": run_id, "status": "pending"}):
            db.update(approvals, {"id": a["id"]}, status="rejected", decided_by="system", decided_at=now_iso(), note="Run cancelled.")
        Executor(db, run_id, ident).run()
    return get_run(db, ident, run_id)


def resume_run(db: Database, ident: Identity, run_id: str, wait: bool = False) -> dict[str, Any]:
    r = get_run(db, ident, run_id)
    if r["status"] not in ("failed", "interrupted", "budget_exceeded"):
        raise EngineError("conflict", f"A {r['status']} run cannot be resumed.")
    state = r["state"]
    reset = []
    for sid, st in state["steps"].items():
        if st["status"] in ("failed", "blocked", "cancelled", "running", "retrying"):
            st.update(status="pending", error=None, attempts=0)
            st.pop("rejected", None)
            reset.append(sid)
    state["started_at"] = now_iso()  # budget clock restarts; spend so far still counts
    db.update(runs, {"id": run_id}, status="queued", state=state, error=None, finished_at=None, cancel_requested=False, updated_at=now_iso())
    Executor(db, run_id, ident).log("run_recovery", f"Resuming from checkpoint; re-running {len(reset)} step(s): {', '.join(reset) or 'none'}. Completed steps keep their saved outputs.")
    _launch(db, ident, run_id, wait)
    return get_run(db, ident, run_id)


def list_approvals(db: Database, ident: Identity, status: str | None = "pending") -> list[dict[str, Any]]:
    where: dict[str, Any] = {"owner_id": ident.sub}
    if status:
        where["status"] = status
    rows = db.select(approvals, where, order_by="created_at", desc=True, limit=100)
    return rows


def decide_approval(db: Database, ident: Identity, approval_id: str, approve: bool, note: str | None = None, wait: bool = False) -> dict[str, Any]:
    a = db.get(approvals, id=approval_id)
    if not a or a["owner_id"] != ident.sub:
        raise EngineError("not_found", "Approval not found.")
    if a["status"] != "pending":
        raise EngineError("conflict", f"This approval was already {a['status']}.")
    run = db.get(runs, id=a["run_id"])
    if not run or run["status"] != "waiting_approval":
        raise EngineError("conflict", "The run is no longer waiting for this approval.")
    db.update(approvals, {"id": approval_id}, status="approved" if approve else "rejected", decided_by=ident.sub, decided_at=now_iso(), note=(note or "")[:1000] or None)
    db.audit(ident.sub, "approval_" + ("approve" if approve else "reject"), owner_id=ident.sub, target=approval_id, data={"kinds": a["kinds"], "payload_hash": a["payload_hash"]})
    state = run["state"]
    step = state["steps"][a["step_id"]]
    step["status"] = "pending"
    if state.get("waiting_since"):
        from .executor import _parse_ts
        import time

        state["paused_s"] = state.get("paused_s", 0) + max(0, time.time() - _parse_ts(state.pop("waiting_since")))
    db.update(runs, {"id": run["id"]}, status="queued", state=state, updated_at=now_iso())
    _launch(db, ident, run["id"], wait)
    return get_run(db, ident, run["id"])


# ─── tests ──────────────────────────────────────────────────────────────────
def run_tests(db: Database, ident: Identity, wid: str, use_draft: bool = True, sleep=None) -> dict[str, Any]:
    w = _own_workflow(db, ident, wid)
    cases = [WorkflowTestCase.model_validate(t) for t in w["tests"]]
    if not cases:
        return {"results": [], "summary": "No test cases defined."}
    spec = parse_spec(w["draft"] if use_draft else get_version(db, ident, wid, w["latest_version"])["spec"])
    ver = -(10_000 + db.count(workflow_versions, {"workflow_id": wid}))
    db.insert(workflow_versions, workflow_id=wid, version=ver, spec=spec.model_dump(), spec_hash=spec_hash(spec.model_dump()), changelog="test snapshot", created_by=ident.sub, created_at=now_iso())
    results = []
    for case in cases:
        now = now_iso()
        try:
            inputs = _coerce_inputs(spec, case.inputs)
        except EngineError as e:
            results.append({"name": case.name, "passed": False, "checks": [{"ok": False, "message": e.message}], "run_id": None})
            continue
        rid = db.insert(runs, id=new_id(), workflow_id=wid, version=ver, owner_id=ident.sub, status="queued", mode="test", inputs=inputs, state=initial_state(spec), cancel_requested=False, created_at=now, updated_at=now)["id"]
        Executor(db, rid, ident, mocks=case.mocks, sleep=sleep or (lambda _s: None)).run()
        r = db.get(runs, id=rid)
        checks = [_check(e, r) for e in case.expect] or [{"ok": r["status"] == "succeeded", "message": f"Run {r['status']}."}]
        results.append({"name": case.name, "passed": all(c["ok"] for c in checks), "checks": checks, "run_id": rid, "status": r["status"]})
    return {"results": results, "summary": f"{sum(r['passed'] for r in results)}/{len(results)} passed."}


def _check(e: dict[str, Any], run: dict[str, Any]) -> dict[str, Any]:
    import re

    node, op, val = e.get("node"), e.get("op", "equals"), e.get("value")
    if node == "$run" or op == "run_status":
        ok = run["status"] == val
        return {"ok": ok, "message": f"run status {run['status']!r} {'=' if ok else '≠'} {val!r}"}
    st = run["state"]["steps"].get(node)
    if not st:
        return {"ok": False, "message": f"Unknown step {node!r}."}
    out = st.get("output")
    if op == "status":
        ok = st["status"] == val
    elif op == "equals":
        ok = out == val
    elif op == "contains":
        ok = str(val).lower() in (json.dumps(out) if not isinstance(out, str) else out).lower()
    elif op == "matches":
        ok = bool(re.search(str(val), out if isinstance(out, str) else json.dumps(out)))
    elif op == "exists":
        ok = out not in (None, "", [], {})
    else:
        return {"ok": False, "message": f"Unknown op {op!r}."}
    return {"ok": ok, "message": f"{node} {op} {val!r}: {'pass' if ok else 'fail'} (status {st['status']})"}
