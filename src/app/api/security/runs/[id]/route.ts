import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getRun } from "@/lib/db/security";
import { errorResponse, requireUuid } from "@/lib/http";
import { unpackReport } from "@/lib/security/sitescan/store";

/** GET /api/security/runs/[id] — a run with its steps, report, child runs and findings. */
export async function GET(_req: Request, ctx: RouteContext<"/api/security/runs/[id]">) {
  try {
    const auth = await requireUser();
    const id = requireUuid((await ctx.params).id);
    const data = await getRun(auth.supabase, auth.user.id, id);
    // For a website scan, surface why the grade is what it is (caps, the A+ note and the two part scores),
    // so the result page can explain it without the viewer re-reading the whole report.
    if (data.run.agent === "sentinel" && data.run.action === "site_scan") {
      const report = unpackReport(data.run.stats, data.run.id);
      if (report?.grade) {
        const ov = (data.run.stats.overview ?? {}) as Record<string, unknown>;
        data.run.stats.overview = { ...ov, caps: report.grade.caps, plus: report.grade.plus, parts: report.grade.parts };
      }
    }
    return NextResponse.json(data);
  } catch (err) {
    return errorResponse(err);
  }
}
