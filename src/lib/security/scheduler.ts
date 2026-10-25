import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Authed } from "../connectors/runtime";
import { getPlatformSettings } from "../ai/settings";
import { reportError } from "../observability";
import { runCloudflareAudit, runDeploymentAudit, runGuardianAgent, type RunContext } from "./runners";
import { currentSchedules, describeSchedule, isDue, lastRuns, type AuditEvent, type Schedule } from "./schedules";
import { userScopedDb } from "./scoped-db";

/**
 * Runs the scheduled audits that are due (called by the daily security cron). Each runs as its owner, through a
 * database client that can only see that person's rows, with their own connections, and without AI. Audits run one
 * at a time within a time budget; anything left over runs on the next day. Every attempt is recorded.
 */
export async function runDueSchedules(service: SupabaseClient, opts: { budgetMs: number; now?: number; signal?: AbortSignal }) {
  const started = Date.now();
  const now = opts.now ?? started;
  const settings = await getPlatformSettings();
  if (settings.pausedAgents.includes("security")) return { ran: [], skipped: "The Security Team is paused by an administrator." };

  const since = new Date(now - 8 * 86_400_000).toISOString();
  const [defs, ran] = await Promise.all([
    service.from("security_audit").select("user_id,action,detail,created_at").in("action", ["schedule.set", "schedule.removed"]).order("created_at").limit(20_000),
    service.from("security_audit").select("user_id,action,detail,created_at").eq("action", "schedule.ran").gte("created_at", since).limit(20_000),
  ]);
  if (defs.error || ran.error) throw new Error("Couldn't read schedules.");
  const byUser = new Map<string, { defs: AuditEvent[]; ran: AuditEvent[] }>();
  for (const e of (defs.data ?? []) as (AuditEvent & { user_id: string })[]) (byUser.get(e.user_id) ?? byUser.set(e.user_id, { defs: [], ran: [] }).get(e.user_id)!).defs.push(e);
  for (const e of (ran.data ?? []) as (AuditEvent & { user_id: string })[]) byUser.get(e.user_id)?.ran.push(e);

  const due: { userId: string; schedule: Schedule }[] = [];
  for (const [userId, ev] of byUser) {
    const last = lastRuns(ev.ran);
    for (const s of currentSchedules(ev.defs)) if (isDue(s, last.get(s.id), now)) due.push({ userId, schedule: s });
  }

  const results: { userId: string; id: string; outcome: string; runId: string | null }[] = [];
  for (const d of due) {
    if (Date.now() - started > opts.budgetMs || opts.signal?.aborted) break;
    const db = userScopedDb(service, d.userId);
    const auth = { mode: "authenticated", user: { id: d.userId, email: null, displayName: null }, supabase: db } as unknown as Authed;
    let runId: string | null = null;
    const ctx: RunContext = {
      req: new Request("https://tryorbis.app/api/cron/security"),
      auth,
      send: (e) => {
        if (e.type === "run" && typeof e.runId === "string" && !runId) runId = e.runId;
      },
      signal: AbortSignal.timeout(110_000),
      noAi: true,
    };
    let outcome = "completed";
    try {
      const s = d.schedule;
      if (s.kind === "repository") await runGuardianAgent(ctx, { source: { type: "github", repo: s.repo }, asset: "", aiReview: false, proposeFixes: false });
      else if (s.kind === "deployment") await runDeploymentAudit(ctx, { project: s.project, teamId: s.teamId, siteChecks: true });
      else await runCloudflareAudit(ctx, { zone: s.zone });
    } catch (err) {
      outcome = `failed: ${(err as Error).message?.slice(0, 200) ?? "error"}`;
      if (!(err instanceof Error && "status" in err)) reportError(err, { where: "security.schedule", kind: d.schedule.kind });
    }
    await db.from("security_audit").insert({ action: "schedule.ran", run_id: runId, detail: { id: d.schedule.id, runId, outcome, what: describeSchedule(d.schedule) } });
    results.push({ userId: d.userId, id: d.schedule.id, outcome, runId });
  }
  return { ran: results, due: due.length, deferred: due.length - results.length };
}
