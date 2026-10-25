import { CAPABILITIES, CONTAIN_AFTER, OPERATIONS, riskOf, type BastionControls, type OperationId, type Outcome, type Risk } from "./policy";

/**
 * What the Bastion pages show, computed from recorded decisions (security_audit rows named bastion.*) and the
 * current controls. Pure. Nothing here is a projection: every number is a count of decisions Bastion made.
 */

export interface DecisionEvent {
  action: string;
  detail: Record<string, unknown>;
  created_at: string;
  user_id?: string;
}

export interface DecisionRow {
  at: string;
  outcome: Outcome;
  op: string;
  label: string;
  risk: Risk | string;
  agent: string;
  actor: string;
  runId: string | null;
  resource: string;
  reason: string;
  policyVersion: number | null;
  user?: string;
}

export interface BastionSummary {
  total: number;
  denied: number;
  needsApproval: number;
  approvedHighRisk: number;
  byOp: { op: string; label: string; denied: number; needsApproval: number; allowed: number }[];
  byAgent: { agent: string; denied: number; needsApproval: number; allowed: number }[];
  /** Runs stopped (or that would be stopped) after repeated refusals. */
  contained: { runId: string; agent: string; denied: number }[];
  recent: DecisionRow[];
}

const OUTCOMES: Outcome[] = ["allow", "deny", "needs_approval"];

export function toRow(e: DecisionEvent): DecisionRow | null {
  const outcome = e.action.replace(/^bastion\./, "") as Outcome;
  if (!OUTCOMES.includes(outcome)) return null;
  const d = e.detail ?? {};
  const op = String(d.op ?? "");
  return {
    at: e.created_at,
    outcome,
    op,
    label: OPERATIONS[op as OperationId]?.label ?? op,
    risk: String(d.risk ?? ""),
    agent: String(d.agent ?? ""),
    actor: String(d.actor ?? ""),
    runId: typeof d.runId === "string" ? d.runId : null,
    resource: String(d.resource ?? ""),
    reason: String(d.reason ?? ""),
    policyVersion: typeof d.policyVersion === "number" ? d.policyVersion : null,
    ...(e.user_id ? { user: e.user_id.slice(0, 8) } : {}),
  };
}

export function summarise(events: DecisionEvent[], recent = 60): BastionSummary {
  const rows = events
    .map(toRow)
    .filter((r): r is DecisionRow => !!r)
    .sort((a, b) => b.at.localeCompare(a.at));
  const ops = new Map<string, BastionSummary["byOp"][number]>();
  const agents = new Map<string, BastionSummary["byAgent"][number]>();
  const runs = new Map<string, { runId: string; agent: string; denied: number }>();
  for (const r of rows) {
    const o = ops.get(r.op) ?? { op: r.op, label: r.label, denied: 0, needsApproval: 0, allowed: 0 };
    const a = agents.get(r.agent) ?? { agent: r.agent, denied: 0, needsApproval: 0, allowed: 0 };
    for (const x of [o, a]) {
      if (r.outcome === "deny") x.denied++;
      else if (r.outcome === "needs_approval") x.needsApproval++;
      else x.allowed++;
    }
    ops.set(r.op, o);
    agents.set(r.agent, a);
    if (r.outcome === "deny" && r.runId) {
      const run = runs.get(r.runId) ?? { runId: r.runId, agent: r.agent, denied: 0 };
      run.denied++;
      runs.set(r.runId, run);
    }
  }
  const by = <T extends { denied: number; needsApproval: number }>(a: T, b: T) => b.denied - a.denied || b.needsApproval - a.needsApproval;
  return {
    total: rows.length,
    denied: rows.filter((r) => r.outcome === "deny").length,
    needsApproval: rows.filter((r) => r.outcome === "needs_approval").length,
    approvedHighRisk: rows.filter((r) => r.outcome === "allow").length,
    byOp: [...ops.values()].sort(by),
    byAgent: [...agents.values()].sort(by),
    contained: [...runs.values()].filter((r) => r.denied >= CONTAIN_AFTER).sort((a, b) => b.denied - a.denied),
    recent: rows.slice(0, recent),
  };
}

/** The policy as it applies now: every operation with its effective risk and whether it's switched off. */
export function policyTable(controls: BastionControls | null) {
  return (Object.keys(OPERATIONS) as OperationId[]).map((id) => {
    const o = OPERATIONS[id];
    return {
      id,
      label: o.label,
      base: o.risk,
      floor: o.floor,
      risk: riskOf(id, controls),
      capability: o.capability,
      capabilityLabel: o.capability ? CAPABILITIES[o.capability] : null,
      blocked: !!(o.capability && controls?.blockedCapabilities.includes(o.capability)),
    };
  });
}

/** Agents an administrator can suspend, by the ids Bastion sees them as. */
export const SUSPENDABLE: { id: string; label: string; scope: string }[] = [
  { id: "engineer", label: "Software Engineer", scope: "Stops new tasks and running tasks at their next step." },
  { id: "bug_fixer", label: "Bug Fixing", scope: "Stops new tasks and running tasks at their next step." },
  { id: "qa_tester", label: "QA Testing", scope: "Stops new tasks and running tasks at their next step." },
  { id: "website_builder", label: "Website Builder", scope: "Stops new tasks and running tasks at their next step." },
  { id: "code_review", label: "Code Review", scope: "Stops new reviews from starting." },
  { id: "security", label: "Security Team", scope: "Stops new scans and Aegis actions from starting." },
  { id: "deep_research", label: "Deep Research", scope: "Stops new research from starting." },
  { id: "data_analyst", label: "Data Analyst", scope: "Stops new analyses from starting." },
  { id: "assistant", label: "Chat assistant's connected-service reads", scope: "Chat can't read Gmail, Calendar, Drive and other connected services." },
  { id: "workforce", label: "Workforce", scope: "Stops every Workforce task at its next tick." },
];
