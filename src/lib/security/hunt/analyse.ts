import { huntThreats, type LogFile, type TimelineEntry } from "../logs";
import type { IpReputation } from "../reputation";
import { fingerprint, type FindingDraft } from "../types";
import { parseHuntLogs, type HuntEvent, type ParsedLogs } from "./events";
import { buildInvestigations, sharedAddresses, signalFromDetection, signalFromFinding, type Investigation } from "./investigate";
import { newSourceDetections, ruleById, runRules, techniqueUrl, type Detection } from "./rules";

/**
 * The whole Threat Hunter analysis over a set of log files, as one pure function: parse and inventory the
 * sources, run the detection library, adjust for shared addresses, build investigations. The server runner
 * and the validation scenarios both call this, so what's tested is what runs.
 */

export interface Analysis {
  parsed: ParsedLogs;
  findings: FindingDraft[];
  investigations: Investigation[];
  timeline: TimelineEntry[];
  indicators: string[];
  stats: Record<string, number>;
  baselines: { newSource: { assessed: number; insufficient: number } };
  shared: string[];
}

const REMEDIATION: Record<string, string> = {
  "Privilege Escalation": "Confirm the change was authorised; if not, remove the rights, disable the account and review what it did (see the investigation's response plan).",
  Persistence: "Check the new account, credential, job or service against approved changes; remove what isn't approved after preserving evidence.",
  "Defense Evasion": "Re-enable logging or monitoring now, copy the remaining logs somewhere safe, and treat the period after this event as a blind spot.",
  Execution: "Decide whether to isolate the host; capture memory and disk before cleaning; decode commands only in an isolated environment.",
  "Initial Access": "Confirm with the account owner; if it wasn't them, reset credentials, end sessions and enforce MFA.",
  "Command and Control": "Block the domain at your resolver and find the process making the lookups (needs host or EDR data).",
  Exfiltration: "Identify what was in the responses and whether the transfer was expected; block the client if not.",
};

export function detectionToFinding(d: Detection, asset: string): FindingDraft {
  const rule = ruleById(d.ruleId)!;
  return {
    agent: "threat_hunter",
    ruleId: d.ruleId,
    fingerprint: fingerprint("threat_hunter", d.ruleId, asset, d.key),
    title: d.title.slice(0, 300),
    description: `Observed: ${d.observed} Hypothesis: ${rule.hypothesis} Other explanations to rule out: ${rule.benign.join("; ")}.`,
    severity: d.severity,
    confidence: d.confidence,
    rationale: rule.severityRule,
    asset,
    location: d.users[0] ?? d.hosts[0] ?? d.ips[0] ?? null,
    evidence: d.events.slice(0, 6).map((e) => ({ source: e.ref, detail: e.raw.slice(0, 300) })),
    evidenceSource: "orbis:log-analyzer",
    remediation: REMEDIATION[rule.tactic] ?? "Review the evidence and the investigation's response plan.",
    references: rule.techniques.map((t) => techniqueUrl(t.id)),
  };
}

/** Sign-in failures from an address several users successfully sign in from (an office or VPN) are weak evidence. */
function adjustForShared(f: FindingDraft, shared: Set<string>): FindingDraft {
  if (!f.location || !shared.has(f.location) || !/^auth\.(brute-force|password-spray)$/.test(f.ruleId)) return f;
  return {
    ...f,
    severity: "low",
    confidence: "tentative",
    description: `${f.description} Several different users also signed in successfully from this address, so it is probably shared (office, school or VPN); these failures may be ordinary mistakes.`,
    rationale: `${f.rationale} Downgraded: shared address.`,
  };
}

