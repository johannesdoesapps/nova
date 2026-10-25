import { correlate } from "../correlate";
import { isEngineering } from "../guardian/categories";
import { securityCoverage, type DomainCoverage } from "./coverage";
import { duplicateCandidates, type DuplicateGroup } from "./dedupe";
import { buildModel, foldAssetFacts, OPEN, type Asset, type AegisFinding, type AegisRun, type Identity } from "./model";
import { planTasks, taskStates, type AegisTask } from "./orchestrate";
import { aegisPaths, type AegisPath } from "./paths";
import { activeExceptions, MODEL_ASSUMPTIONS, prioritise, type Prioritised } from "./risk";
import { ROSTER, type RosterAgent } from "./roster";
import { investigationRecord, remediations, type InvestigationRecord, type Remediation } from "./workflow";

/**
 * Everything Aegis shows, assembled from stored data in one pure function: the model, prioritised risks, attack
 * paths, duplicates, coverage, tasks, investigations, remediations, agent health and the answers to Aegis's five
 * questions. Inputs are the user's own findings, runs, verified targets and Aegis decision events, plus the CISA
 * KEV catalogue when it could be fetched.
 */

export interface AegisEvent {
  action: string;
  detail: Record<string, unknown>;
  created_at: string;
}

export interface AegisInput {
  findings: AegisFinding[];
  runs: AegisRun[];
  verifiedHosts: string[];
  events: AegisEvent[];
  kev: { cves: Map<string, { ransomware: boolean }>; available: boolean; retrievedAt: string | null };
  abuseIpdb: boolean;
  /** Orbis Bastion's recorded decisions on this user's agents (null when not loaded). */
  bastion: { available: boolean; lockdown: boolean; decisions: number; denied: number; needsApproval: number } | null;
  now?: number;
}

export interface AgentHealth {
  agent: RosterAgent;
  runs: number;
  failed: number;
  lastRun: string | null;
  lastFailure: string | null;
}

export interface AegisState {
  generatedAt: string;
  answers: { happening: string[]; matters: string[]; evidence: string[]; next: string[]; resolved: string[] };
  assets: Asset[];
  identities: Identity[];
  ranked: Prioritised[];
  excluded: { id: string; title: string; reason: string }[];
  paths: AegisPath[];
  duplicates: DuplicateGroup[];
  coverage: ReturnType<typeof securityCoverage>;
  tasks: AegisTask[];
  investigations: InvestigationRecord[];
  remediations: Remediation[];
  agents: AgentHealth[];
  timeline: { at: string; agent: string; text: string; ref: string }[];
  assumptions: string[];
  intel: { kevAvailable: boolean; kevRetrievedAt: string | null; abuseIpdb: boolean };
  changes: { newSince: number; resolvedSince: number; since: string | null };
  bastion: AegisInput["bastion"];
}

const of = (events: AegisEvent[], action: string) => events.filter((e) => e.action === action);

