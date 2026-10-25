import { z } from "zod";
import { CAPABILITIES, decide, type BastionControls, type Capability, type Decision, type GuardRequest, type Risk } from "../policy";

/**
 * Bastion Customer Security: the restrictions a workspace adds on top of Bastion Core.
 *
 * A customer policy can only ever add restrictions. It can pause agents, switch capabilities off, require approval
 * for operations that have an approval step, keep coding agents to chosen projects, limit which connected services
 * agents may read, and remove tools from custom agents. Nothing in the schema can lower a risk level, lift a
 * platform suspension or lockdown, or allow something Bastion Core refuses: `effectiveControls` only takes unions
 * and maximums, which tests/bastion-customer.test.ts checks for every field.
 */

/** Operations a workspace may raise to "needs approval" — only ones with an approval step the user can answer. */
export const APPROVABLE_OPS = ["command.run", "file.write", "preview.start"] as const;
export type ApprovableOp = (typeof APPROVABLE_OPS)[number];
export const APPROVABLE_LABEL: Record<ApprovableOp, string> = {
  "command.run": "Every command a coding agent runs (not only unrecognised ones)",
  "file.write": "Every file change a coding agent makes (shown for review before it's saved)",
  "preview.start": "Starting a preview server",
};

/** Capabilities a workspace may switch off for itself (Workforce is an operator tool, not a customer one). */
export const CUSTOMER_CAPABILITIES = ["commands", "file_writes", "connector_reads", "connector_writes", "github_push", "code_runs", "exports", "network"] as const satisfies readonly Capability[];
export type CustomerCapability = (typeof CUSTOMER_CAPABILITIES)[number];