export function analyseLogs(files: LogFile[], asset: string, opts: { year?: number; reputation?: IpReputation[] } = {}): Analysis {
  const parsed = parseHuntLogs(files, opts.year);
  const shared = sharedAddresses(parsed.events);
  const legacy = huntThreats(parsed.legacy, asset);
  const legacyFindings = legacy.findings.map((f) => adjustForShared(f, shared));
  const detections = runRules(parsed);
  const detFindings = detections.map((d) => detectionToFinding(d, asset));
  const byRef = new Map<string, HuntEvent>(parsed.events.map((e) => [e.ref, e]));
  const signals = [...legacyFindings.map((f) => signalFromFinding(f, byRef)), ...detections.map((d, i) => signalFromDetection(d, detFindings[i]!.fingerprint))];
  const investigations = buildInvestigations({
    parsed,
    signals,
    reputation: (opts.reputation ?? []).map((r) => ({
      ip: r.ip,
      score: r.score,
      reports: r.reports,
      sharedHosting: /hosting|data center|content delivery|transit/i.test(r.usageType ?? "") || !!r.isTor,
    })),
  });
  const ns = newSourceDetections(parsed.events);
  return {
    parsed,
    findings: [...legacyFindings, ...detFindings],
    investigations,
    timeline: legacy.timeline,
    indicators: legacy.indicators,
    stats: { ...legacy.stats, events: parsed.events.length, detections: detections.length, investigations: investigations.length },
    baselines: { newSource: { assessed: ns.assessed, insufficient: ns.insufficient } },
    shared: [...shared],
  };
}

/** The data a hunt report is written from: investigations, coverage and intelligence — nothing else. */
export function huntSections(a: Pick<Analysis, "investigations" | "parsed" | "baselines">, intel: { value: string; rating: string | null; caveats: string[] }[] = []): string {
  const lines: string[] = ["Sources analysed:"];
  for (const f of a.parsed.inventory)
    lines.push(
      `- ${f.file}: ${f.events} events (${
        Object.entries(f.formats)
          .map(([k, v]) => `${k} ${v}`)
          .join(", ") || "none recognised"
      }), ${f.unparsed} unrecognised lines, ${f.first ?? "?"} → ${f.last ?? "?"}${f.gaps.length ? `; gaps: ${f.gaps.map((g) => `${g.hours}h from ${g.from}`).join(", ")}` : ""}${f.assumptions.length ? `; ${f.assumptions.join(" ")}` : ""}`,
    );
  lines.push(`New-source baseline: ${a.baselines.newSource.assessed} user(s) had enough history to assess, ${a.baselines.newSource.insufficient} didn't.`);
  lines.push("", "Investigations (highest priority first):");
  if (!a.investigations.length) lines.push("None. No detection fired on the data provided.");
  for (const i of a.investigations.slice(0, 10)) {
    lines.push(`## ${i.id}: ${i.title}`);
    lines.push(
      `State: ${i.state}; severity ${i.severity}; urgency ${i.urgency}; confidence ${i.confidence.level} (${i.confidence.basis}). Window ${i.window.first ?? "?"} → ${i.window.last ?? "?"}${i.ongoing ? " (activity reaches the end of the logs)" : ""}.`,
    );
    lines.push(`Entities: accounts ${i.entities.users.join(", ") || "none"}; hosts ${i.entities.hosts.join(", ") || "none"}; addresses ${i.entities.ips.join(", ") || "none"}. ${i.links.join(" ")}`);
    for (const s of i.signals.slice(0, 8)) lines.push(`- Signal [${s.severity}/${s.confidence}] ${s.title}: ${s.observed.slice(0, 300)}`);
    if (i.chain.length) lines.push(`Stages: ${i.chain.map((c) => `${c.tactic} (${c.status}; ${c.techniques.map((t) => t.id).join(", ") || "no technique"})`).join(" → ")}`);
    for (const h of i.hypotheses)
      lines.push(
        `Hypothesis (${h.kind}, ${h.verdict}): ${h.statement}${h.supports.length ? ` For: ${h.supports.join(" ")}` : ""}${h.contradicts.length ? ` Against: ${h.contradicts.join(" ")}` : ""}`,
      );
    if (i.blocked.length) lines.push(`Couldn't check: ${i.blocked.join(" ")}`);
    if (i.questions.length) lines.push(`Open questions: ${i.questions.join(" ")}`);
    lines.push(`Recommended (not performed): ${[...i.response.priorities, ...i.response.containment.map((c) => `${c.text}${c.approval ? " [needs approval]" : ""}`)].slice(0, 6).join(" ")}`);
  }
  if (intel.length) {
    lines.push("", "Third-party intelligence (context, not proof):");
    for (const r of intel.slice(0, 10)) lines.push(`- ${r.value}: ${r.rating ?? "not checked"}${r.caveats.length ? ` — ${r.caveats.join(" ")}` : ""}`);
  }
  return lines.join("\n");
}