export function assembleAegis(input: AegisInput): AegisState {
  const now = input.now ?? Date.now();
  const facts = foldAssetFacts(of(input.events, "aegis.asset"));
  const { assets, identities } = buildModel({ findings: input.findings, runs: input.runs, verifiedHosts: input.verifiedHosts, facts });
  const exceptions = activeExceptions(of(input.events, "aegis.exception"), now);
  const sec = input.findings.filter((f) => !isEngineering(f.rule_id) || f.rule_id.startsWith("compat."));
  const pairs = correlate(sec.filter((f) => OPEN.has(f.status)).map((f) => ({ id: f.id, agent: f.agent, rule_id: f.rule_id, title: f.title, location: f.location, evidence: f.evidence }))).pairs;
  const attempted = new Set<string>();
  const byId = new Map(input.findings.map((f) => [f.id, f]));
  for (const [a, b] of pairs) {
    const x = byId.get(a);
    const y = byId.get(b);
    if (x?.agent === "threat_hunter" && y && y.agent !== "threat_hunter") attempted.add(y.id);
    if (y?.agent === "threat_hunter" && x && x.agent !== "threat_hunter") attempted.add(x.id);
  }
  const malicious = new Set<string>();
  for (const r of input.runs)
    if (
      r.agent === "threat_hunter" &&
      r.asset &&
      Array.isArray(r.stats.investigations) &&
      (r.stats.investigations as { state: string }[]).some((i) => i.state === "likely_malicious" || i.state === "confirmed_malicious")
    )
      malicious.add(r.asset);
  const { ranked, excluded } = prioritise(input.findings, { assets, kev: input.kev.cves, maliciousActivity: malicious, attempted, excepted: new Set(exceptions.keys()) });
  const paths = aegisPaths(sec, assets, { kev: new Set(input.kev.cves.keys()) });
  const duplicates = duplicateCandidates(input.findings);
  const coverage = securityCoverage({ runs: input.runs, assets, findings: input.findings, verifiedHosts: input.verifiedHosts, abuseIpdb: input.abuseIpdb, kevAvailable: input.kev.available, now });
  const workflowEvents = of(input.events, "aegis.workflow");
  const rems = remediations(
    workflowEvents.filter((e) => e.detail.kind === "remediation"),
    input.findings,
  );
  const tasks = taskStates(
    planTasks({ assets, ranked, paths, coverage: coverage.domains, verifiedHosts: input.verifiedHosts }),
    of(input.events, "aegis.task").concat(workflowEvents),
    input.runs,
    input.findings,
    rems,
  );
  const highImpact = ranked.filter((r) => r.tier === "immediate" || (r.tier === "priority" && (r.finding.severity === "critical" || r.finding.severity === "high"))).slice(0, 15);
  const investigations = highImpact.map((r) => investigationRecord(r.finding, input.findings, workflowEvents, { kev: new Set(input.kev.cves.keys()), attempted, malicious }));

  const agents: AgentHealth[] = ROSTER.map((agent) => {
    const rs = input.runs.filter((r) => r.agent === agent.id);
    return {
      agent,
      runs: rs.length,
      failed: rs.filter((r) => r.status === "failed").length,
      lastRun: rs[0]?.started_at ?? null,
      lastFailure: rs.find((r) => r.status === "failed")?.started_at ?? null,
    };
  });

  const timeline = [
    ...input.runs
      .slice(0, 40)
      .map((r) => ({ at: r.started_at, agent: r.agent, text: `${r.agent.replace("_", " ")} ${r.action} on ${r.asset ?? "—"}: ${r.status}`, ref: `/agents/security/runs/${r.id}` })),
    ...input.findings
      .filter((f) => f.severity === "critical" || f.severity === "high")
      .slice(0, 40)
      .map((f) => ({ at: f.first_seen, agent: f.agent, text: `New ${f.severity} finding: ${f.title}`, ref: `/agents/security/findings/${f.id}` })),
    ...input.events
      .filter((e) => e.action.startsWith("aegis."))
      .slice(0, 40)
      .map((e) => ({ at: e.created_at, agent: "aegis", text: describeEvent(e), ref: "" })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 80);

  const lastAegisView =
    of(input.events, "aegis.viewed")
      .map((e) => e.created_at)
      .sort()
      .at(-1) ?? null;
  const since = lastAegisView ?? new Date(now - 7 * 86_400_000).toISOString();
  const changes = {
    newSince: input.findings.filter((f) => f.first_seen > since && !isEngineering(f.rule_id)).length,
    resolvedSince: input.findings.filter((f) => f.verification === "not_detected" && f.updated_at > since).length,
    since,
  };

  const immediate = ranked.filter((r) => r.tier === "immediate");
  const priority = ranked.filter((r) => r.tier === "priority");
  const assessed = coverage.domains.filter((d) => d.state === "assessed").length;
  const answers = {
    happening: [
      `${input.runs.filter((r) => r.status === "completed").length} completed agent runs across ${assets.length} assets; ${assessed} of ${coverage.domains.length} security domains fully assessed.`,
      ...(malicious.size ? [`Threat Hunter rated activity likely or confirmed malicious on: ${[...malicious].join(", ")}.`] : ["No investigation is rated likely or confirmed malicious."]),
      `${changes.newSince} new security finding(s) and ${changes.resolvedSince} resolved since ${since.slice(0, 10)}.`,
      ...(input.bastion
        ? [
            !input.bastion.available
              ? "Orbis Bastion can't confirm its controls right now, so agents' protected actions are paused (fail closed)."
              : `Orbis Bastion ${input.bastion.lockdown ? "is in lockdown; " : ""}recorded ${input.bastion.denied} refused and ${input.bastion.needsApproval} approval-needed action(s) by your agents.`,
          ]
        : []),
    ],
    matters: immediate.length
      ? immediate.slice(0, 3).map((r) => `${r.finding.title} (${r.finding.asset}) — ${r.why}`)
      : [`Nothing needs immediate attention. ${priority.length} weakness(es) should be fixed soon.`],
    evidence: ["Every risk links to its findings, and every finding to the agent's evidence.", `${coverage.unconfirmed} open finding(s) are unconfirmed (tentative) and need a person to check.`],
    next: tasks
      .filter((t) => t.state === "proposed" || t.state === "accepted")
      .slice(0, 3)
      .map((t) => `${t.title} (${t.agent === "you" ? "you" : (ROSTER.find((a) => a.id === t.agent)?.name ?? t.agent)})`),
    resolved: [
      `${rems.filter((r) => r.status === "verified").length} remediation(s) verified by re-check, ${rems.filter((r) => r.status === "verification_required").length} waiting for a re-check, ${rems.filter((r) => r.status === "failed" || r.status === "partially_resolved").length} not (fully) resolved.`,
    ],
  };
  if (!answers.next.length) answers.next.push("No open tasks.");

  return {
    generatedAt: new Date(now).toISOString(),
    answers,
    assets,
    identities,
    ranked: ranked.slice(0, 200),
    excluded: excluded.slice(0, 100).map((e) => ({ id: e.finding.id, title: e.finding.title, reason: e.reason })),
    paths,
    duplicates,
    coverage,
    tasks,
    investigations,
    remediations: rems,
    agents,
    timeline,
    assumptions: MODEL_ASSUMPTIONS,
    intel: { kevAvailable: input.kev.available, kevRetrievedAt: input.kev.retrievedAt, abuseIpdb: input.abuseIpdb },
    changes,
    bastion: input.bastion,
  };
}

function describeEvent(e: AegisEvent): string {
  const d = e.detail;
  if (e.action === "aegis.asset") return `Asset facts updated: ${String(d.asset)}`;
  if (e.action === "aegis.exception") return d.revoked ? "Risk exception revoked" : `Risk accepted until ${String(d.until ?? "").slice(0, 10)}`;
  if (e.action === "aegis.task") return `Task ${String(d.taskId)} ${String(d.action)}ed`;
  if (e.action === "aegis.workflow" && d.kind === "remediation") return `Remediation ${String(d.title ?? d.remediationId)} → ${String(d.status).replace("_", " ")}`;
  if (e.action === "aegis.workflow" && d.kind === "investigation") return d.conclusion ? `Investigation concluded: ${String(d.outcome)}` : "Investigation note added";
  return e.action;
}

/* -------------------------------------------------------------- reports */

export function executiveReport(s: AegisState): string {
  const imm = s.ranked.filter((r) => r.tier === "immediate");
  const pri = s.ranked.filter((r) => r.tier === "priority");
  return [
    `# Security posture — ${s.generatedAt.slice(0, 10)}`,
    "",
    "## Overall",
    ...s.answers.happening.map((x) => `- ${x}`),
    "",
    "## Most important risks",
    ...(imm.length ? imm.slice(0, 5).map((r) => `- **${r.finding.title}** (${r.finding.asset}): ${r.why}`) : ["- Nothing needs immediate attention."]),
    ...(pri.length ? [`- ${pri.length} further weakness(es) to fix soon.`] : []),
    "",
    "## Changes",
    `- ${s.changes.newSince} new and ${s.changes.resolvedSince} resolved security findings since ${(s.changes.since ?? "").slice(0, 10)}.`,
    "",
    "## Decisions needed",
    ...(s.tasks
      .filter((t) => t.state === "proposed")
      .slice(0, 5)
      .map((t) => `- ${t.title}`) || []),
    ...s.remediations.filter((r) => r.status === "proposed").map((r) => `- Approve remediation: ${r.title}`),
    "",
    "## Remediation progress",
    ...s.answers.resolved.map((x) => `- ${x}`),
    "",
    "## Not covered",
    ...s.coverage.domains.filter((d) => d.state === "unavailable" || d.state === "not_assessed").map((d) => `- ${d.label}: ${d.state === "unavailable" ? "no capability" : "not assessed yet"}`),
    "",
    "_Generated by Orbis Aegis from recorded findings and runs. Attack paths are hypotheses; absence of findings in unassessed areas isn't evidence of safety._",
  ].join("\n");
}

export function technicalReport(s: AegisState): string {
  const lines = [`# Technical security report — ${s.generatedAt.slice(0, 10)}`, "", "## Prioritised findings"];
  for (const r of s.ranked.slice(0, 30)) {
    const f = r.finding;
    lines.push(
      `### ${f.title}`,
      `- Asset: ${f.asset}${f.location ? ` — ${f.location}` : ""}`,
      `- Found by: ${f.agent} (${f.evidence_source}); severity ${f.severity}; ${r.classification.replace("_", " ")}; tier ${r.tier}; urgency ${r.urgency}`,
      `- Why: ${r.factors.map((x) => x.label).join("; ")}`,
    );
    for (const e of f.evidence.slice(0, 2)) lines.push(`- Evidence: ${e.source}: ${e.detail.slice(0, 200)}`);
    lines.push(`- Remediation: ${f.remediation.slice(0, 400)}`, "");
  }
  lines.push("## Attack-path hypotheses");
  for (const p of s.paths.slice(0, 10))
    lines.push(
      `### ${p.title} (${p.confidence} confidence, not reproduced)`,
      ...p.steps.map((st) => `- ${st.kind}: ${st.text}`),
      ...p.relations.map((r) => `- Link: ${r.basis} — ${r.detail}`),
      `- Break it: ${p.mitigations[0] ?? ""}`,
      "",
    );
  lines.push("## Verification results");
  for (const r of s.remediations) lines.push(`- ${r.title}: ${r.status.replace("_", " ")}${r.remaining.length ? ` — ${r.remaining.join("; ")}` : ""}`);
  lines.push("", "## Coverage gaps", ...s.coverage.domains.flatMap((d) => d.gaps.slice(0, 2).map((g) => `- ${d.label}: ${g}`)));
  return lines.join("\n");
}

export function operationalReport(s: AegisState): string {
  return [
    `# Operations — ${s.generatedAt.slice(0, 10)}`,
    "",
    "## Investigations",
    ...s.investigations.map((i) => `- ${i.steps[0]!.content[0]} — ${i.conclusion ? `concluded: ${i.conclusion.outcome}` : "open"}`),
    "",
    "## Tasks",
    ...s.tasks.map((t) => `- ${t.id} [${t.state}] ${t.title} — ${t.agent}${t.stateReason ? ` (${t.stateReason})` : ""}`),
    "",
    "## Agents",
    ...s.agents.map((a) => `- ${a.agent.name}: ${a.agent.status}; ${a.runs} run(s), ${a.failed} failed${a.lastFailure ? ` (last failure ${a.lastFailure.slice(0, 10)})` : ""}`),
    "",
    "## Waiting on approval or re-check",
    ...s.remediations.filter((r) => r.status === "proposed" || r.status === "verification_required").map((r) => `- ${r.title}: ${r.status.replace("_", " ")}`),
    "",
    "_No scheduled monitoring runs: actions happen when you start them._",
  ].join("\n");
}

export type { DomainCoverage };
