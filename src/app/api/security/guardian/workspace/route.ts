import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { listFindings, listRuns } from "@/lib/db/security";
import { errorResponse } from "@/lib/http";

/**
 * GET /api/security/guardian/workspace — the Code Guardian workspace: recent code audits with their engineering
 * summaries (profile, module graph, checks, maintainability, regression memory), the engineering findings, runs
 * in progress with their current step, and the repair and impact-analysis history from the audit trail. Only the
 * user's own data; nothing is sampled, estimated or simulated.
 */
export async function GET() {
  try {
    const auth = await requireUser();
    const [runs, findings, history] = await Promise.all([
      listRuns(auth.supabase, auth.user.id, 80),
      listFindings(auth.supabase, auth.user.id, { agent: "code_guardian", scope: "engineering", sort: "severity" }),
      auth.supabase
        .from("security_audit")
        .select("id,action,finding_id,detail,created_at")
        .eq("user_id", auth.user.id)
        .in("action", ["fix.project_opened", "impact.analysed"])
        .order("created_at", { ascending: false })
        .limit(60),
    ]);
    const guardian = runs.filter((r) => r.agent === "code_guardian").slice(0, 30);
    return NextResponse.json({
      runs: guardian.map((r) => ({
        id: r.id,
        asset: r.asset,
        status: r.status,
        started_at: r.started_at,
        finished_at: r.finished_at,
        tools: r.tools,
        stats: { engineering: r.stats.engineering ?? null, bySeverity: r.stats.bySeverity ?? null, files: r.stats.files ?? null, guardian: r.stats.guardian ?? null },
      })),
      findings: findings.map((f) => ({
        id: f.id,
        rule_id: f.rule_id,
        title: f.title,
        severity: f.severity,
        confidence: f.confidence,
        status: f.status,
        asset: f.asset,
        location: f.location,
        verification: f.verification,
        last_seen: f.last_seen,
        occurrences: f.occurrences,
      })),
      history: history.data ?? [],
    });
  } catch (err) {
    return errorResponse(err);
  }
}
