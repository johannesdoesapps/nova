import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadControls } from "../bastion/server";
import { backgroundAvailable, ownerSession, workerAuthorized } from "../code/agent/background";
import { getFiles } from "../code/server";
import { reportError } from "../observability";
import { serviceSupabase } from "../supabase/admin";
import { orbisGateway } from "./providers";
import type { WorkerDeps } from "./worker";

/**
 * Production wiring for workers: the service-role client for the queue, Orbis's provider gateway, sessions opened
 * for task owners (the same mechanism as the coding agent's background worker: the admin key only issues the
 * owner's session; everything else runs under their row-level security and metering), Bastion's emergency
 * controls, and self-kicking through the secret-protected worker route.
 */

export { workerAuthorized };
/** One worker call's time (the route allows 300 s). */
export const WORKER_BUDGET_MS = 285_000;
export const orchestratorAvailable = backgroundAvailable;

/** Ask for a worker. Waits only until the worker route has accepted (it works after answering). */
export async function kickOrchestrator(origin: string): Promise<void> {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || !backgroundAvailable()) return;
  try {
    const res = await fetch(new URL("/api/orchestrator/worker", origin), {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status !== 202) reportError(new Error(`The orchestrator worker answered ${res.status}`), { where: "orchestrator.kick" });
  } catch (err) {
    reportError(err, { where: "orchestrator.kick" });
  }
}

/** Why dispatch is stopped right now: Bastion lockdown, the orchestrator suspended, or controls unreadable (fail closed). */
export async function orchestratorPaused(): Promise<string | null> {
  const c = await loadControls();
  if (!c) return "Orbis Bastion couldn't confirm its controls, so dispatch is paused (fail closed).";
  if (c.lockdown) return "Orbis Bastion is in lockdown.";
  if (c.suspendedAgents.includes("orchestrator")) return "The orchestrator is suspended by an administrator (Bastion).";
  return null;
}

export function productionWorkerDeps(origin: string): WorkerDeps | null {
  const db = serviceSupabase();
  if (!db) return null;
  return {
    db: db as unknown as SupabaseClient,
    gateway: orbisGateway,
    openOwner: ownerSession,
    projectFiles: getFiles,
    paused: orchestratorPaused,
    kick: () => kickOrchestrator(origin),
  };
}
