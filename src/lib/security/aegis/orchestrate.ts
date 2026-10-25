import { fingerprint } from "../types";
import type { DomainCoverage } from "./coverage";
import type { Asset, AegisFinding, AegisRun } from "./model";
import type { AegisPath } from "./paths";
import type { Prioritised } from "./risk";
import { ROSTER, type RosterId } from "./roster";

/**
 * Orchestration: the work Aegis proposes, each item with a stable id, the agent best suited to it, scope,
 * objective, deadline, completion criteria, prerequisites and dependencies. Before proposing a task Aegis checks
 * it's in scope (an asset you own and have connected), which agent can do it and what that agent needs; tasks for
 * agents that don't exist are shown as blocked with the reason, not handed to anything.
 *
 * Tasks are started by you (or through the agent's own page) and completed only by evidence: a later run of the
 * assigned agent on the same asset, or a re-check showing a finding is gone. Independent tasks (different assets
 * or agents) can run in parallel; a task with dependencies waits for them.
 */

export type TaskState = "proposed" | "accepted" | "blocked" | "done" | "dismissed";

export interface AegisTask {
  id: string;
  /** The agent assigned, or "you" for decisions only a person can make. */
  agent: RosterId | "you";
  kind: "assess" | "investigate" | "repair" | "verify" | "confirm_link" | "connect";
  title: string;
  scope: string;
  objective: string;
  completion: string;
  /** Days from acceptance; a suggestion, not an SLA. */
  dueInDays: number;
  requires: string[];
  dependsOn: string[];
  parallel: boolean;
  findingIds: string[];
  state: TaskState;
  stateReason: string;
  acceptedAt: string | null;
  start: string | null;
}

export interface TaskEvent {
  detail: Record<string, unknown>;
  created_at: string;
}

const tid = (...parts: string[]) =>
  `T-${fingerprint("aegis-task", ...parts)
    .slice(0, 8)
    .toUpperCase()}`;
const rosterStatus = (id: RosterId | "you") => (id === "you" ? "available" : (ROSTER.find((r) => r.id === id)?.status ?? "unavailable"));

export function planTasks(input: { assets: Asset[]; ranked: Prioritised[]; paths: AegisPath[]; coverage: DomainCoverage[]; verifiedHosts: string[] }): AegisTask[] {
  const tasks: AegisTask[] = [];
  const add = (t: Omit<AegisTask, "id" | "state" | "stateReason" | "acceptedAt"> & { key: string[] }) => {
    const { key, ...rest } = t;
    const id = tid(...key);
    if (tasks.some((x) => x.id === id)) return;
    const blocked = rosterStatus(rest.agent) === "unavailable";
    tasks.push({ id, ...rest, state: blocked ? "blocked" : "proposed", stateReason: blocked ? `${ROSTER.find((r) => r.id === rest.agent)?.name} isn't built.` : "", acceptedAt: null });
  };

  // Immediate risks first: investigate, then repair, then verify (sequenced).
  for (const p of input.ranked.filter((r) => r.tier === "immediate").slice(0, 10)) {
    const f = p.finding;
    const inv = tid("investigate", f.id);
    add({
      key: ["investigate", f.id],
      agent: f.agent === "threat_hunter" ? "threat_hunter" : "incident_commander",
      kind: "investigate",
      title: `Investigate: ${f.title}`,
      scope: f.asset,
      objective: "Confirm whether the weakness is real and reachable, and whether it has been exploited; record the conclusion with evidence.",
      completion: "A conclusion (with evidence) is recorded on the Investigations tab.",
      dueInDays: 1,
      requires: f.agent === "threat_hunter" ? ["The logs covering the period"] : ["Access to the system's logs if exploitation is suspected"],
      dependsOn: [],
      parallel: true,
      findingIds: [f.id],
      start: f.agent === "threat_hunter" ? "/agents/security/hunter" : `/agents/security/findings/${f.id}`,
    });
    const code = f.agent === "code_guardian" && f.asset.startsWith("github:");
    const rep = tid("repair", f.id);
    add({
      key: ["repair", f.id],
      agent: code ? "code_guardian" : f.agent === "sentinel" ? "sentinel" : "incident_commander",
      kind: "repair",
      title: `Fix: ${f.title}`,
      scope: f.asset,
      objective: "Apply the smallest fix for the root cause, with your approval for every change.",
      completion: "The remediation reaches 'Verification required' (fix applied).",
      dueInDays: 3,
      requires: code ? ["Your approval of the coding agent's plan and edits"] : ["A person to apply the fix in the affected system (Orbis can't change it)"],
      dependsOn: [inv],
      parallel: false,
      findingIds: [f.id],
      start: `/agents/security/findings/${f.id}`,
    });
    add({
      key: ["verify", f.id],
      agent: f.agent === "threat_hunter" ? "threat_hunter" : (f.agent as RosterId),
      kind: "verify",
      title: `Verify the fix: ${f.title}`,
      scope: f.asset,
      objective: "Re-check the finding with the agent that found it.",
      completion: "A re-check marks the finding not detected.",
      dueInDays: 4,
      requires: [],
      dependsOn: [rep],
      parallel: false,
      findingIds: [f.id],
      start: `/agents/security/findings/${f.id}`,
    });
  }

  // Coverage: verified websites and repositories that are unscanned or stale.
  for (const h of input.verifiedHosts) {
    const a = input.assets.find((x) => x.key === h);
    const last = a?.lastAssessed.find((l) => l.agent === "sentinel");
    if (last && (Date.now() - Date.parse(last.at)) / 86_400_000 <= 30) continue;
    add({
      key: ["assess", "sentinel", h],
      agent: "sentinel",
      kind: "assess",
      title: `${last ? "Re-assess" : "Assess"} ${h}`,
      scope: h,
      objective: "Run a Sentinel audit so the website's posture is current.",
      completion: "A completed Sentinel run on this website after the task was accepted.",
      dueInDays: 7,
      requires: ["Ownership verified (done)"],
      dependsOn: [],
      parallel: true,
      findingIds: [],
      start: "/agents/security",
    });
  }
  for (const a of input.assets.filter((x) => x.kind === "repository")) {
    const last = a.lastAssessed.find((l) => l.agent === "code_guardian");
    if (last && (Date.now() - Date.parse(last.at)) / 86_400_000 <= 30) continue;
    add({
      key: ["assess", "code_guardian", a.key],
      agent: "code_guardian",
      kind: "assess",
      title: `Re-audit ${a.label}`,
      scope: a.key,
      objective: "Run Code Guardian so security and engineering findings are current.",
      completion: "A completed Code Guardian run on this repository after the task was accepted.",
      dueInDays: 14,
      requires: ["Repository access"],
      dependsOn: [],
      parallel: true,
      findingIds: [],
      start: "/agents/security",
    });
  }

  // Paths that rest on an assumed link: ask the person to confirm the relationship.
  for (const p of input.paths.filter((x) => x.relations.some((r) => r.basis === "not linked (assumed)")).slice(0, 5))
    add({
      key: ["link", p.id],
      agent: "you",
      kind: "confirm_link",
      title: `Confirm whether ${p.assets.join(" and ")} are the same system`,
      scope: p.assets.join(", "),
      objective: `The attack path "${p.title}" only applies if they are. Link them on the Assets tab, or ignore the path.`,
      completion: "The assets are linked (or the task is dismissed).",
      dueInDays: 7,
      requires: ["Your knowledge of the systems"],
      dependsOn: [],
      parallel: true,
      findingIds: p.findingIds,
      start: null,
    });

  // Unavailable domains: what would be needed.
  for (const d of input.coverage.filter((c) => c.state === "unavailable"))
    add({
      key: ["connect", d.id],
      agent: d.id === "cloud" ? "cloud_guardian" : d.id === "identity" ? "identity_guardian" : d.id === "validation" ? "red_team" : "compliance_privacy",
      kind: "connect",
      title: `${d.label}: not covered`,
      scope: "Environment",
      objective: d.gaps[0] ?? "No agent covers this area.",
      completion: "Not possible until the capability exists.",
      dueInDays: 90,
      requires: [],
      dependsOn: [],
      parallel: true,
      findingIds: [],
      start: null,
    });
  return tasks;
}

