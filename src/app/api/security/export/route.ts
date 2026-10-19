import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { audit, listFindings } from "@/lib/db/security";
import { errorResponse, parseQuery } from "@/lib/http";
import { findingsToMarkdown } from "@/lib/security/report";

const query = z.object({ format: z.enum(["json", "md"]).default("md"), includeClosed: z.enum(["1", "0"]).default("1") });

/** GET /api/security/export — download all findings as Markdown or JSON. */
export async function GET(req: Request) {
  try {
    const auth = await requireUser();
    const q = parseQuery(req.url, query);
    let findings = await listFindings(auth.supabase, auth.user.id, { sort: "severity" });
    if (q.includeClosed === "0") findings = findings.filter((f) => !["fixed", "verified", "accepted_risk", "false_positive"].includes(f.status));
    await audit(auth.supabase, auth.user.id, "report.exported", { detail: { format: q.format, findings: findings.length } });
    const date = new Date().toISOString().slice(0, 10);
    const body =
      q.format === "json"
        ? JSON.stringify({ generatedAt: new Date().toISOString(), findings: findings.map((f) => ({ ...f, fingerprint: undefined })) }, null, 2)
        : findingsToMarkdown(findings, new Date());
    return new Response(body, {
      headers: {
        "content-type": q.format === "json" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="nova-security-findings-${date}.${q.format}"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
