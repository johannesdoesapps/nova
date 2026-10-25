import { corroborating, findingDetails, type FindingLike } from "../details";
import { cvesIn } from "../hunt/intel";
import type { AegisFinding } from "./model";
import { REMEDIATION_STATUSES, type RemediationStatus } from "./remediation-states";

/**
 * Investigation records and the remediation workflow.
 *
 * Investigations follow ten steps for a high-impact finding, filled in from what's recorded (never invented):
 * the observation and its source, competing explanations, evidence for and against, the sequence of events,
 * benign alternatives, impact and prerequisites, what's still unknown, the safest next step, and the conclusion a
 * person recorded with its evidence trail.
 *
 * Remediations move through Proposed → Approved → In progress → Verification required → Verified / Partially
 * resolved / Failed, or Rolled back. People record approvals, progress and rollbacks; "Verified", "Partially
 * resolved" and "Failed" come only from re-check results after the fix was applied — never from a person's or an
 * agent's say-so, and never from a patch being submitted or deployed.
 */

export interface InvestigationRecord {
  findingId: string;
  steps: { n: number; label: string; content: string[] }[];
  conclusion: { text: string; at: string; outcome: string } | null;
  trail: { at: string; note: string }[];
}

export interface WorkflowEvent {
  detail: Record<string, unknown>;
  created_at: string;
}

export function investigationRecord(f: AegisFinding, all: AegisFinding[], events: WorkflowEvent[], ctx: { kev: Set<string>; attempted: Set<string>; malicious: Set<string> }): InvestigationRecord {
  const d = findingDetails(f as unknown as FindingLike);
  const corro = corroborating(f as unknown as FindingLike, all as unknown as FindingLike[]) as unknown as AegisFinding[];
  const cves = cvesIn(`${f.title} ${f.description}`);
  const support: string[] = [];
  const against: string[] = [];
  if (f.confidence === "confirmed") support.push("Observed directly by the agent's check (confidence: confirmed).");
  else if (f.confidence === "firm") support.push("Strong pattern match (confidence: firm).");
  else against.push("Heuristic or AI-suggested (confidence: tentative) — needs a person to check.");
  for (const c of corro.slice(0, 3)) support.push(`Independent evidence from ${c.agent.replace("_", " ")}: “${c.title}”.`);
  if (f.verification === "still_present") support.push("A later scan found it again.");
  if (f.verification === "not_detected") against.push("The latest re-scan didn't detect it.");
  if (f.occurrences > 1) support.push(`Seen in ${f.occurrences} scans since ${f.first_seen.slice(0, 10)}.`);
  for (const c of cves) if (ctx.kev.has(c)) support.push(`${c} is in CISA's Known Exploited Vulnerabilities catalogue (exploited somewhere; not necessarily here).`);
  if (ctx.attempted.has(f.id)) support.push("Logs show attack attempts against the same location.");
  if (ctx.malicious.has(f.asset)) support.push("Threat Hunter rated activity on this asset likely or confirmed malicious.");
  if (!ctx.attempted.has(f.id) && !ctx.malicious.has(f.asset)) against.push("No evidence of exploitation attempts in the data Orbis has (which may not include this system's logs).");

  const own = events.filter((e) => e.detail.findingId === f.id && e.detail.kind === "investigation").sort((a, b) => a.created_at.localeCompare(b.created_at));
  const last = [...own].reverse().find((e) => e.detail.conclusion);
  const unknown = [
    ...(f.confidence !== "confirmed" ? ["Whether the weakness is real in this context."] : []),
    "Whether it has been exploited (Orbis only sees the logs you upload).",
    ...(f.agent !== "sentinel" ? ["Whether the affected code is deployed and reachable."] : []),
  ];
  const next =
    f.confidence === "tentative"
      ? "Read the flagged code or response with its context and decide whether it's a real issue (mark it a false positive if not)."
      : f.verification === "not_detected"
        ? "Confirm the fix landed and close the finding."
        : !ctx.attempted.has(f.id) && !ctx.malicious.has(f.asset)
          ? "Upload recent logs for this system to Threat Hunter to check for exploitation, then fix it."
          : "Contain first (see the Threat Hunter investigation's response plan), preserve logs, then fix.";
  return {
    findingId: f.id,
    steps: [
      {
        n: 1,
        label: "Observation and source",
        content: [
          `${f.title} — found by ${f.agent.replace("_", " ")} (${f.evidence_source}) on ${f.first_seen.slice(0, 10)}.`,
          ...f.evidence.slice(0, 2).map((e) => `${e.source}: ${e.detail.slice(0, 200)}`),
        ],
      },
      { n: 2, label: "Explanations to test", content: [`Real and exploitable: ${d.impact}`, "Not exploitable here: mitigated by a control Orbis can't see, unreachable, or a false match."] },
      { n: 3, label: "Evidence for", content: support.length ? support : ["None beyond the original observation."] },
      { n: 4, label: "Evidence against", content: against.length ? against : ["Nothing recorded contradicts it."] },
      {
        n: 5,
        label: "Sequence of events",
        content: [
          `First seen ${f.first_seen.slice(0, 10)}; last seen ${f.last_seen.slice(0, 10)}; ${f.occurrences} scan(s).`,
          ...(f.verification !== "not_verified" ? [`Latest re-check: ${f.verification.replace("_", " ")}.`] : []),
        ],
      },
      { n: 6, label: "Benign explanations", content: ["Intended behaviour documented elsewhere, a test or example value, or a compensating control (WAF, gateway, network rule)."] },
      { n: 7, label: "Impact and prerequisites", content: [d.impact, `Needs: ${d.privileges}`] },
      { n: 8, label: "What's still unknown", content: unknown },
      { n: 9, label: "Safest next step", content: [next] },
      { n: 10, label: "Conclusion and evidence trail", content: last ? [`${String(last.detail.outcome ?? "")}: ${String(last.detail.conclusion)}`] : ["No conclusion recorded yet."] },
    ],
    conclusion: last ? { text: String(last.detail.conclusion), at: last.created_at, outcome: String(last.detail.outcome ?? "") } : null,
    trail: own.map((e) => ({ at: e.created_at, note: String(e.detail.note ?? e.detail.conclusion ?? "") })).filter((x) => x.note),
  };
}

