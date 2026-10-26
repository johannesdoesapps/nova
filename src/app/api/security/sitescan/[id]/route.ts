import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getRunRow } from "@/lib/db/security";
import { ApiError, errorResponse, requireUuid } from "@/lib/http";
import { unpackReport } from "@/lib/security/sitescan/store";

/** GET /api/security/sitescan/[id] — one scan: its report, steps and status. */
export async function GET(_req: Request, ctx: RouteContext<"/api/security/sitescan/[id]">) {
  try {
    const auth = await requireUser();
    const id = requireUuid((await ctx.params).id);
    const run = await getRunRow(auth.supabase, auth.user.id, id);
    if (run.agent !== "sentinel" || run.action !== "site_scan") throw new ApiError("not_found", "Scan not found.");
    return NextResponse.json({
      id: run.id,
      host: run.asset,
      scope: run.scope,
      status: run.status,
      error: run.error,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      steps: run.tools,
      overview: run.stats.overview ?? null,
      report: unpackReport(run.stats, run.id),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
