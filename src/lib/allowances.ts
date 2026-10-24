import "server-only";
import { workspaceAllowance, type Authed } from "./code/server";
import { budgetPeriod } from "./budget";
import { entitlementFor } from "./entitlements";
import { reportError } from "./observability";

/**
 * The monthly allowances that aren't usage units — code runs, workspace computer minutes, code projects —
 * as the server counts them when it enforces them (the same database functions), for the Usage page.
 * Each is null when it can't be read right now; the page says so rather than guessing.
 */
export interface MonthlyAllowances {
  resetsAt: string;
  codeRuns: { used: number; limit: number } | null;
  workspaceMinutes: { used: number; limit: number; blockMinutes: number } | null;
  codeProjects: { used: number; limit: number } | null;
}

export async function monthlyAllowances(auth: Authed): Promise<MonthlyAllowances | null> {
  const entitlement = await entitlementFor(auth);
  if (!entitlement || entitlement.kind === "unlimited") return null;
  const period = budgetPeriod(entitlement);
  const since = new Date(period.start).toISOString();
  const [runs, ws, projects] = await Promise.all([
    auth.supabase.rpc("code_run_status", { p_since: since }),
    workspaceAllowance(auth).catch((e) => {
      reportError(e, { where: "allowances.workspace" });
      return null;
    }),
    auth.supabase.from("code_projects").select("id", { count: "exact", head: true }),
  ]);
  const r = runs.data as { user_runs: number; user_in_flight: number } | null;
  return {
    resetsAt: new Date(period.end).toISOString(),
    codeRuns: runs.error || !r ? null : { used: Number(r.user_runs) + Number(r.user_in_flight), limit: entitlement.limits.codeRunsPerPeriod },
    workspaceMinutes: ws && ws.limit !== null ? { used: ws.used, limit: ws.limit, blockMinutes: ws.blockMinutes } : null,
    codeProjects: projects.error ? null : { used: projects.count ?? 0, limit: entitlement.limits.codeProjects },
  };
}
