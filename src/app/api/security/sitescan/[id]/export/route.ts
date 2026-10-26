import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { audit, getRunRow } from "@/lib/db/security";
import { ApiError, errorResponse, parseQuery, requireUuid } from "@/lib/http";
import { toHtml, toMarkdown } from "@/lib/security/sitescan/report";
import { unpackReport } from "@/lib/security/sitescan/store";

const query = z.object({ format: z.enum(["md", "json", "html"]).default("md") });
const TYPES = { md: "text/markdown", json: "application/json", html: "text/html" } as const;

/** GET /api/security/sitescan/[id]/export?format=md|json|html — download a scan report. */
export async function GET(req: Request, ctx: RouteContext<"/api/security/sitescan/[id]/export">) {
  try {
    const auth = await requireUser();
    const id = requireUuid((await ctx.params).id);
    const { format } = parseQuery(req.url, query);
    const run = await getRunRow(auth.supabase, auth.user.id, id);
    const report = run.agent === "sentinel" && run.action === "site_scan" ? unpackReport(run.stats, run.id) : null;
    if (!report) throw new ApiError("not_found", "Scan report not found.");
    // The Markdown saved with the run was written from the full report; prefer it (the stored copy may be trimmed).
    const body = format === "json" ? JSON.stringify(report, null, 2) : format === "html" ? toHtml(report) : (run.summary ?? toMarkdown(report));
    await audit(auth.supabase, auth.user.id, "report.exported", { runId: run.id, detail: { kind: "site_scan", format } });
    return new Response(body, {
      headers: {
        "content-type": `${TYPES[format]}; charset=utf-8`,
        "content-disposition": `attachment; filename="orbis-scan-${report.host}-${report.finishedAt.slice(0, 10)}.${format}"`,
        "cache-control": "no-store",
        // The HTML export has no scripts and its own default-src 'none' policy; it's downloaded, not rendered here.
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
