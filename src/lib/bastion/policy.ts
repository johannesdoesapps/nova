import { z } from "zod";

/**
 * Orbis Bastion — the policy every protected action passes before it runs. Pure: the decision depends only on the
 * request, the current controls and the policy below, so it's tested directly (tests/bastion.test.ts).
 *
 * Risk levels: low (read-only analysis), moderate (reversible changes in the user's own workspace, controlled test
 * runs), high (side effects outside the workspace or on sensitive files: needs explicit approval of that exact
 * action), critical (destructive, policy-changing or security-disabling: agents can't do these at all).
 *
 * Decisions fail closed: when the controls can't be read, only low-risk actions are allowed. An agent can never
 * change policy, grant permissions or approve its own action; an approval covers one action by one agent on one
 * resource, so delegating to another agent doesn't carry it over.
 */

export const RISKS = ["low", "moderate", "high", "critical"] as const;
export type Risk = (typeof RISKS)[number];
const RISK_RANK: Record<Risk, number> = { low: 0, moderate: 1, high: 2, critical: 3 };

/** Groups an administrator can switch off in an emergency. */
export const CAPABILITIES = {
  commands: "Commands in project computers",
  file_writes: "File changes by agents",
  connector_reads: "Reading connected services",
  connector_writes: "Actions in connected services (drafts, events, issues, messages)",
  github_push: "Pushing to GitHub",
  network: "Outbound requests made for agents (web search, security scans)",
  code_runs: "Running chat code blocks",
  exports: "Exports and downloads of project data",
  workforce: "Workforce runs",
} as const;
export type Capability = keyof typeof CAPABILITIES;

export interface Operation {
  id: string;
  label: string;
  risk: Risk;
  capability: Capability | null;
  /** The risk can't be configured below this. */
  floor: Risk;
}

export const OPERATIONS = {
  "file.read": { label: "Read project files", risk: "low", capability: null, floor: "low" },
  "connector.read": { label: "Read from a connected service", risk: "low", capability: "connector_reads", floor: "low" },
  "web.search": { label: "Web search or security scan request", risk: "low", capability: "network", floor: "low" },
  "file.write": { label: "Change a project file", risk: "moderate", capability: "file_writes", floor: "moderate" },
  "file.write.sensitive": { label: "Change a secret, CI, deployment or migration file", risk: "high", capability: "file_writes", floor: "high" },
  "file.write.secret_content": { label: "Write a credential into a file", risk: "critical", capability: "file_writes", floor: "critical" },
  "file.delete.bulk": { label: "Delete many files at once", risk: "high", capability: "file_writes", floor: "high" },
  "command.run": { label: "Run a recognised safe command (tests, build, install, read-only)", risk: "moderate", capability: "commands", floor: "moderate" },
  "command.run.unclassified": { label: "Run any other command", risk: "high", capability: "commands", floor: "high" },
  "command.read_secrets": { label: "A command that reads secret files", risk: "high", capability: "commands", floor: "high" },
  "command.destructive": { label: "Destructive, publishing or deploying command", risk: "critical", capability: "commands", floor: "critical" },
  "preview.start": { label: "Start a preview server", risk: "moderate", capability: "commands", floor: "moderate" },
  "checkpoint.restore": { label: "Restore a checkpoint", risk: "moderate", capability: "file_writes", floor: "moderate" },
  "code.run": { label: "Run a code block in an isolated sandbox", risk: "moderate", capability: "code_runs", floor: "low" },
  "connector.write": { label: "Act in a connected service", risk: "high", capability: "connector_writes", floor: "high" },
  "github.push": { label: "Push files to GitHub", risk: "high", capability: "github_push", floor: "high" },
  "data.export": { label: "Export or download project data", risk: "moderate", capability: "exports", floor: "low" },
  "workforce.step": { label: "Workforce step", risk: "moderate", capability: "workforce", floor: "moderate" },
  "agent.step": { label: "An agent continues a task", risk: "low", capability: null, floor: "low" },
  "policy.modify": { label: "Change Bastion policy or controls", risk: "critical", capability: null, floor: "critical" },
  "permission.grant": { label: "Grant permissions", risk: "critical", capability: null, floor: "critical" },
} satisfies Record<string, Omit<Operation, "id">>;
export type OperationId = keyof typeof OPERATIONS;
export const operation = (id: OperationId): Operation => ({ id, ...OPERATIONS[id] });

