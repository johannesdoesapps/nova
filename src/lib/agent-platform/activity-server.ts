import "server-only";
import type { Authed } from "../code/server";
import { reportError } from "../observability";
import { fromCodeRun, fromResearch, fromReview, mergeActivity, type ActivityItem, type CodeRunRow, type ResearchRowLite, type ReviewRowLite } from "./activity";

/**
 * The user's recent agent tasks across coding runs, reviews and research,
 * read with their own session (row-level security: only their rows). A
 * source that can't be read is left out and logged, not shown as empty.
 */
export async function recentActivity(auth: Authed, limit = 60): Promise<{ items: ActivityItem[]; partial: boolean }> {
  const sb = auth.supabase;
  const [runs, reviews, research] = await Promise.all([
    sb
      .from("code_agent_runs")
      // Only what the list shows: the report's verification and changed files, not the whole report.
      .select("id, project_id, request, status, options, pending, error, verification:report->>verification, files:report->files, created_at, updated_at, project:code_projects(name)")
      .order("updated_at", { ascending: false })
      .limit(limit),
    // Findings can be large; the list needs only their severity and status, so fewer reviews are read.
    sb.from("code_reviews").select("id, title, status, error, findings, created_at, updated_at").order("updated_at", { ascending: false }).limit(Math.min(limit, 20)),
    sb.from("research_runs").select("id, question, status, phase, error, created_at, updated_at").order("updated_at", { ascending: false }).limit(limit),
  ]);
  let partial = false;
  for (const [name, r] of [
    ["code_agent_runs", runs],
    ["code_reviews", reviews],
    ["research_runs", research],
  ] as const) {
    if (r.error) {
      partial = true;
      reportError(new Error(r.error.message), { where: `activity.${name}` });
    }
  }
  const items = mergeActivity(
    ((runs.data ?? []) as unknown as (Omit<CodeRunRow, "report"> & { verification: string | null; files: unknown[] | null })[]).map(({ verification, files, ...r }) =>
      fromCodeRun({ ...r, report: verification || files ? { verification: verification ?? undefined, files: files ?? [] } : null }),
    ),
    ((reviews.data ?? []) as unknown as ReviewRowLite[]).map(fromReview),
    ((research.data ?? []) as unknown as ResearchRowLite[]).map(fromResearch),
  ).slice(0, limit);
  return { items, partial };
}
