import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { audit, startRun } from "@/lib/db/security";
import { errorResponse, parseJsonBody } from "@/lib/http";
import { MODE_INFO } from "@/lib/security/audit";
import { coordinateStart } from "@/lib/security/schema";
import { assertAgentAccess } from "@/lib/agent-platform/server";
import { enforce } from "@/lib/bastion/server";

/**
 * POST /api/security/coordinate — open a coordinated investigation, or a
 * Sentinel audit (with `audit`: mode, time budget, testing permission, gate).
 * The browser then runs each selected agent with parentId (each a separate,
 * cancellable request) and finally asks for the unified report. The audit's
 * settings are stored here and enforced by the server on every step.
 */
export async function POST(req: Request) {
  try {
    const auth = await requireUser();
    await assertAgentAccess(auth, "security");
    // Orbis Bastion: scans make outbound requests (to the user's verified site); an administrator can switch those off.
    await enforce({ db: auth.supabase, userId: auth.user.id, kind: "agent", agent: "security" }, "web.search", "security scan");
    const body = await parseJsonBody(req, coordinateStart);
    const runId = await startRun(auth.supabase, auth.user.id, {
      agent: "coordinated",
      action: body.audit ? `audit:${body.audit.mode}` : "coordinate",
      asset: body.asset || (body.audit ? MODE_INFO[body.audit.mode].label : "Coordinated investigation"),
      scope: body.audit ? (body.audit.active ? "active" : "passive") : null,
    });
    await auth.supabase
      .from("security_runs")
      .update({ stats: { plan: body.plan, ...(body.audit ? { audit: body.audit } : {}) } })
      .eq("id", runId);
    await audit(auth.supabase, auth.user.id, body.audit ? "audit_mode.started" : "coordinated.started", { runId, detail: { plan: body.plan, ...(body.audit ? { audit: body.audit } : {}) } });
    return NextResponse.json({ runId }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
