import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { listRuns } from "@/lib/db/security";
import { errorResponse } from "@/lib/http";

/**
 * GET /api/security/hunter/workspace — the Threat Hunter workspace: recent hunts with their investigations, source
 * inventories, intelligence records and quality checks, plus the decisions people recorded. Only data from
 * the user's own runs; nothing is sampled or simulated.
 */
export async function GET() {
  try {
    const auth = await requireUser();
    const runs = (await listRuns(auth.supabase, auth.user.id, 60)).filter((r) => r.agent === "threat_hunter").slice(0, 25);
    const { data: decisions } = await auth.supabase
      .from("security_audit")
      .select("id,action,run_id,detail,created_at")
      .eq("user_id", auth.user.id)
      .eq("action", "investigation.updated")
      .order("created_at", { ascending: false })
      .limit(100);
    return NextResponse.json({
      runs: runs.map((r) => ({
        id: r.id,
        asset: r.asset,
        status: r.status,
        started_at: r.started_at,
        stats: {
          investigations: r.stats.investigations ?? [],
          investigationsTrimmed: r.stats.investigationsTrimmed ?? [],
          inventory: r.stats.inventory ?? [],
          baselines: r.stats.baselines ?? null,
          intel: r.stats.intel ?? [],
          qa: r.stats.qa ?? [],
          events: r.stats.events ?? null,
        },
      })),
      decisions: decisions ?? [],
    });
  } catch (err) {
    return errorResponse(err);
  }
}
