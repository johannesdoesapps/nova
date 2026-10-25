import { isEngineering } from "../../security/guardian/categories";
import type { CoverageArea, FindingKind, RawFinding, Severity } from "./checks";

/**
 * Findings in one shared format — Bastion's workspace checks and the security agents' findings (Sentinel, Code
 * Guardian, Threat Hunter) — with a workflow on top: assign, acknowledge, investigate, request resolution,
 * suppress with a justification, retest. A finding is resolved only when a check that ran after the request no
 * longer finds it; asking for resolution only moves it to "waiting for a re-check".
 */

export type WorkflowStatus = "open" | "acknowledged" | "investigating" | "pending_verification" | "resolved" | "suppressed";
export type Verification = "not_verified" | "awaiting_recheck" | "still_present" | "verified_resolved";
export const WORKFLOW_ACTIONS = ["assign", "acknowledge", "investigate", "resolve_requested", "suppress", "unsuppress", "reopen"] as const;
export type WorkflowAction = (typeof WORKFLOW_ACTIONS)[number];

export interface BastionFinding extends RawFinding {
  source: "bastion" | "sentinel" | "code_guardian" | "threat_hunter" | string;
  workspaceId: string;
  detectedAt: string;
  lastSeen: string;
  status: WorkflowStatus;
  owner: string | null;
  verification: Verification;
  verificationNote: string | null;
  suppressedUntil: string | null;
  related: string[];
  history: { at: string; action: string; by: string; note: string }[];
}

export interface WorkflowEvent {
  detail: { findingId?: unknown; action?: unknown; owner?: unknown; note?: unknown; until?: unknown; actor?: unknown };
  created_at: string;
}

/** A recorded run of the workspace checks: which findings were present and when. */
export interface AssessmentRecord {
  at: string;
  mode: string;
  present: { id: string; title: string; severity: string; checkId: string; assetLabel: string }[];
  checked: string[];
}

/** What an assessment record keeps of each finding (records are capped at 8 KB). */
export const summaryOf = (f: RawFinding) => ({ id: f.id, title: f.title.slice(0, 120), severity: f.severity, checkId: f.checkId, assetLabel: f.assetLabel.slice(0, 60) });

/** A stored finding from a security agent (security_findings). */
export interface AgentFindingRow {
  id: string;
  agent: string;
  rule_id: string;
  title: string;
  description: string;
  severity: string;
  confidence: string;
  status: string;
  verification: string;
  verification_note: string | null;
  asset: string;
  location: string | null;
  evidence: { source: string; detail: string }[];
  evidence_source: string;
  remediation: string;
  rationale?: string;
  related: string[];
  first_seen: string;
  last_seen: string;
}

const KIND_OF = (confidence: string, severity: string): FindingKind => (severity === "info" ? "informational" : confidence === "confirmed" ? "verified" : "suspected");

/** Normalise a security agent's finding into the shared format (its own re-scan decides verification). */
export function fromAgentFinding(f: AgentFindingRow, workspaceId: string, label?: string): BastionFinding {
  const resolved = f.verification === "not_detected" || f.status === "verified";
  const suppressed = f.status === "false_positive" || f.status === "accepted_risk";
  return {
    id: f.id,
    checkId: f.rule_id,
    source: f.agent,
    kind: KIND_OF(f.confidence, f.severity),
    severity: (["critical", "high", "medium", "low", "info"].includes(f.severity) ? f.severity : "info") as Severity,
    confidence: (["confirmed", "firm", "tentative"].includes(f.confidence) ? f.confidence : "tentative") as BastionFinding["confidence"],
    asset: f.asset,
    assetLabel: label ?? f.asset.replace(/^github:/, ""),
    title: f.title,
    description: f.description,
    evidence: (f.evidence ?? []).slice(0, 3).map((e) => `${e.source}: ${e.detail.slice(0, 240)}`),
    method: f.evidence_source,
    impact: f.rationale ?? "",
    remediation: f.remediation,
    href: `/agents/security/findings/${f.id}`,
    workspaceId,
    detectedAt: f.first_seen,
    lastSeen: f.last_seen,
    status: suppressed ? "suppressed" : resolved ? "resolved" : f.status === "investigating" ? "investigating" : f.status === "fixed" || f.status === "fix_proposed" ? "pending_verification" : "open",
    owner: null,
    verification: resolved ? "verified_resolved" : f.verification === "still_present" ? "still_present" : f.status === "fixed" || f.status === "fix_proposed" ? "awaiting_recheck" : "not_verified",
    verificationNote: f.verification_note,
    suppressedUntil: null,
    related: f.related ?? [],
    history: [],
  };
}

/**
 * Bastion's own findings: those the latest check run found, plus earlier ones that a later run no longer found
 * (resolved, with the evidence of when). `present` is the current run; `assessments` are signed records.
 */