/* ------------------------------------------------------------ remediation */

export { canTransition, PERSON_STATUSES, REMEDIATION_LABEL, REMEDIATION_STATUSES, type RemediationStatus } from "./remediation-states";

export interface Remediation {
  id: string;
  title: string;
  findingIds: string[];
  status: RemediationStatus;
  /** Status from people's decisions alone (before evidence is applied). */
  recorded: RemediationStatus;
  history: { at: string; status: RemediationStatus; note: string; by: "person" | "evidence" }[];
  rollback: string | null;
  appliedAt: string | null;
  remaining: string[];
}

/** Fold "aegis.remediation" events, then apply re-check evidence after the fix was applied. */
export function remediations(events: WorkflowEvent[], findings: AegisFinding[]): Remediation[] {
  const byId = new Map<string, Remediation>();
  const fById = new Map(findings.map((f) => [f.id, f]));
  for (const e of [...events].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const id = e.detail.remediationId;
    const status = e.detail.status as RemediationStatus;
    if (typeof id !== "string" || !REMEDIATION_STATUSES.includes(status)) continue;
    const cur =
      byId.get(id) ??
      ({
        id,
        title: String(e.detail.title ?? "Remediation"),
        findingIds: Array.isArray(e.detail.findingIds) ? (e.detail.findingIds as string[]) : [],
        status,
        recorded: status,
        history: [],
        rollback: null,
        appliedAt: null,
        remaining: [],
      } as Remediation);
    cur.recorded = status;
    cur.status = status;
    if (typeof e.detail.rollback === "string") cur.rollback = e.detail.rollback;
    if (status === "verification_required") cur.appliedAt = e.created_at;
    if (status === "in_progress" || status === "rolled_back" || status === "proposed") cur.appliedAt = status === "rolled_back" ? null : cur.appliedAt;
    cur.history.push({ at: e.created_at, status, note: String(e.detail.note ?? ""), by: "person" });
    byId.set(id, cur);
  }
  for (const r of byId.values()) {
    if (!r.appliedAt || r.recorded !== "verification_required") continue;
    const fs = r.findingIds.map((id) => fById.get(id)).filter((f): f is AegisFinding => !!f);
    // Evidence after the fix was applied: detected again (last_seen moves), or a dated "not detected" re-scan with no detection since.
    const applied = r.appliedAt;
    const stillAfter = (f: AegisFinding) => f.last_seen > applied && f.verification === "still_present";
    const goneAfter = (f: AegisFinding) => {
      if (f.verification !== "not_detected" && f.status !== "verified") return false;
      const day = /(\d{4}-\d{2}-\d{2})/.exec(f.verification_note ?? "")?.[1];
      return f.last_seen <= applied && f.updated_at > applied && (!day || day >= applied.slice(0, 10));
    };
    const checked = fs.filter((f) => stillAfter(f) || goneAfter(f));
    if (!fs.length || checked.length < fs.length) {
      r.remaining = fs.filter((f) => !checked.includes(f)).map((f) => `${f.title}: not re-checked since the fix was applied`);
      continue;
    }
    const gone = checked.filter(goneAfter);
    const still = checked.filter(stillAfter);
    const outcome: RemediationStatus = still.length === 0 ? "verified" : gone.length ? "partially_resolved" : "failed";
    r.status = outcome;
    r.remaining = still.map((f) => `${f.title}: still detected`);
    r.history.push({
      at: checked
        .map((f) => (stillAfter(f) ? f.last_seen : f.updated_at))
        .sort()
        .at(-1)!,
      status: outcome,
      note: `${gone.length} of ${fs.length} finding(s) no longer detected by re-check.`,
      by: "evidence",
    });
  }
  return [...byId.values()].sort((a, b) => (b.history.at(-1)?.at ?? "").localeCompare(a.history.at(-1)?.at ?? ""));
}
