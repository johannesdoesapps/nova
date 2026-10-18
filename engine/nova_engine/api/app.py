"""HTTP API for the NOVA AI engine.

Only the Next.js server calls this API (never the browser directly): requests
must carry a signed X-Nova-Identity header. Every handler scopes data to that
identity; workspace handlers additionally enforce role permissions.
"""

from __future__ import annotations

import logging
import time
import uuid
from collections import defaultdict
from typing import Any

from fastapi import Body, Depends, FastAPI, Header, Query, Request
from fastapi.responses import JSONResponse

from .. import __version__
from ..auth import Identity, verify_identity
from ..config import settings
from ..connectors import service as conn
from ..connectors.registry import catalog
from ..db import Database, get_db
from ..errors import EngineError
from ..lab import planner, service as lab
from ..lab.models import NODE_TYPES
from ..lab.templates import list_templates, template_spec
from ..lab.validate import parse_spec, validate
from ..llm import available_models
from ..radar import service as radar
from ..radar.analyze import LABEL_HELP, OPPORTUNITY_TYPES, SENSITIVITY_THRESHOLD
from ..radar.sources import SOURCE_TYPES
from ..security.policy import APPROVAL_KINDS, TOOLS
from ..workspace import community, portability, service as ws
from ..workspace.permissions import matrix

log = logging.getLogger("nova.api")


class RateLimiter:
    """Per-identity token bucket (in-memory, per instance — replace with Redis/Postgres for multi-instance)."""

    def __init__(self, per_minute: int = 120):
        self.rate = per_minute / 60
        self.cap = per_minute
        self.state: dict[str, tuple[float, float]] = defaultdict(lambda: (float(per_minute), time.monotonic()))

    def take(self, key: str, cost: float = 1) -> bool:
        tokens, last = self.state[key]
        now = time.monotonic()
        tokens = min(self.cap, tokens + (now - last) * self.rate)
        if tokens < cost:
            self.state[key] = (tokens, now)
            return False
        self.state[key] = (tokens - cost, now)
        return True


limiter = RateLimiter()


def db_dep() -> Database:
    return get_db()


def ident_dep(request: Request, x_nova_identity: str | None = Header(default=None)) -> Identity:
    ident = verify_identity(x_nova_identity)
    cost = 5 if request.method != "GET" else 1
    if not limiter.take(ident.sub, cost):
        raise EngineError("rate_limited", "Too many requests. Please slow down.")
    return ident


