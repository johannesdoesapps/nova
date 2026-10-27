import type { SupabaseClient } from "@supabase/supabase-js";
import type { Authed } from "../code/server";
import type { ProjectFile } from "../code/projects";
import { reportError } from "../observability";
import { executeAttempt, type AttemptResult, type Claim } from "./executor";
import type { ModelGateway } from "./providers";

/**
 * A worker: claims work from the queue and runs it until there's nothing it can start, its time is nearly up, or
 * dispatch is paused. Claiming takes a global execution slot in the database (orch_claim), so however many workers
 * run — on however many servers — at most three attempts execute at once. Each finished attempt releases its slot
 * (orch_finish) and the worker immediately tries to claim the next task, so queued work starts as soon as capacity
 * frees up. A worker that claims work asks for one more worker, so up to three attempts run in parallel; extra
 * workers find no free slot and stop at once.
 *
 * Model calls run as the task's owner (their row-level security, their plan's metering), in a session opened
 * for them on the server and signed out when the worker stops.
 */

export interface WorkerDeps {
  /** Service-role client, for the queue functions. */
  db: SupabaseClient;
  gateway: ModelGateway;
  openOwner: (ownerId: string) => Promise<{ auth: Authed; end: () => Promise<void> } | null>;
  projectFiles: (owner: Authed, projectId: string) => Promise<ProjectFile[]>;
  /** A reason dispatch is stopped (Bastion lockdown or the orchestrator suspended), or null. */
  paused?: () => Promise<string | null>;
  /** Ask for another worker (it runs in its own function call). */
  kick?: () => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface WorkerReport {
  ran: { taskId: string; attemptNo: number; outcome: AttemptResult["outcome"]; taskStatus: string }[];
  stopped: "idle" | "budget" | "paused" | "error";
  detail?: string;
}

/** Time kept back at the end of a worker call for recording results. */
const MARGIN_MS = 15_000;
/** The shortest attempt time worth claiming work for. */
const MIN_ATTEMPT_S = 10;
/** A worker waits for a retry that's due this soon (instead of leaving it until the next kick). */
const WAIT_FOR_DUE_MS = 45_000;

export async function runWorker(deps: WorkerDeps, opts: { workerId: string; budgetMs: number }): Promise<WorkerReport> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const started = now();
  const left = () => opts.budgetMs - (now() - started) - MARGIN_MS;
  const owners = new Map<string, { auth: Authed; end: () => Promise<void> } | null>();
  const report: WorkerReport = { ran: [], stopped: "idle" };
  try {
    for (;;) {
      const why = deps.paused ? await deps.paused() : null;
      if (why) return { ...report, stopped: "paused", detail: why };
      const seconds = Math.min(270, Math.floor(left() / 1000));
      if (seconds < MIN_ATTEMPT_S) {
        if (await hasQueued(deps.db)) await deps.kick?.().catch(() => undefined); // hand over to a fresh worker
        return { ...report, stopped: "budget" };
      }
      const { data, error } = await deps.db.rpc("orch_claim", { p_worker: opts.workerId, p_max_seconds: seconds });
      if (error) throw new Error(`orch_claim: ${error.message}`);
      const claim = data as Claim | null;
      if (!claim) {
        // Nothing to start now. Wait for a retry that's due very soon if there's time; otherwise stop.
        const due = await nextDue(deps.db);
        const wait = due === null ? null : due - now();
        if (wait !== null && wait > 0 && wait <= WAIT_FOR_DUE_MS && left() - wait > 60_000) {
          await sleep(wait + 250);
          continue;
        }
        return report;
      }
      // Work was available: one more worker may be able to use another free slot.
      await deps.kick?.().catch(() => undefined);
      const r = await runOne(deps, claim, owners);
      report.ran.push({ taskId: claim.taskId, attemptNo: claim.attemptNo, outcome: r.result.outcome, taskStatus: r.status });
    }
  } catch (err) {
    reportError(err, { where: "orchestrator.worker" });
    return { ...report, stopped: "error", detail: err instanceof Error ? err.message.slice(0, 300) : "error" };
  } finally {
    for (const s of owners.values()) await s?.end().catch(() => undefined);
  }
}

async function runOne(deps: WorkerDeps, claim: Claim, owners: Map<string, { auth: Authed; end: () => Promise<void> } | null>): Promise<{ result: AttemptResult; status: string }> {
  let result: AttemptResult;
  if (!owners.has(claim.ownerId)) owners.set(claim.ownerId, await deps.openOwner(claim.ownerId).catch(() => null));
  const owner = owners.get(claim.ownerId);
  if (!owner) {
    result = { outcome: "failed", output: null, error: "Couldn't open a session for the task's owner, so nothing ran.", errorKind: "auth", retryable: true, usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 } };
  } else {
    result = await executeAttempt(claim, { db: deps.db, gateway: deps.gateway, owner: owner.auth, projectFiles: deps.projectFiles });
  }
  // A worker that lost its lease records nothing: the attempt was already reclaimed (and retried) by the queue.
  if (result.outcome === "stale") return { result, status: "stale" };
  const { data, error } = await deps.db.rpc("orch_finish", {
    p_attempt: claim.attemptId,
    p_lease: claim.leaseId,
    p_outcome: result.outcome,
    p_output: result.output,
    p_error: result.error,
    p_error_kind: result.errorKind,
    p_retryable: result.retryable,
    p_usage: result.usage,
  });
  if (error) {
    // The result couldn't be saved: the lease will expire and the attempt will be recorded as interrupted and retried.
    reportError(new Error(`orch_finish: ${error.message}`), { where: "orchestrator.finish" });
    return { result, status: "unrecorded" };
  }
  return { result, status: data as string };
}

async function hasQueued(db: SupabaseClient): Promise<boolean> {
  const { data } = await db.from("orch_tasks").select("id").eq("status", "queued").limit(1);
  return !!(data as unknown[] | null)?.length;
}

async function nextDue(db: SupabaseClient): Promise<number | null> {
  const { data } = await db.from("orch_tasks").select("run_after").eq("status", "queued").order("run_after").limit(1);
  const row = (data as { run_after: string }[] | null)?.[0];
  return row ? Date.parse(row.run_after) : null;
}