/* ------------------------------------------------------------- controls */

/** The settings an administrator changes (everything except the version bookkeeping). */
export const snapshotSchema = z
  .object({
    /** Everything except low-risk reads is refused. */
    lockdown: z.boolean(),
    suspendedAgents: z.array(z.string().min(1).max(40)).max(40),
    blockedCapabilities: z.array(z.enum(Object.keys(CAPABILITIES) as [Capability, ...Capability[]])).max(20),
    /** Raise (never lower below the floor) an operation's risk level. */
    riskOverrides: z.record(z.string(), z.enum(RISKS)),
  })
  .strict();
export type ControlsSnapshot = z.infer<typeof snapshotSchema>;
export const HISTORY_LIMIT = 20;

export const controlsSchema = snapshotSchema
  .extend({
    version: z.number().int().min(1),
    updatedAt: z.string(),
    /** Previous versions, newest first, with what they were so one can be restored (who changed them is in the admin audit log). */
    history: z.array(z.object({ version: z.number(), at: z.string(), summary: z.string().max(300), snapshot: snapshotSchema.optional() }).strict()).max(HISTORY_LIMIT),
  })
  .strict();
export type BastionControls = z.infer<typeof controlsSchema>;

export const DEFAULT_CONTROLS: BastionControls = { version: 1, updatedAt: "1970-01-01T00:00:00.000Z", lockdown: false, suspendedAgents: [], blockedCapabilities: [], riskOverrides: {}, history: [] };

