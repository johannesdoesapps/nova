import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { audit, finishRun, getRunRow } from "@/lib/db/security";
import { ApiError, errorResponse, ndjsonStream, parseJsonBody } from "@/lib/http";
import { runCoordinatedReport } from "@/lib/security/runners";
import { coordinateReport } from "@/lib/security/schema";

export const maxDuration = 60;

/** POST /api/security/coordinate/[id]/report — correlate the agents' findings and write the unified report (NDJSON). */
export async function POST(req: Request, ctx: RouteContext<"/api/security/coordinate/[id]/report">) {
  try {
    const auth = await requireUser();
    const { id } = await ctx.params;
    const body = await parseJsonBody(req, coordinateReport);
    const run = await getRunRow(auth.supabase, auth.user.id, id);
    if (run.agent !== "coordinated" || run.status !== "running") throw new ApiError("bad_request", "This investigation isn't running.");
    return ndjsonStream((send, signal) => runCoordinatedReport({ req, auth, send, signal, modelId: body.modelId }, id), req.signal);
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE /api/security/coordinate/[id]/report — cancel a coordinated investigation. */
export async function DELETE(_req: Request, ctx: RouteContext<"/api/security/coordinate/[id]/report">) {
  try {
    const auth = await requireUser();
    const { id } = await ctx.params;
    const run = await getRunRow(auth.supabase, auth.user.id, id);
    if (run.agent === "coordinated" && run.status === "running") {
      await finishRun(auth.supabase, id, { status: "cancelled", error: "Cancelled by the user." });
      await audit(auth.supabase, auth.user.id, "coordinated.cancelled", { runId: id });
    }
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