export function workspaceFindings(present: RawFinding[], assessments: AssessmentRecord[], workspaceId: string, now: string, ranChecks: string[]): BastionFinding[] {
  const sorted = [...assessments].sort((a, b) => a.at.localeCompare(b.at));
  const firstSeen = new Map<string, string>();
  for (const a of sorted) for (const p of a.present) if (!firstSeen.has(p.id)) firstSeen.set(p.id, a.at);
  const base = (r: RawFinding): BastionFinding => ({
    ...r,
    source: "bastion",
    workspaceId,
    detectedAt: firstSeen.get(r.id) ?? now,
    lastSeen: now,
    status: "open",
    owner: null,
    verification: "not_verified",
    verificationNote: null,
    suppressedUntil: null,
    related: [],
    history: [],
  });
  const out = present.map(base);
  // Previously recorded, not found now: resolved — the current run is the evidence.
  const last = new Map<string, { at: string; finding: AssessmentRecord["present"][number] }>();
  for (const a of sorted) for (const p of a.present) last.set(p.id, { at: a.at, finding: p });
  // Only checks that ran now can vouch for an absence.
  for (const [id, seen] of last) {
    if (present.some((p) => p.id === id) || !ranChecks.includes(seen.finding.checkId)) continue;
    out.push({
      ...base({
        id,
        checkId: seen.finding.checkId,
        kind: "verified",
        severity: (["critical", "high", "medium", "low", "info"].includes(seen.finding.severity) ? seen.finding.severity : "info") as Severity,
        confidence: "confirmed",
        asset: "",
        assetLabel: seen.finding.assetLabel,
        title: seen.finding.title,
        description: "",
        evidence: [],
        method: "Bastion workspace check",
        impact: "",
        remediation: "",
        href: null,
      }),
      detectedAt: firstSeen.get(id) ?? seen.at,
      lastSeen: seen.at,
      status: "resolved",
      verification: "verified_resolved",
      verificationNote: `Not found by the workspace checks on ${now.slice(0, 10)} (last found ${seen.at.slice(0, 10)}).`,
    });
  }
  return out;
}

/** Apply people's workflow decisions. Resolution needs evidence: a request alone only waits for a re-check. */
export function applyWorkflow(findings: BastionFinding[], events: WorkflowEvent[], opts: { now: number; lastCheckAt: string | null }): BastionFinding[] {
  const byId = new Map(findings.map((f) => [f.id, { ...f, history: [...f.history] }]));
  for (const e of [...events].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const f = byId.get(String(e.detail.findingId ?? ""));
    const action = String(e.detail.action ?? "") as WorkflowAction;
    if (!f || !WORKFLOW_ACTIONS.includes(action)) continue;
    const note = typeof e.detail.note === "string" ? e.detail.note : "";
    f.history.push({ at: e.created_at, action, by: String(e.detail.actor ?? ""), note });
    if (f.status === "resolved" && action !== "reopen") continue; // evidence already settled it
    switch (action) {
      case "assign":
        f.owner = typeof e.detail.owner === "string" ? e.detail.owner : null;
        break;
      case "acknowledge":
        if (f.status === "open") f.status = "acknowledged";
        break;
      case "investigate":
        f.status = "investigating";
        break;
      case "resolve_requested":
        f.status = "pending_verification";
        f.verification = "awaiting_recheck";
        f.verificationNote = `Fix reported ${e.created_at.slice(0, 10)}; waiting for a re-check.`;
        // A check that ran after the request and still found it settles it: not resolved.
        if (opts.lastCheckAt && opts.lastCheckAt > e.created_at && f.source === "bastion") {
          f.status = "open";
          f.verification = "still_present";
          f.verificationNote = `Still found by the re-check on ${opts.lastCheckAt.slice(0, 10)} after the fix was reported.`;
        }
        break;
      case "suppress":
        f.status = "suppressed";
        f.suppressedUntil = typeof e.detail.until === "string" ? e.detail.until : null;
        break;
      case "unsuppress":
      case "reopen":
        f.status = "open";
        f.suppressedUntil = null;
        break;
    }
  }
  for (const f of byId.values())
    if (f.status === "suppressed" && f.suppressedUntil && Date.parse(f.suppressedUntil) < opts.now) {
      f.status = "open";
      f.history.push({ at: f.suppressedUntil, action: "suppression_expired", by: "", note: "" });
    }
  return [...byId.values()];
}

/* ---------------------------------------------------------------- posture */

export type PostureLevel = "at_risk" | "needs_attention" | "insufficient_coverage" | "no_known_serious";
export const POSTURE_RULES = [
  "At risk — any open critical finding, or an open high finding that's verified.",
  "Needs attention — any other open high finding, or three or more open medium findings.",
  "Not enough coverage to judge — fewer than half of the areas Bastion could cover have been assessed.",
  "No known serious issues — none of the above, in what Bastion can see. It never means “secure”: see the coverage list.",
];
const OPEN = (f: BastionFinding) => f.status !== "resolved" && f.status !== "suppressed";

export function posture(
  findings: BastionFinding[],
  coverage: CoverageArea[],
): { level: PostureLevel; headline: string; counts: Record<Severity, number>; coverage: { assessed: number; coverable: number } } {
  const open = findings.filter(OPEN).filter((f) => !isEngineering(f.checkId));
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 } as Record<Severity, number>;
  for (const f of open) counts[f.severity]++;
  const coverable = coverage.filter((c) => c.state !== "not_applicable" && c.state !== "unavailable");
  const assessed = coverable.filter((c) => c.state === "assessed").length + coverable.filter((c) => c.state === "partial").length * 0.5;
  const cov = { assessed: Math.floor(assessed), coverable: coverable.length };
  if (counts.critical || open.some((f) => f.severity === "high" && f.kind === "verified"))
    return { level: "at_risk", headline: `${counts.critical} critical and ${counts.high} high finding${counts.high === 1 ? "" : "s"} need action.`, counts, coverage: cov };
  if (counts.high || counts.medium >= 3)
    return { level: "needs_attention", headline: `${counts.high} high and ${counts.medium} medium finding${counts.medium === 1 ? "" : "s"} to work through.`, counts, coverage: cov };
  if (assessed < coverable.length / 2)
    return { level: "insufficient_coverage", headline: `Only ${cov.assessed} of ${cov.coverable} areas have been assessed — not enough to judge.`, counts, coverage: cov };
  return { level: "no_known_serious", headline: `No known serious issues in what Bastion can see (${cov.assessed} of ${cov.coverable} areas assessed).`, counts, coverage: cov };
}