def create_app() -> FastAPI:
    app = FastAPI(title="NOVA AI engine", version=__version__, docs_url="/docs", redoc_url=None)

    @app.middleware("http")
    async def guard(request: Request, call_next):
        rid = request.headers.get("x-request-id") or str(uuid.uuid4())
        length = int(request.headers.get("content-length") or 0)
        if length > settings().max_body_bytes and not request.url.path.endswith("/import"):
            return JSONResponse({"error": {"code": "payload_too_large", "message": "Request body too large."}}, status_code=413, headers={"x-request-id": rid})
        started = time.monotonic()
        response = await call_next(request)
        response.headers["x-request-id"] = rid
        log.info("%s %s %s %.0fms rid=%s", request.method, request.url.path, response.status_code, (time.monotonic() - started) * 1000, rid)
        return response

    @app.exception_handler(EngineError)
    async def engine_error(_: Request, e: EngineError):
        return JSONResponse({"error": {"code": e.code, "message": e.message, "details": e.details}}, status_code=e.status)

    @app.exception_handler(Exception)
    async def unexpected(_: Request, e: Exception):
        log.exception("unhandled error")
        return JSONResponse({"error": {"code": "internal", "message": "Something went wrong in the engine."}}, status_code=500)

    # ─── meta ───────────────────────────────────────────────────────────────
    @app.get("/health")
    def health(db: Database = Depends(db_dep)) -> dict[str, Any]:
        s = settings()
        return {
            "ok": True,
            "version": __version__,
            "database": "postgres" if s.database_url.startswith("postgres") else "sqlite",
            "identity": "signed" if s.engine_secret else ("dev-insecure" if s.dev_insecure_identity else "unconfigured"),
            "models": available_models(),
            "web_search": bool(s.search_key),
            "token_encryption": "configured" if s.token_keys else "ephemeral (dev)",
            "worker": radar.worker_status(db),
        }

    # ─── AI Lab ─────────────────────────────────────────────────────────────
    @app.get("/lab/catalog")
    def lab_catalog(ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)) -> dict[str, Any]:
        granted = lab.user_granted_tools(db, ident.sub)
        return {
            "node_types": NODE_TYPES,
            "tools": [{"id": t.id, "name": t.name, "description": t.description, "risk": t.risk, "data_egress": t.data_egress, "consequential": t.consequential, "required_params": t.required_params, "connector": t.connector, "implementation": t.implementation, "notes": t.notes, "granted": t.id in granted} for t in TOOLS.values()],
            "approval_kinds": APPROVAL_KINDS,
            "models": available_models(),
            "templates": list_templates(),
        }

    @app.put("/lab/tools/{tool_id}")
    def lab_grant(tool_id: str, body: dict = Body(...), ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return {"granted": sorted(lab.set_tool_grant(db, ident, tool_id, bool(body.get("granted"))))}

    @app.post("/lab/plan")
    def lab_plan(body: dict = Body(...), ident: Identity = Depends(ident_dep)):
        goal = str(body.get("goal", "")).strip()
        if not 5 <= len(goal) <= 4000:
            raise EngineError("bad_request", "Describe the goal in 5–4000 characters.")
        return planner.make_plan(goal, use_model=bool(body.get("use_model")), model=body.get("model")).model_dump()

    @app.post("/lab/plan/review")
    def lab_plan_review(body: dict = Body(...), ident: Identity = Depends(ident_dep)):
        """Re-apply policy and estimates after the user edits a plan."""
        try:
            plan = planner.Plan.model_validate(body)
        except Exception as e:  # noqa: BLE001
            raise EngineError("bad_request", f"Plan is invalid: {e}") from None
        return planner.finalize(plan).model_dump()

    @app.post("/lab/plan/compile")
    def lab_compile(body: dict = Body(...), ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        plan = planner.finalize(planner.Plan.model_validate(body.get("plan", body)))
        spec = planner.compile_plan(plan)
        w = lab.create_workflow(db, ident, spec)
        return {"workflow_id": w["id"], "spec": spec, "validation": validate(parse_spec(spec))}

    @app.post("/lab/validate")
    def lab_validate(body: dict = Body(...), ident: Identity = Depends(ident_dep)):
        return validate(parse_spec(body))

    @app.get("/lab/workflows")
    def lab_list(ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return {"workflows": lab.list_workflows(db, ident)}

    @app.post("/lab/workflows")
    def lab_create(body: dict = Body(...), ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        if body.get("template_id"):
            spec = template_spec(str(body["template_id"]))
            if not spec:
                raise EngineError("not_found", "Template not found.")
            return lab.create_workflow(db, ident, spec, template_id=str(body["template_id"]))
        return lab.create_workflow(db, ident, body.get("spec", body))

    @app.get("/lab/workflows/{wid}")
    def lab_get(wid: str, ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return lab.get_workflow(db, ident, wid)

    @app.put("/lab/workflows/{wid}")
    def lab_update(wid: str, body: dict = Body(...), ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        lab.update_draft(db, ident, wid, body["spec"], body.get("tests"))
        return lab.get_workflow(db, ident, wid)

    @app.delete("/lab/workflows/{wid}")
    def lab_delete(wid: str, ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        lab.delete_workflow(db, ident, wid)
        return {"ok": True}

    @app.post("/lab/workflows/{wid}/publish")
    def lab_publish(wid: str, body: dict = Body(default={}), ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return lab.publish(db, ident, wid, str(body.get("changelog", "")))

    @app.get("/lab/workflows/{wid}/versions/{v}")
    def lab_version(wid: str, v: int, ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return lab.get_version(db, ident, wid, v)

    @app.get("/lab/workflows/{wid}/diff")
    def lab_diff(wid: str, a: int, b: int, ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return lab.diff_versions(db, ident, wid, a, b)

    @app.post("/lab/workflows/{wid}/test")
    def lab_test(wid: str, ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return lab.run_tests(db, ident, wid)

    @app.post("/lab/workflows/{wid}/runs")
    def lab_run(wid: str, body: dict = Body(default={}), ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return lab.start_run(db, ident, wid, body.get("inputs") or {}, mode=body.get("mode", "live"), version=body.get("version"))

    @app.get("/lab/runs")
    def lab_runs(workflow_id: str | None = None, ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return {"runs": lab.list_runs(db, ident, workflow_id)}

    @app.get("/lab/runs/{rid}")
    def lab_run_get(rid: str, ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return lab.get_run(db, ident, rid)

    @app.post("/lab/runs/{rid}/cancel")
    def lab_cancel(rid: str, ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return lab.cancel_run(db, ident, rid)

    @app.post("/lab/runs/{rid}/resume")
    def lab_resume(rid: str, ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return lab.resume_run(db, ident, rid)

    @app.get("/lab/approvals")
    def lab_approvals(status: str | None = "pending", ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return {"approvals": lab.list_approvals(db, ident, status or None)}

    @app.post("/lab/approvals/{aid}")
    def lab_decide(aid: str, body: dict = Body(...), ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        if body.get("decision") not in ("approve", "reject"):
            raise EngineError("bad_request", "decision must be approve or reject.")
        return lab.decide_approval(db, ident, aid, body["decision"] == "approve", body.get("note"))

    # ─── Radar ──────────────────────────────────────────────────────────────
    @app.get("/radar/meta")
    def radar_meta(db: Database = Depends(db_dep), ident: Identity = Depends(ident_dep)):
        return {"source_types": SOURCE_TYPES, "labels": LABEL_HELP, "sensitivity": SENSITIVITY_THRESHOLD, "opportunity_types": list(OPPORTUNITY_TYPES), "frequencies": list(radar.FREQUENCIES), "kinds": radar.WATCH_KINDS, "status": radar.worker_status(db), "web_search_configured": bool(settings().search_key)}

    @app.get("/radar/watches")
    def radar_watches(ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return {"watches": radar.list_watches(db, ident)}

    @app.post("/radar/watches")
    def radar_create(body: dict = Body(...), ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return radar.create_watch(db, ident, body)

    @app.patch("/radar/watches/{wid}")
    def radar_update(wid: str, body: dict = Body(...), ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return radar.update_watch(db, ident, wid, body)

    @app.delete("/radar/watches/{wid}")
    def radar_delete(wid: str, ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        radar.delete_watch(db, ident, wid)
        return {"ok": True}

    @app.post("/radar/watches/{wid}/check")
    def radar_check(wid: str, ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return radar.check_watch(db, ident, wid)

    @app.get("/radar/feed")
    def radar_feed(watch_id: str | None = None, label: str | None = None, include_baseline: bool = False, min_score: float = 0, ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return {"items": radar.feed(db, ident, watch_id=watch_id, label=label, include_baseline=include_baseline, min_score=min_score)}

    @app.post("/radar/items/{item_id}/dismiss")
    def radar_dismiss(item_id: str, ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        radar.dismiss_item(db, ident, item_id)
        return {"ok": True}

    @app.get("/radar/patterns")
    def radar_patterns(ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return {"patterns": radar.patterns(db, ident)}

    @app.get("/radar/opportunities")
    def radar_opps(ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return {"opportunities": radar.opportunities(db, ident)}

    @app.get("/radar/profile")
    def radar_profile(ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return radar.get_profile(db, ident)

    @app.put("/radar/profile")
    def radar_profile_put(body: dict = Body(...), ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return radar.update_profile(db, ident, body)

    @app.get("/radar/alerts")
    def radar_alerts(unread: bool = False, ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return {"alerts": radar.list_alerts(db, ident, unread)}

    @app.post("/radar/alerts/read")
    def radar_alerts_read(body: dict = Body(default={}), ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        radar.mark_alert_read(db, ident, body.get("id"))
        return {"ok": True}

    @app.get("/radar/digests")
    def radar_digests(ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return {"digests": radar.list_digests(db, ident)}

    @app.post("/radar/digests")
    def radar_digest_make(body: dict = Body(default={}), ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return radar.generate_digest(db, ident, body.get("period", "weekly"))

    # ─── Workspaces ─────────────────────────────────────────────────────────
    @app.get("/workspaces")
    def ws_list(ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return {"workspaces": ws.list_workspaces(db, ident), "permission_matrix": matrix()}

    @app.post("/workspaces")
    def ws_create(body: dict = Body(...), ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return ws.create_workspace(db, ident, str(body.get("name", "")), str(body.get("description", "")))

    @app.get("/workspaces/{wid}")
    def ws_get(wid: str, ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return ws.get_workspace(db, ident, wid)

    @app.patch("/workspaces/{wid}")
    def ws_patch(wid: str, body: dict = Body(...), ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return ws.update_workspace(db, ident, wid, body)

    @app.delete("/workspaces/{wid}")
    def ws_delete(wid: str, ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        ws.delete_workspace(db, ident, wid)
        return {"ok": True}

    @app.post("/workspaces/{wid}/members")
    def ws_invite(wid: str, body: dict = Body(...), ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return ws.invite(db, ident, wid, str(body.get("email", "")), str(body.get("role", "viewer")))

    @app.patch("/workspaces/{wid}/members/{mid}")
    def ws_role(wid: str, mid: str, body: dict = Body(...), ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        if body.get("transfer_ownership"):
            ws.transfer_ownership(db, ident, wid, mid)
            return {"ok": True}
        return ws.change_role(db, ident, wid, mid, str(body.get("role")))

    @app.delete("/workspaces/{wid}/members/{mid}")
    def ws_remove(wid: str, mid: str, ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        ws.remove_member(db, ident, wid, mid)
        return {"ok": True}

    @app.post("/workspaces/{wid}/items")
    def ws_item_create(wid: str, body: dict = Body(...), ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return ws.create_item(db, ident, wid, body)

    @app.get("/workspaces/{wid}/items/{iid}")
    def ws_item_get(wid: str, iid: str, ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return ws.get_item(db, ident, wid, iid)

    @app.put("/workspaces/{wid}/items/{iid}")
    def ws_item_put(wid: str, iid: str, body: dict = Body(...), ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return ws.update_item(db, ident, wid, iid, body, body.get("expected_version"), body.get("change_note"))

    @app.delete("/workspaces/{wid}/items/{iid}")
    def ws_item_delete(wid: str, iid: str, ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        ws.delete_item(db, ident, wid, iid)
        return {"ok": True}

    @app.get("/workspaces/{wid}/items/{iid}/versions/{v}")
    def ws_item_version(wid: str, iid: str, v: int, ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return ws.get_version(db, ident, wid, iid, v)

    @app.post("/workspaces/{wid}/items/{iid}/restore")
    def ws_item_restore(wid: str, iid: str, body: dict = Body(...), ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return ws.restore_version(db, ident, wid, iid, int(body["version"]))

    @app.post("/workspaces/{wid}/items/{iid}/comments")
    def ws_comment(wid: str, iid: str, body: dict = Body(...), ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return ws.add_comment(db, ident, wid, iid, str(body.get("body", "")), body.get("parent_id"), body.get("anchor"))

    @app.patch("/workspaces/{wid}/comments/{cid}")
    def ws_comment_resolve(wid: str, cid: str, body: dict = Body(...), ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        ws.resolve_comment(db, ident, wid, cid, bool(body.get("resolved", True)))
        return {"ok": True}

    @app.delete("/workspaces/{wid}/comments/{cid}")
    def ws_comment_delete(wid: str, cid: str, ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        ws.delete_comment(db, ident, wid, cid)
        return {"ok": True}

    @app.get("/workspaces/{wid}/search")
    def ws_search(wid: str, q: str = Query(..., min_length=1, max_length=200), ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return {"results": ws.search_items(db, ident, wid, q, 20)}

    @app.post("/workspaces/{wid}/collections")
    def ws_collection(wid: str, body: dict = Body(...), ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return ws.upsert_collection(db, ident, wid, str(body.get("name", "")), list(body.get("item_ids", [])), str(body.get("description", "")), body.get("id"))

    @app.delete("/workspaces/{wid}/collections/{cid}")
    def ws_collection_delete(wid: str, cid: str, ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        ws.delete_collection(db, ident, wid, cid)
        return {"ok": True}

    @app.post("/workspaces/{wid}/shares")
    def ws_share(wid: str, body: dict = Body(default={}), ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return ws.create_share(db, ident, wid, str(body.get("role", "viewer")), body.get("item_id"), body.get("expires_days", 30))

    @app.delete("/workspaces/{wid}/shares/{sid}")
    def ws_share_revoke(wid: str, sid: str, ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        ws.revoke_share(db, ident, wid, sid)
        return {"ok": True}

    @app.get("/share/{token}")
    def share_open(token: str, db: Database = Depends(db_dep)):
        # Public, read-only. The Next.js tier still signs requests, but no membership is required.
        return ws.open_share(db, token)

    @app.get("/workspaces/{wid}/export")
    def ws_export(wid: str, history: bool = False, members: bool = False, ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return portability.export_workspace(db, ident, wid, include_history=history, include_members=members)

    @app.post("/workspaces/import")
    def ws_import(body: dict = Body(...), dry_run: bool = True, workspace_id: str | None = None, ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return portability.import_bundle(db, ident, body, dry_run=dry_run, workspace_id=workspace_id)

    # ─── Community ──────────────────────────────────────────────────────────
    @app.get("/community")
    def cm_list(kind: str | None = None, q: str | None = None, ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return {"posts": community.list_posts(db, kind, q)}

    @app.get("/community/{pid}")
    def cm_get(pid: str, ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return community.get_post(db, pid)

    @app.post("/community")
    def cm_publish(body: dict = Body(...), ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return community.publish(db, ident, str(body.get("kind")), str(body.get("source_id")), str(body.get("title", "")), str(body.get("description", "")), str(body.get("license", "CC-BY-4.0")), body.get("workspace_id"), bool(body.get("acknowledge_sensitive")))

    @app.post("/community/{pid}/fork")
    def cm_fork(pid: str, body: dict = Body(default={}), ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return community.fork(db, ident, pid, body.get("workspace_id"))

    @app.post("/community/{pid}/report")
    def cm_report(pid: str, body: dict = Body(...), ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return community.report(db, ident, pid, str(body.get("reason", "")))

    @app.delete("/community/{pid}")
    def cm_unpublish(pid: str, ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        community.unpublish(db, ident, pid)
        return {"ok": True}

    # ─── Connectors ─────────────────────────────────────────────────────────
    @app.get("/connectors")
    def cn_catalog(ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return {"catalog": catalog(), "connections": conn.list_connections(db, ident), "consents": conn.consents(db, ident)}

    @app.post("/connectors/{cid}/connect")
    def cn_connect(cid: str, body: dict = Body(default={}), ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        if body.get("oauth"):
            return conn.start_oauth(db, ident, cid, str(body.get("capability", "")), body.get("workspace_id"))
        return conn.connect_no_auth(db, ident, cid, body.get("config") or {}, body.get("workspace_id"))

    @app.get("/connectors/oauth/callback")
    def cn_callback(state: str, code: str, ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return conn.finish_oauth(db, ident, state, code)

    @app.patch("/connections/{cid}")
    def cn_update(cid: str, body: dict = Body(...), ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return conn.update_config(db, ident, cid, body)

    @app.post("/connections/{cid}/sync")
    def cn_sync(cid: str, ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return conn.sync(db, ident, cid)

    @app.get("/connections/{cid}/conflicts")
    def cn_conflicts(cid: str, ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return {"conflicts": conn.list_conflicts(db, ident, cid)}

    @app.post("/conflicts/{xid}")
    def cn_resolve(xid: str, body: dict = Body(...), ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        conn.resolve_conflict(db, ident, xid, str(body.get("keep")))
        return {"ok": True}

    @app.delete("/connections/{cid}")
    def cn_delete(cid: str, delete_data: bool = False, ident: Identity = Depends(ident_dep), db: Database = Depends(db_dep)):
        return conn.disconnect(db, ident, cid, delete_data)

    return app


app = create_app()
