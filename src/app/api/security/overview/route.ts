import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { listFindings, listRuns, listTargets } from "@/lib/db/security";
import { errorResponse } from "@/lib/http";
import { SECURITY_AGENTS } from "@/lib/security/agents";
import { posture } from "@/lib/security/audit";
import { securityTools } from "@/lib/security/tools";

/** GET /api/security/overview — agents, tool availability, targets, recent runs and finding counts. */
export async function GET() {
  try {
    const auth = await requireUser();
    const [tools, targets, runs, findings] = await Promise.all([
      securityTools(auth),
      listTargets(auth.supabase, auth.user.id),
      listRuns(auth.supabase, auth.user.id, 60),
      listFindings(auth.supabase, auth.user.id, { sort: "recent", scope: "security" }),
    ]);
    const active = findings.filter((f) => !["fixed", "verified", "accepted_risk", "false_positive"].includes(f.status));
    const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 } as Record<string, number>;
    for (const f of active) counts[f.severity]!++;
    const latest: Record<string, { status: string; runId: string; at: string } | null> = {};
    for (const a of SECURITY_AGENTS) {
      const r = runs.find((x) => x.agent === a.id);
      latest[a.id] = r ? { status: r.status, runId: r.id, at: r.started_at } : null;
    }
    // The list only needs headline numbers; maps, coverage and paths are loaded with each run.
    const BIG = new Set(["surface", "codeMap", "endpointResults", "coverage", "paths", "linkNotes", "timeline", "reputation", "notes"]);
    const light = runs.map((r) => ({ ...r, summary: null, stats: Object.fromEntries(Object.entries(r.stats).filter(([k]) => !BIG.has(k))) }));
    return NextResponse.json({
      agents: SECURITY_AGENTS,
      tools,
      targets,
      runs: light,
      latest,
      openCounts: counts,
      // Open findings split by how sure we are (confirmed or likely vs. still needing verification).
      openPosture: (() => {
        const p = posture(active);
        return { confirmedOrLikely: p.confirmedOrLikely, unverified: p.unverified };
      })(),
      totals: { all: findings.length, open: active.length, assets: [...new Set(findings.map((f) => f.asset))] },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