/** Agents a workspace can pause: task agents, built-in chat agents and its own custom agents. */
export const AGENT_REF = /^(task:[a-z_]{2,40}|builtin:[a-z_]{2,20}|custom:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
export const CODE_AGENT_REFS = ["task:engineer", "task:bug_fixer", "task:qa_tester", "task:website_builder"] as const;
export const CUSTOM_CAPS = ["web_search", "file_analysis", "data_analysis", "code_execution"] as const;

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

export const notificationSchema = z
  .object({
    email: z.boolean(),
    critical: z.boolean(),
    repeatedBlocks: z.boolean(),
    credentialExposure: z.boolean(),
    riskyIntegrations: z.boolean(),
    enforcementFailures: z.boolean(),
    blockThreshold: z.number().int().min(3).max(50),
  })
  .strict();

export const customerPolicySchema = z
  .object({
    requireApproval: z.array(z.enum(APPROVABLE_OPS)).max(APPROVABLE_OPS.length),
    blockedCapabilities: z.array(z.enum(CUSTOMER_CAPABILITIES)).max(CUSTOMER_CAPABILITIES.length),
    pausedAgents: z.array(z.string().regex(AGENT_REF)).max(60),
    /** Coding agents may only work in these projects (an agent not listed may work anywhere). */
    agentProjects: z.partialRecord(z.enum(CODE_AGENT_REFS), z.array(uuid).max(100)),
    /** Connected services agents may read; null = all connected ones. */
    allowedIntegrations: z
      .array(z.string().regex(/^[a-z][a-z0-9_]{1,39}$/))
      .max(40)
      .nullable(),
    /** Tools removed from custom agents (by "custom:<id>"). */
    customAgentLimits: z.record(z.string().regex(/^custom:[0-9a-f-]{36}$/), z.array(z.enum(CUSTOM_CAPS)).max(CUSTOM_CAPS.length)),
    notifications: notificationSchema,
    /** How far back history and the audit log are shown (records aren't deleted). Null = the plan's default. */
    retentionDays: z.number().int().min(7).max(3650).nullable(),
  })
  .strict();
export type CustomerPolicy = z.infer<typeof customerPolicySchema>;

export const DEFAULT_CUSTOMER_POLICY: CustomerPolicy = {
  requireApproval: [],
  blockedCapabilities: [],
  pausedAgents: [],
  agentProjects: {},
  allowedIntegrations: null,
  customAgentLimits: {},
  notifications: { email: true, critical: true, repeatedBlocks: true, credentialExposure: true, riskyIntegrations: true, enforcementFailures: true, blockThreshold: 5 },
  retentionDays: null,
};

/** A stored version (from a signed "bastion.policy" audit record). */
export interface PolicyVersion {
  version: number;
  at: string;
  by: string;
  note: string | null;
  summary: string;
  policy: CustomerPolicy;
}

/** Problems with a proposed policy before it's activated (shape is checked by the schema). */
export function validateCustomerPolicy(p: CustomerPolicy, ctx: { customAgents: string[]; projects: string[]; connectors: string[] }): string | null {
  for (const ref of p.pausedAgents) if (ref.startsWith("custom:") && !ctx.customAgents.includes(ref.slice(7))) return "One of the paused agents isn't in this workspace.";
  for (const ref of Object.keys(p.customAgentLimits)) if (!ctx.customAgents.includes(ref.slice(7))) return "A tool limit names an agent that isn't in this workspace.";
  for (const ids of Object.values(p.agentProjects)) for (const id of ids ?? []) if (!ctx.projects.includes(id)) return "A project boundary names a project that isn't in this workspace.";
  for (const [agent, ids] of Object.entries(p.agentProjects))
    if (!ids?.length) return `${agent.slice(5).replace("_", " ")} would have no project it may work in; remove the boundary or pick a project.`;
  for (const id of p.allowedIntegrations ?? []) if (!ctx.connectors.includes(id)) return `${id} isn't a connected service in this workspace.`;
  if (JSON.stringify(p).length > 6000) return "The policy is too large; use fewer project or agent entries.";
  return null;
}

/** What changed, in words (kept in the version history and the audit log). */
export function describePolicyChange(prev: CustomerPolicy, next: CustomerPolicy): string {
  const out: string[] = [];
  const diff = (a: readonly string[], b: readonly string[]) => [b.filter((x) => !a.includes(x)), a.filter((x) => !b.includes(x))] as const;
  const list = (label: string, a: readonly string[], b: readonly string[]) => {
    const [add, rem] = diff(a, b);
    if (add.length) out.push(`${label} +${add.join(", ")}`);
    if (rem.length) out.push(`${label} −${rem.join(", ")}`);
  };
  list("approval", prev.requireApproval, next.requireApproval);
  list("blocked", prev.blockedCapabilities, next.blockedCapabilities);
  list("paused", prev.pausedAgents, next.pausedAgents);
  if (JSON.stringify(prev.agentProjects) !== JSON.stringify(next.agentProjects)) out.push("project boundaries changed");
  if (JSON.stringify(prev.allowedIntegrations) !== JSON.stringify(next.allowedIntegrations))
    out.push(next.allowedIntegrations ? `integrations limited to ${next.allowedIntegrations.join(", ") || "none"}` : "all integrations allowed");
  if (JSON.stringify(prev.customAgentLimits) !== JSON.stringify(next.customAgentLimits)) out.push("custom agent tools changed");
  if (JSON.stringify(prev.notifications) !== JSON.stringify(next.notifications)) out.push("notifications changed");
  if (prev.retentionDays !== next.retentionDays) out.push(`history shown for ${next.retentionDays ?? "the plan's default"} days`);
  return out.join("; ").slice(0, 300) || "no change";
}

/* ------------------------------------------------------------ enforcement */

const RANK: Record<Risk, number> = { low: 0, moderate: 1, high: 2, critical: 3 };
const max = (a: Risk | undefined, b: Risk): Risk => (a && RANK[a] >= RANK[b] ? a : b);

/**
 * Bastion Core's controls with the workspace's restrictions added. Never less strict than `platform` in any field;
 * null (controls unavailable) stays null, so failing closed is unaffected by a workspace.
 */
export function effectiveControls(platform: BastionControls | null, customer: CustomerPolicy | null): BastionControls | null {
  if (!platform || !customer) return platform;
  const overrides = { ...platform.riskOverrides };
  for (const op of customer.requireApproval) overrides[op] = max(platform.riskOverrides[op], "high");
  return {
    ...platform,
    suspendedAgents: [...new Set([...platform.suspendedAgents, ...customer.pausedAgents.filter((r) => r.startsWith("task:")).map((r) => r.slice(5))])],
    blockedCapabilities: [...new Set([...platform.blockedCapabilities, ...customer.blockedCapabilities])],
    riskOverrides: overrides,
  };
}

/** Decide with both layers, and say which layer is responsible when the workspace made it stricter. */
export function decideWithWorkspace(req: GuardRequest, platform: BastionControls | null, customer: CustomerPolicy | null): Decision & { source: "platform" | "workspace" } {
  const base = decide(req, platform);
  const eff = decide(req, effectiveControls(platform, customer));
  if (eff.outcome === base.outcome) return { ...base, source: "platform" };
  return { ...eff, reason: workspaceReason(req, customer!, eff), source: "workspace" };
}

function workspaceReason(req: GuardRequest, c: CustomerPolicy, d: Decision): string {
  if (req.actor.kind === "agent" && c.pausedAgents.includes(`task:${req.actor.agent}`)) return `Your workspace policy has paused the ${req.actor.agent.replace("_", " ")} agent.`;
  if (d.outcome === "deny") return `Your workspace policy switches this off: ${d.reason.replace(/ (is|are) switched off by an administrator\.$/, "")}.`;
  return `Your workspace policy requires approval for this: ${d.reason}`;
}

export const agentPaused = (c: CustomerPolicy | null, ref: string) => !!c?.pausedAgents.includes(ref);

/** Whether a coding agent may work in this project under the workspace's boundaries. */
export function projectAllowed(c: CustomerPolicy | null, agent: string, projectId: string): boolean {
  const ids = c?.agentProjects[`task:${agent}` as (typeof CODE_AGENT_REFS)[number]];
  return !ids || ids.includes(projectId);
}

export const integrationAllowed = (c: CustomerPolicy | null, connectorId: string) => !c?.allowedIntegrations || c.allowedIntegrations.includes(connectorId);

/** A custom agent's tools after the workspace's limits. */
export function customAgentTools<T extends string>(c: CustomerPolicy | null, agentId: string, caps: T[]): T[] {
  const removed = c?.customAgentLimits[`custom:${agentId}`] ?? [];
  return caps.filter((x) => !(removed as string[]).includes(x));
}

export const CAPABILITY_LABEL = CAPABILITIES;

/** What a change would do, in plain words (shown before it's confirmed). */
export function policyImpact(prev: CustomerPolicy, next: CustomerPolicy, names: Record<string, string> = {}): string[] {
  const out: string[] = [];
  const name = (ref: string) => names[ref] ?? ref.replace(/^\w+:/, "").replace("_", " ");
  for (const op of next.requireApproval.filter((x) => !prev.requireApproval.includes(x))) out.push(`Coding agents will stop and ask before: ${APPROVABLE_LABEL[op].toLowerCase()}.`);
  for (const op of prev.requireApproval.filter((x) => !next.requireApproval.includes(x)))
    out.push(`No extra approval for: ${APPROVABLE_LABEL[op].toLowerCase()} (Bastion Core's own approvals still apply).`);
  for (const c of next.blockedCapabilities.filter((x) => !prev.blockedCapabilities.includes(x)))
    out.push(`Switched off for this workspace: ${CAPABILITIES[c].toLowerCase()}. Running tasks that need it will be refused.`);
  for (const c of prev.blockedCapabilities.filter((x) => !next.blockedCapabilities.includes(x))) out.push(`Switched back on: ${CAPABILITIES[c].toLowerCase()}.`);
  for (const a of next.pausedAgents.filter((x) => !prev.pausedAgents.includes(x))) out.push(`${name(a)} is paused: new tasks are refused and running ones stop at their next step.`);
  for (const a of prev.pausedAgents.filter((x) => !next.pausedAgents.includes(x))) out.push(`${name(a)} is resumed.`);
  if (JSON.stringify(prev.agentProjects) !== JSON.stringify(next.agentProjects)) out.push("Coding agents' project boundaries change: tasks outside them are refused, including ones already running.");
  if (JSON.stringify(prev.allowedIntegrations) !== JSON.stringify(next.allowedIntegrations))
    out.push(next.allowedIntegrations ? `Agents may only read: ${next.allowedIntegrations.join(", ") || "no connected services"}.` : "Agents may read every connected service again.");
  if (JSON.stringify(prev.customAgentLimits) !== JSON.stringify(next.customAgentLimits)) out.push("Custom agents' tools change from their next message.");
  if (JSON.stringify(prev.notifications) !== JSON.stringify(next.notifications)) out.push("Security notifications change.");
  if (prev.retentionDays !== next.retentionDays) out.push("How far back history and the audit log are shown changes (records themselves aren't deleted).");
  return out;
}