/** Validate stored controls. Missing → defaults; present but invalid → null (treated as unavailable: fail closed). */
export function parseControls(raw: unknown): BastionControls | null {
  if (raw === undefined || raw === null) return DEFAULT_CONTROLS;
  const r = controlsSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/** Check a proposed change before activation: overrides can't go below an operation's floor. */
export function validateControls(next: BastionControls): string | null {
  for (const [op, risk] of Object.entries(next.riskOverrides)) {
    const o = OPERATIONS[op as OperationId];
    if (!o) return `Unknown operation "${op}".`;
    if (RISK_RANK[risk] < RISK_RANK[o.floor]) return `"${o.label}" can't be set below ${o.floor} risk.`;
  }
  if (next.suspendedAgents.includes("bastion")) return "Bastion can't suspend itself.";
  return null;
}

export const snapshotOf = (c: BastionControls): ControlsSnapshot => ({
  lockdown: c.lockdown,
  suspendedAgents: c.suspendedAgents,
  blockedCapabilities: c.blockedCapabilities,
  riskOverrides: c.riskOverrides,
});

/** What changed between two versions, in words (for the history and the audit log). */
export function describeChange(prev: ControlsSnapshot, next: ControlsSnapshot): string {
  const out: string[] = [];
  if (prev.lockdown !== next.lockdown) out.push(next.lockdown ? "lockdown on" : "lockdown off");
  const diff = (a: string[], b: string[]) => [b.filter((x) => !a.includes(x)), a.filter((x) => !b.includes(x))] as const;
  const [susp, unsusp] = diff(prev.suspendedAgents, next.suspendedAgents);
  if (susp.length) out.push(`suspended ${susp.join(", ")}`);
  if (unsusp.length) out.push(`resumed ${unsusp.join(", ")}`);
  const [blocked, unblocked] = diff(prev.blockedCapabilities, next.blockedCapabilities);
  if (blocked.length) out.push(`blocked ${blocked.join(", ")}`);
  if (unblocked.length) out.push(`unblocked ${unblocked.join(", ")}`);
  const ops = new Set([...Object.keys(prev.riskOverrides), ...Object.keys(next.riskOverrides)]);
  for (const op of ops) if (prev.riskOverrides[op] !== next.riskOverrides[op]) out.push(`${op} → ${next.riskOverrides[op] ?? "default"}`);
  return out.join("; ").slice(0, 300) || "no change";
}

export function riskOf(op: OperationId, controls: BastionControls | null): Risk {
  const base = OPERATIONS[op].risk as Risk;
  const over = controls?.riskOverrides[op];
  return over && RISK_RANK[over] > RISK_RANK[base] ? over : base;
}

/* ------------------------------------------------------------- decisions */

export interface GuardRequest {
  actor: { kind: "agent" | "user" | "system"; agent: string; userId: string; runId?: string | null };
  op: OperationId;
  /** What it acts on: a file path, a command, a connector action, a URL… */
  resource: string;
  /** A person's approval of exactly this action (from the product's own approval step). */
  approval?: { actionHash: string } | null;
}

export type Outcome = "allow" | "deny" | "needs_approval";

export interface Decision {
  outcome: Outcome;
  risk: Risk;
  op: OperationId;
  reason: string;
  actionHash: string;
  policyVersion: number | null;
}

/** Stable hash of who does what to which resource — what an approval is bound to. */
export function actionHash(r: Pick<GuardRequest, "actor" | "op" | "resource">): string {
  const s = `${r.actor.userId}|${r.actor.agent}|${r.op}|${r.resource}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 0x01000193);
    h2 = Math.imul(h2 ^ s.charCodeAt(i), 0x811c9dc5);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0).toString(16).padStart(8, "0")}`;
}

export function decide(req: GuardRequest, controls: BastionControls | null): Decision {
  const risk = riskOf(req.op, controls);
  const hash = actionHash(req);
  const base = { risk, op: req.op, actionHash: hash, policyVersion: controls?.version ?? null };
  const deny = (reason: string): Decision => ({ ...base, outcome: "deny", reason });
  const o = OPERATIONS[req.op];

  // Policy changes come only from a person (an administrator, checked by the route and the database), always with
  // explicit confirmation — and stay possible in lockdown or when the stored controls are broken, so they can be fixed.
  if (req.op === "policy.modify" || req.op === "permission.grant") {
    if (req.actor.kind !== "user") return deny("Agents can't change Bastion policy or grant permissions; only an administrator can, from the Bastion page.");
    return req.approval?.actionHash === hash
      ? { ...base, outcome: "allow", reason: "Confirmed by an administrator." }
      : { ...base, outcome: "needs_approval", reason: `${o.label} is critical: it needs explicit confirmation.` };
  }
  if (!controls)
    return risk === "low"
      ? { ...base, outcome: "allow", reason: "Low-risk action allowed while Bastion's controls are unavailable." }
      : deny("Bastion couldn't confirm its controls, so protected actions are paused (fail closed). Try again in a moment.");
  if (controls.lockdown && risk !== "low") return deny("Orbis is in lockdown: an administrator has paused every action except reading.");
  if (req.actor.kind === "agent" && controls.suspendedAgents.includes(req.actor.agent)) return deny(`The ${req.actor.agent.replace("_", " ")} agent is suspended by an administrator.`);
  if (o.capability && controls.blockedCapabilities.includes(o.capability)) return deny(`${CAPABILITIES[o.capability]} ${o.capability.endsWith("s") ? "are" : "is"} switched off by an administrator.`);
  if (risk === "critical") {
    if (req.actor.kind !== "user" || req.op === "file.write.secret_content") return deny(`${o.label} isn't allowed ${req.actor.kind === "user" ? "here" : "for agents"}.`);
    return req.approval?.actionHash === hash
      ? { ...base, outcome: "allow", reason: "Confirmed by the user for this exact action." }
      : { ...base, outcome: "needs_approval", reason: `${o.label} is critical: it needs explicit confirmation.` };
  }
  if (risk === "high") {
    if (req.approval?.actionHash === hash) return { ...base, outcome: "allow", reason: "Approved by the user for this exact action." };
    return { ...base, outcome: "needs_approval", reason: `${o.label} needs your approval.` };
  }
  return { ...base, outcome: "allow", reason: risk === "low" ? "Low-risk action." : "Within the workspace's permitted actions." };
}

/** Proportionate containment: stop a run after repeated denials (not on a single harmless refusal). */
export const CONTAIN_AFTER = 5;
export const shouldContain = (deniedInRun: number) => deniedInRun >= CONTAIN_AFTER;