/** Apply recorded decisions and evidence to the plan: accepted/dismissed by you, done when the evidence shows it. */
export function taskStates(tasks: AegisTask[], events: TaskEvent[], runs: AegisRun[], findings: AegisFinding[], remediations: { findingIds: string[]; status: string }[]): AegisTask[] {
  const decided = new Map<string, { action: string; at: string }>();
  for (const e of [...events].sort((a, b) => a.created_at.localeCompare(b.created_at)))
    if (typeof e.detail.taskId === "string") decided.set(e.detail.taskId, { action: String(e.detail.action), at: e.created_at });
  const byId = new Map(findings.map((f) => [f.id, f]));
  const out = tasks.map((t) => {
    const d = decided.get(t.id);
    if (t.state === "blocked") return t;
    if (d?.action === "dismiss") return { ...t, state: "dismissed" as const, stateReason: `Dismissed ${d.at.slice(0, 10)}`, acceptedAt: null };
    const acceptedAt = d?.action === "accept" ? d.at : null;
    let done = false;
    let reason = "";
    if (t.kind === "assess" && acceptedAt) {
      const r = runs.find((x) => x.agent === t.agent && x.asset === t.scope && x.status === "completed" && x.started_at > acceptedAt);
      if (r) [done, reason] = [true, `Run ${r.id.slice(0, 8)} completed ${r.started_at.slice(0, 10)}`];
    }
    if (t.kind === "verify") {
      const f = byId.get(t.findingIds[0]!);
      if (f && (f.verification === "not_detected" || f.status === "verified")) [done, reason] = [true, "A re-check no longer detects it."];
    }
    if (t.kind === "repair" && remediations.some((r) => r.findingIds.includes(t.findingIds[0]!) && ["verification_required", "verified", "partially_resolved"].includes(r.status)))
      [done, reason] = [true, "Fix applied; verification pending or done."];
    if (t.kind === "investigate" && events.some((e) => e.detail.kind === "investigation" && e.detail.findingId === t.findingIds[0] && e.detail.conclusion))
      [done, reason] = [true, "Conclusion recorded."];
    return { ...t, acceptedAt, state: done ? ("done" as const) : acceptedAt ? ("accepted" as const) : t.state, stateReason: reason };
  });
  // A task whose dependency isn't done yet waits.
  return out.map((t) => {
    const waiting = t.dependsOn.filter((id) => out.find((x) => x.id === id)?.state !== "done");
    return waiting.length && t.state !== "done" && t.state !== "dismissed" && t.state !== "blocked" ? { ...t, stateReason: `Waits for ${waiting.join(", ")}` } : t;
  });
}
