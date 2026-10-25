import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ApiError } from "../http";
import { reportError } from "../observability";
import { redactAll } from "../secrets";
import { bastionMac, loadControls, loadWorkspacePolicy } from "./controls";
import { agentPaused, decideWithWorkspace, type CustomerPolicy } from "./customer/policy";
import { signDetail } from "./customer/records";
import { actionHash, decide, type Decision, type GuardRequest, type OperationId } from "./policy";

export { invalidateControls, invalidateWorkspacePolicy, loadControls, loadWorkspacePolicy } from "./controls";

/**
 * Bastion's enforcement point on the server. Every protected action calls `guard` (to learn the decision and
 * explain it) or `enforce` (to refuse with an error) right before it runs, in the code that runs it — so a
 * request that skips the page, the AI's prompt or another agent still meets the same check.
 *
 * Two layers decide: Bastion Core's controls (./controls.ts — mandatory, set by Orbis administrators) and the
 * workspace's own policy (customer/policy.ts — restrictions the customer adds, never fewer). When either can't be
 * read, only low-risk actions go ahead (fail closed).
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
  /** Correlation id shared by the records of one operation. */
  cid?: string | null;
}

/** Append a signed record to a workspace's security audit trail (never throws). */
export async function recordSigned(db: SupabaseClient, ownerId: string, action: string, detail: Record<string, unknown>, ref: { runId?: string | null; findingId?: string | null } = {}): Promise<boolean> {
  try {
    const { error } = await db.from("security_audit").insert({ user_id: ownerId, action: action.slice(0, 60), run_id: ref.runId ?? null, finding_id: ref.findingId ?? null, detail: signDetail(bastionMac, ownerId, action, JSON.parse(redactAll(JSON.stringify(detail)))) });
    if (error) reportError(new Error(`Bastion couldn't record ${action}: ${error.message}`), { where: "bastion.record" });
    return !error;
  } catch (err) {
    reportError(err, { where: "bastion.record" });
    return false;
  }
}

const RECORD = (d: Decision) => d.outcome !== "allow" || d.risk === "high" || d.risk === "critical";

async function record(ctx: GuardContext, d: Decision & { source?: string }, resource: string) {
  if (!ctx.db || !RECORD(d)) return;
  // run_id references security runs only, so other runs (coding agents) are kept in the detail.
  await recordSigned(ctx.db, ctx.userId, `bastion.${d.outcome}`, {
    op: d.op,
    risk: d.risk,
    agent: ctx.agent,
    actor: ctx.kind,
    runId: ctx.runId ?? null,
    cid: ctx.cid ?? null,
    resource: redactAll(resource).slice(0, 300),
    reason: d.reason.slice(0, 300),
    source: d.source ?? "platform",
    policyVersion: d.policyVersion,
    actionHash: d.actionHash,
  });
}

/** The workspace layer for a guard call: the actor's own workspace (null without a session, e.g. system work). */
async function workspaceOf(ctx: GuardContext): Promise<CustomerPolicy | null | "unavailable"> {
  if (!ctx.db) return null;
  const ws = await loadWorkspacePolicy(ctx.db, ctx.userId);
  return ws === "unavailable" ? ws : ws.current.policy;
}

/**
 * Decide on one action. `approved` means a person approved exactly this action in the product's own approval
 * step (the approval is bound to who, what and which resource, so it doesn't carry over to anything else).
 */
export async function guard(ctx: GuardContext, op: OperationId, resource: string, opts: { approved?: boolean } = {}): Promise<Decision> {
  const req: GuardRequest = { actor: { kind: ctx.kind, agent: ctx.agent, userId: ctx.userId, runId: ctx.runId ?? null }, op, resource };
  if (opts.approved) req.approval = { actionHash: actionHash(req) };
  const [controls, ws] = await Promise.all([loadControls(), workspaceOf(ctx)]);
  const d =
    ws === "unavailable"
      ? (() => {
          const fc = decide(req, null);
          return { ...fc, source: "workspace" as const, reason: fc.outcome === "allow" ? fc.reason : "Bastion couldn't read your workspace's security policy, so protected actions are paused (fail closed). Try again in a moment." };
        })()
      : decideWithWorkspace(req, controls, ws);
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

/**
 * Whether an agent may carry on right now: suspended by an administrator, paused by the workspace's policy, or
 * Bastion can't confirm either layer (fail closed). Pass the workspace's session to include its policy.
 */
export async function agentSuspended(agent: string, workspace?: { db: SupabaseClient | null; ownerId: string } | null): Promise<{ kind: "suspended" | "paused" | "unavailable"; message: string } | null> {
  const c = await loadControls();
  if (!c) return { kind: "unavailable", message: "Orbis Bastion couldn't confirm its controls, so agents are paused (fail closed). Try again in a moment." };
  if (c.suspendedAgents.includes(agent)) return { kind: "suspended", message: "this agent is suspended by an administrator." };
  if (workspace?.db) {
    const ws = await loadWorkspacePolicy(workspace.db, workspace.ownerId);
    if (ws === "unavailable") return { kind: "unavailable", message: "Orbis Bastion couldn't read your workspace's security policy, so agents are paused (fail closed). Try again in a moment." };
    if (agentPaused(ws.current.policy, `task:${agent}`)) return { kind: "paused", message: "this agent is paused by your workspace's security policy (Bastion → Agents)." };
  }
  return null;
}

/** The workspace policy of the signed-in account (null without a database session). */
export async function workspacePolicy(db: SupabaseClient | null, ownerId: string): Promise<CustomerPolicy | null | "unavailable"> {
  return workspaceOf({ db, userId: ownerId, kind: "user", agent: "" });
}

/** Refusals recorded for one run since it started (for containment after repeated refusals). */
export async function refusalsInRun(db: SupabaseClient, userId: string, runId: string, since: string): Promise<number> {
  const { data } = await db.from("security_audit").select("detail").eq("user_id", userId).eq("action", "bastion.deny").gte("created_at", since).order("created_at", { ascending: false }).limit(200);
  return ((data ?? []) as { detail: { runId?: string } }[]).filter((r) => r.detail?.runId === runId).length;
}
