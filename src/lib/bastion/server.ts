import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ApiError } from "../http";
import { reportError } from "../observability";
import { redactAll } from "../secrets";
import { loadControls } from "./controls";
import { actionHash, decide, type Decision, type GuardRequest, type OperationId } from "./policy";

export { invalidateControls, loadControls } from "./controls";

/**
 * Bastion's enforcement point on the server. Every protected action calls `guard` (to learn the decision and
 * explain it) or `enforce` (to refuse with an error) right before it runs, in the code that runs it — so a
 * request that skips the page, the AI's prompt or another agent still meets the same check.
 *
 * Controls come from ./controls.ts; when they can't be read or don't validate, only low-risk actions go ahead.
 *
 * Decisions that refuse, ask for approval or allow a high-risk action are recorded in the user's security
 * audit trail (security_audit, append-only) with the resource redacted.
 */

export interface GuardContext {
  /** The user's own database session (the audit row is written as them). */
  db: SupabaseClient | null;
  userId: string;
  /** Who is acting: an agent (by id), the user themselves, or Orbis itself. */
  kind: GuardRequest["actor"]["kind"];
  agent: string;
  runId?: string | null;
}

const RECORD = (d: Decision) => d.outcome !== "allow" || d.risk === "high" || d.risk === "critical";

async function record(ctx: GuardContext, d: Decision, resource: string) {
  if (!ctx.db || !RECORD(d)) return;
  try {
    await ctx.db
      .from("security_audit")
      .insert({
        user_id: ctx.userId,
        action: `bastion.${d.outcome}`,
        detail: {
          op: d.op,
          risk: d.risk,
          agent: ctx.agent,
          actor: ctx.kind,
          runId: ctx.runId ?? null,
          resource: redactAll(resource).slice(0, 300),
          reason: d.reason.slice(0, 300),
          policyVersion: d.policyVersion,
          actionHash: d.actionHash,
        },
      });
  } catch (err) {
    reportError(err, { where: "bastion.record" });
  }
}

/**
 * Decide on one action. `approved` means a person approved exactly this action in the product's own approval
 * step (the approval is bound to who, what and which resource, so it doesn't carry over to anything else).
 */
export async function guard(ctx: GuardContext, op: OperationId, resource: string, opts: { approved?: boolean } = {}): Promise<Decision> {
  const req: GuardRequest = { actor: { kind: ctx.kind, agent: ctx.agent, userId: ctx.userId, runId: ctx.runId ?? null }, op, resource };
  if (opts.approved) req.approval = { actionHash: actionHash(req) };
  const d = decide(req, await loadControls());
  await record(ctx, d, resource);
  return d;
}

export class BastionRefusal extends ApiError {
  constructor(public decision: Decision) {
    super("forbidden", `Blocked by Orbis Bastion: ${decision.reason}`, { scope: "bastion", op: decision.op, risk: decision.risk, outcome: decision.outcome });
  }
}

/** Like guard, but refuses (throws) unless the action is allowed. */
export async function enforce(ctx: GuardContext, op: OperationId, resource: string, opts: { approved?: boolean } = {}): Promise<Decision> {
  const d = await guard(ctx, op, resource, opts);
  if (d.outcome !== "allow") throw new BastionRefusal(d);
  return d;
}

/** Whether an agent may carry on right now: suspended, or Bastion can't confirm its controls (fail closed). */
export async function agentSuspended(agent: string): Promise<{ kind: "suspended" | "unavailable"; message: string } | null> {
  const c = await loadControls();
  if (!c) return { kind: "unavailable", message: "Orbis Bastion couldn't confirm its controls, so agents are paused (fail closed). Try again in a moment." };
  if (c.suspendedAgents.includes(agent)) return { kind: "suspended", message: "this agent is suspended by an administrator." };
  return null;
}

/** Refusals recorded for one run since it started (for containment after repeated refusals). */
export async function refusalsInRun(db: SupabaseClient, userId: string, runId: string, since: string): Promise<number> {
  const { data } = await db.from("security_audit").select("detail").eq("user_id", userId).eq("action", "bastion.deny").gte("created_at", since).order("created_at", { ascending: false }).limit(200);
  return ((data ?? []) as { detail: { runId?: string } }[]).filter((r) => r.detail?.runId === runId).length;
}
