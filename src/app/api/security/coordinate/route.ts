import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { audit, startRun } from "@/lib/db/security";
import { errorResponse, parseJsonBody } from "@/lib/http";
import { coordinateStart } from "@/lib/security/schema";
import { assertAgentAccess } from "@/lib/agent-platform/server";

/**
 * POST /api/security/coordinate — open a coordinated investigation. The
 * browser then runs each selected agent with parentId (each a separate,
 * cancellable request) and finally asks for the unified report.
 */
export async function POST(req: Request) {
  try {
    const auth = await requireUser();
    await assertAgentAccess(auth, "security");
    const body = await parseJsonBody(req, coordinateStart);
    const runId = await startRun(auth.supabase, auth.user.id, { agent: "coordinated", action: "coordinate", asset: body.asset || "Coordinated investigation" });
    await auth.supabase
      .from("security_runs")
      .update({ stats: { plan: body.plan } })
      .eq("id", runId);
    await audit(auth.supabase, auth.user.id, "coordinated.started", { runId, detail: { plan: body.plan } });
    return NextResponse.json({ runId }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
