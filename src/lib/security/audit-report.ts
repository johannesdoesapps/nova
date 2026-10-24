import { attackPaths, type AttackPath } from "./attack-paths";
import { coverage, evaluateGate, MODE_INFO, posture, type CoverageArea, type GateResult, type Posture } from "./audit";
import { classify, CLASSIFICATION_LABEL, type FindingLike } from "./details";
import type { AuditConfig } from "./schema";
import type { ToolRun } from "./types";

/**
 * Everything a finished Sentinel audit records besides the findings themselves: posture counts, coverage,
 * attack paths, the gate decision (release gate only), the comparison with the previous audit of the same
 * scope, and the text the report is written from. Pure, so the decision logic is tested without a database.
 */

export interface ChildRun {
  id: string;
  agent: string;
  status: string;
  error: string | null;
  tools: ToolRun[];
  stats: Record<string, unknown>;
}

export interface AuditAnalysis {
  mode: AuditConfig["mode"];
  posture: Posture;
  coverage: CoverageArea[];
  paths: AttackPath[];
  gate: GateResult | null;
  comparison: { created: number; resolved: number; reopened: number; persisting: number; previous: { runId: string; at: string; open: Posture["open"] } | null };
  /** Open findings for the same assets that this audit didn't re-check (e.g. pages outside this crawl). */
  notRechecked: number;
}

const AGENT_LABEL: Record<string, string> = { sentinel: "Website (Sentinel)", code_guardian: "Code (Code Guardian)", threat_hunter: "Logs (Threat Hunter)" };
const num = (v: unknown) => (typeof v === "number" ? v : 0);

export function analyseAudit(input: {
  cfg: AuditConfig;
  plan: string[];
  children: ChildRun[];
  findings: (FindingLike & { id: string; run_id?: string | null })[];
  notRechecked: number;
  previous: { runId: string; at: string; stats: Record<string, unknown> } | null;
}): AuditAnalysis {
  const { cfg, plan, children, findings } = input;
  const latest = (agent: string) => children.filter((c) => c.agent === agent).pop();
  const site = latest("sentinel");
  const code = latest("code_guardian");
  const logs = latest("threat_hunter");
  const ok = (c?: ChildRun) => c?.status === "completed";
  const tool = (c: ChildRun | undefined, name: string) => c?.tools.find((t) => t.tool === name)?.status;
  const surface = (site?.stats.surface ?? {}) as { notFetched?: unknown[] };
  const codeMap = (code?.stats.codeMap ?? {}) as { unmapped?: string[] };

  const cov = coverage({
    website: ok(site),
    active: cfg.active,
    pagesFetched: ok(site) ? Math.max(1, num(site!.stats.pagesFetched)) : 0,
    pagesNotFetched: Array.isArray(surface.notFetched) ? surface.notFetched.length : 0,
    endpointsChecked: Array.isArray(site?.stats.endpointResults) ? (site!.stats.endpointResults as unknown[]).length : 0,
    code: ok(code),
    routesMapped: num(code?.stats.routes),
    unmapped: codeMap.unmapped ?? [],
    deps: !ok(code) ? "not_run" : ((tool(code, "OSV dependency check") as "ok" | "skipped" | "failed" | undefined) ?? "not_run"),
    aiReview: tool(code, "AI code review") === "ok",
    logs: ok(logs),
  });

  const childIds = new Set(children.map((c) => c.id));
  const steps = plan.map((agent) => ({ label: AGENT_LABEL[agent] ?? agent, status: latest(agent)?.status ?? "missing" }));
  const prevOpen = (input.previous?.stats.posture as Posture | undefined)?.open;
  return {
    mode: cfg.mode,
    posture: posture(findings),
    coverage: cov,
    paths: attackPaths(findings),
    gate: cfg.mode === "release_gate" ? evaluateGate(findings, cfg.gate, steps) : null,
    comparison: {
      created: children.reduce((n, c) => n + num(c.stats.created), 0),
      resolved: children.reduce((n, c) => n + num(c.stats.resolved), 0),
      reopened: children.reduce((n, c) => n + num(c.stats.reopened), 0),
      persisting: findings.filter((f) => f.run_id && !childIds.has(f.run_id)).length,
      previous: input.previous && prevOpen ? { runId: input.previous.runId, at: input.previous.at, open: prevOpen } : null,
    },
    notRechecked: input.notRechecked,
  };
}

