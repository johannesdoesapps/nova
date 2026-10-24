import "server-only";
import type { Authed } from "../code/server";
import { reportError } from "../observability";
import {
  fromCodeRun,
  fromResearch,
  fromReview,
  fromSecurityRun,
  fromWorkflow,
  mergeActivity,
  type ActivityItem,
  type CodeRunRow,
  type ResearchRowLite,
  type ReviewRowLite,
  type SecurityRunRowLite,
  type WorkflowRowLite,
} from "./activity";

/** The workflows table may not exist yet on this deployment (its migration waits for approval): then there are simply no workflows. */
const missingTable = (e: { code?: string; message?: string } | null) => !!e && (e.code === "PGRST205" || e.code === "42P01" || /does not exist|could not find the table/i.test(e.message ?? ""));

/**
 * The user's recent agent tasks across coding runs, reviews, research, Security Team scans and workflows,
 * read with their own session (row-level security: only their rows). A source that can't be read is left
 * out and logged, not shown as empty.
 */
export async function recentActivity(auth: Authed, limit = 60): Promise<{ items: ActivityItem[]; partial: boolean }> {
  const sb = auth.supabase;
  const [runs, reviews, research, security, workflows] = await Promise.all([
    sb
      .from("code_agent_runs")
      // Only what the list shows: the report's verdict, verification, failure kind and changed files (not the whole report), steps and recorded cost.
      .select(
        "id, project_id, request, status, options, pending, error, steps, step_limit, cost:usage->>costUsd, verification:report->>verification, state:report->>state, failure:report->>failure, files:report->files, created_at, updated_at, project:code_projects(name)",
      )
      .order("updated_at", { ascending: false })
      .limit(limit),
    // Findings can be large; the list needs only their severity and status, so fewer reviews are read.
    sb.from("code_reviews").select("id, title, status, error, findings, created_at, updated_at").order("updated_at", { ascending: false }).limit(Math.min(limit, 20)),
    sb.from("research_runs").select("id, question, status, phase, error, check:report_check, created_at, updated_at").order("updated_at", { ascending: false }).limit(limit),
    sb
      .from("security_runs")
      .select("id, agent, action, status, asset, error, tools, started_at, finished_at")
      .is("parent_id", null)
      .order("started_at", { ascending: false })
      .limit(Math.min(limit, 30)),
    sb
      .from("agent_workflows")
      .select("id, title, status, error, decision, steps, created_at, updated_at, project:code_projects(name)")
      .order("updated_at", { ascending: false })
      .limit(Math.min(limit, 30)),
  ]);
  let partial = false;
  for (const [name, r] of [
    ["code_agent_runs", runs],
    ["code_reviews", reviews],
    ["research_runs", research],
    ["security_runs", security],
    ["agent_workflows", workflows],
  ] as const) {
    if (r.error && !(name === "agent_workflows" && missingTable(r.error))) {
      partial = true;
      reportError(new Error(r.error.message), { where: `activity.${name}` });
    }
  }
  const now = Date.now();
  const items = mergeActivity(
    ((runs.data ?? []) as unknown as (Omit<CodeRunRow, "report"> & { verification: string | null; state: string | null; failure: string | null; files: unknown[] | null })[]).map(
      ({ verification, state, failure, files, ...r }) =>
        fromCodeRun(
          {
            ...r,
            report: verification || files || state || failure ? { verification: verification ?? undefined, state: state ?? undefined, failure: failure ?? undefined, files: files ?? [] } : null,
          },
          now,
        ),
    ),
    ((reviews.data ?? []) as unknown as ReviewRowLite[]).map((r) => fromReview(r, now)),
    ((research.data ?? []) as unknown as ResearchRowLite[]).map((r) => fromResearch(r, now)),
    ((security.data ?? []) as unknown as SecurityRunRowLite[]).map((r) => fromSecurityRun(r, now)),
    (workflows.error ? [] : ((workflows.data ?? []) as unknown as WorkflowRowLite[])).map((r) => fromWorkflow(r, now)),
  ).slice(0, limit);
  return { items, partial };
}