/** What's kept with the run (security_runs.stats is limited to 20 KB). */
export function compactAnalysis(a: AuditAnalysis) {
  return {
    posture: a.posture,
    coverage: a.coverage.map((c) => ({ ...c, checked: c.checked.map((x) => x.slice(0, 200)), notChecked: c.notChecked.slice(0, 8).map((x) => x.slice(0, 200)) })),
    paths: a.paths.slice(0, 12).map((p) => ({ ...p, steps: p.steps.map((s) => ({ ...s, text: s.text.slice(0, 300), findingIds: s.findingIds.slice(0, 8) })), findingIds: p.findingIds.slice(0, 20) })),
    gate: a.gate ? { ...a.gate, blocking: a.gate.blocking.slice(0, 25) } : null,
    comparison: a.comparison,
    notRechecked: a.notRechecked,
  };
}
export type StoredAnalysis = ReturnType<typeof compactAnalysis>;

/** The data the AI report is written from — every line is from the analysis, nothing else. */
export function auditSections(a: AuditAnalysis, findings: (FindingLike & { id: string })[], children: ChildRun[], plan: string[]): string {
  const lines: string[] = [];
  lines.push(`Mode: ${MODE_INFO[a.mode].label}.`);
  if (a.gate) lines.push(`Gate result: ${a.gate.outcome.toUpperCase()}. ${a.gate.reasons.join(" ") || "No blocking findings and every check ran."}`);
  for (const agent of plan) {
    const c = children.filter((x) => x.agent === agent).pop();
    lines.push(
      `${AGENT_LABEL[agent] ?? agent}: ${c ? `${c.status}${c.error ? ` (${c.error})` : ""}; steps: ${c.tools.map((t) => `${t.tool}=${t.status}${t.detail ? ` (${t.detail.slice(0, 120)})` : ""}`).join("; ")}` : "did not run"}.`,
    );
  }
  const p = a.posture;
  lines.push(
    `Open findings by severity: ${Object.entries(p.open)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}. Confirmed or likely: ${p.confirmedOrLikely}; needs verification: ${p.unverified}.`,
  );
  lines.push(
    `Since earlier runs: ${a.comparison.created} new, ${a.comparison.resolved} no longer detected, ${a.comparison.reopened} reappeared after being fixed, ${a.comparison.persisting} seen before and still present.`,
  );
  if (a.notRechecked) lines.push(`${a.notRechecked} earlier open finding(s) for these assets weren't re-checked by this audit (outside this run's scope or budget).`);
  lines.push("", "Findings (most severe first):");
  const order = ["critical", "high", "medium", "low", "info"];
  for (const f of [...findings].sort((x, y) => order.indexOf(x.severity) - order.indexOf(y.severity)).slice(0, 40))
    lines.push(
      `- [${f.severity}, ${CLASSIFICATION_LABEL[classify(f, findings)]}] ${f.title} — ${f.location ?? f.asset}. Evidence: ${f.evidence
        .map((e) => `${e.source}: ${e.detail}`)
        .join(" | ")
        .slice(0, 240)}. Fix: ${f.remediation.slice(0, 200)}`,
    );
  if (findings.length > 40) lines.push(`(${findings.length - 40} more not listed.)`);
  lines.push("", "Attack paths:");
  if (!a.paths.length) lines.push("None found from these findings.");
  for (const path of a.paths.slice(0, 10))
    lines.push(
      `- ${path.title} [${path.severity}; ${path.status === "steps_confirmed" ? "steps confirmed (chain not executed)" : "theoretical"}]: ${path.steps.map((s) => `${s.kind}: ${s.text}`).join(" → ")}. Breaks with: ${path.breakWith}`,
    );
  lines.push("", "Coverage:");
  for (const c of a.coverage) lines.push(`- ${c.label}: ${c.state.replace("_", " ")}. Checked: ${c.checked.join("; ") || "nothing"}. Not checked: ${c.notChecked.join("; ") || "nothing listed"}.`);
  return lines.join("\n");
}

/**
 * security_runs.stats is capped at 20 KB by the database. Large maps are shortened (and say so) rather than
 * letting the run fail to save.
 */
export function fitStats(stats: Record<string, unknown>, limit = 19_000): Record<string, unknown> {
  if (JSON.stringify(stats).length <= limit) return stats;
  const out: Record<string, unknown> = { ...stats };
  const shrink = (key: string, list: string, n: number) => {
    const v = out[key] as Record<string, unknown> | undefined;
    if (!v || !Array.isArray(v[list])) return;
    const arr = v[list] as unknown[];
    if (arr.length <= n) return;
    out[key] = { ...v, [list]: arr.slice(0, n), trimmed: [...((v.trimmed as string[]) ?? []), `${list}: showing ${n} of ${arr.length}`] };
  };
  for (const n of [40, 20, 10]) {
    shrink("codeMap", "routes", n);
    shrink("surface", "endpoints", n);
    shrink("surface", "pages", n);
    if (Array.isArray(out.endpointResults)) out.endpointResults = (out.endpointResults as unknown[]).slice(0, n);
    if (JSON.stringify(out).length <= limit) return out;
  }
  delete out.surface;
  delete out.codeMap;
  return { ...out, mapDropped: "The map was too large to store with this run." };
}
