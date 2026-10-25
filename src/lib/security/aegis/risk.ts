import { classify, type Classification } from "../details";
import { isEngineering } from "../guardian/categories";
import { cvesIn } from "../hunt/intel";
import type { Asset, AegisFinding } from "./model";
import { OPEN } from "./model";

/**
 * Context-aware prioritisation. One documented model, applied the same way to every finding:
 *
 *   points = severity base × confidence factor + exposure + exploitation evidence + asset criticality + sensitivity
 *
 * Severity base: critical 40, high 30, medium 18, low 8, info 2. Confidence factor (from the finding's
 * classification): confirmed 1.0, likely 0.85, needs verification 0.6, informational 0.3. Exposure: +10 when the
 * finding was observed on a live website or the asset is declared internet-facing; −5 when declared internal.
 * Exploitation evidence: +15 for a CVE in CISA's Known Exploited Vulnerabilities catalogue (+5 if used by
 * ransomware), +15 when Threat Hunter rated activity on the same asset likely or confirmed malicious, +10 when
 * attack attempts in logs match the weakness. Criticality (declared): critical +15, high +8, low −5, not set 0.
 * Sensitivity: +8 for secrets, authentication, access-control and data-exposure findings, or declared sensitive data.
 *
 * The points only order findings; they're never shown as a precise score. What's shown is the tier, the urgency
 * and every factor that contributed. Severity, confidence, urgency and remediation status stay separate fields.
 * Accepted risks (with an unexpired exception), false positives, duplicates and findings a re-scan no longer
 * detects are left out of the tiers and listed as such.
 */

export type Tier = "immediate" | "priority" | "strategic";
export type Urgency = "now" | "this week" | "this quarter";

export interface RiskFactor {
  label: string;
  points: number;
}

export interface Prioritised {
  finding: AegisFinding;
  tier: Tier;
  urgency: Urgency;
  classification: Classification;
  factors: RiskFactor[];
  points: number;
  why: string;
}

export interface RiskContext {
  assets: Asset[];
  /** CVE → listed in KEV (and whether linked to ransomware). */
  kev: Map<string, { ransomware: boolean }>;
  /** Assets where Threat Hunter rated activity likely or confirmed malicious. */
  maliciousActivity: Set<string>;
  /** Finding ids matched by attack attempts in logs (from correlation). */
  attempted: Set<string>;
  /** Finding ids with an unexpired accepted-risk exception. */
  excepted: Set<string>;
}

const BASE: Record<string, number> = { critical: 40, high: 30, medium: 18, low: 8, info: 2 };
const CONF: Record<Classification, number> = { confirmed: 1, likely: 0.85, needs_verification: 0.6, informational: 0.3, false_positive: 0 };
const SENSITIVE =
  /^(secret\.|exposure\.|surface\.client-secret|cookies\.|map\.(route-no-auth|object-access|read-no-auth|mass-assignment)|auth\.|priv\.|persist\.credential|cloud\.root|code\.(sql|path-traversal|command)|deps\.)/;

export const MODEL_ASSUMPTIONS = [
  "Severity and confidence come from the agent that found the issue; Aegis doesn't raise a finding's severity.",
  "Internet exposure is known only for live website findings or where you declared it; otherwise it isn't assumed.",
  "Asset criticality and data sensitivity count only where you declared them.",
  "Exploitation evidence means: a CISA KEV listing for a CVE in the finding, Threat Hunter activity rated likely or confirmed malicious on the same asset, or matching attack attempts in logs. None of these proves this deployment was exploited.",
  "Remediation cost isn't scored (Orbis can't measure it); the recommended fix and its risk are shown with each finding.",
];

export function prioritise(findings: AegisFinding[], ctx: RiskContext): { ranked: Prioritised[]; excluded: { finding: AegisFinding; reason: string }[] } {
  const ranked: Prioritised[] = [];
  const excluded: { finding: AegisFinding; reason: string }[] = [];
  const all = findings as unknown as Parameters<typeof classify>[1];
  for (const f of findings) {
    if (f.duplicate_of) continue;
    if (f.status === "accepted_risk" && !ctx.excepted.has(f.id)) {
      excluded.push({ finding: f, reason: "Marked accepted risk (no expiry recorded — review it periodically)" });
      continue;
    }
    if (!OPEN.has(f.status) && !ctx.excepted.has(f.id)) continue;
    if (ctx.excepted.has(f.id)) {
      excluded.push({ finding: f, reason: "Accepted risk (exception still valid)" });
      continue;
    }
    if (f.verification === "not_detected") {
      excluded.push({ finding: f, reason: "Not detected by the latest re-scan — confirm it's fixed and close it" });
      continue;
    }
    const cls = classify(f as unknown as Parameters<typeof classify>[0], all);
    const asset = ctx.assets.find((a) => a.key === f.asset);
    const factors: RiskFactor[] = [];
    const base = Math.round((BASE[f.severity] ?? 2) * CONF[cls]);
    factors.push({ label: `${f.severity} severity, ${cls.replace("_", " ")}`, points: base });
    const live = f.agent === "sentinel" || /^https?:\/\//.test(f.location ?? "");
    if (live) factors.push({ label: "Observed on a live website", points: 10 });
    else if (asset?.facts.exposure === "internet") factors.push({ label: "Asset declared internet-facing", points: 10 });
    else if (asset?.facts.exposure === "internal") factors.push({ label: "Asset declared internal only", points: -5 });
    const cves = cvesIn(`${f.title} ${f.description} ${f.evidence.map((e) => e.detail).join(" ")}`);
    const kev = cves.find((c) => ctx.kev.has(c));
    if (kev) {
      factors.push({ label: `${kev} is in CISA's Known Exploited Vulnerabilities catalogue`, points: 15 });
      if (ctx.kev.get(kev)!.ransomware) factors.push({ label: "Used in ransomware campaigns (per CISA)", points: 5 });
    }
    if (ctx.maliciousActivity.has(f.asset)) factors.push({ label: "Threat Hunter rated activity on this asset likely/confirmed malicious", points: 15 });
    if (ctx.attempted.has(f.id)) factors.push({ label: "Matching attack attempts in your logs", points: 10 });
    const crit = asset?.facts.criticality;
    if (crit === "critical") factors.push({ label: "Asset declared critical", points: 15 });
    else if (crit === "high") factors.push({ label: "Asset declared high importance", points: 8 });
    else if (crit === "low") factors.push({ label: "Asset declared low importance", points: -5 });
    if (SENSITIVE.test(f.rule_id)) factors.push({ label: "Touches credentials, authentication, access control or data exposure", points: 8 });
    else if (asset?.facts.data.some((d) => d !== "public")) factors.push({ label: `Asset holds ${asset.facts.data.filter((d) => d !== "public").join(", ")} data`, points: 8 });

    const points = factors.reduce((n, x) => n + x.points, 0);
    const exploited = !!kev || ctx.maliciousActivity.has(f.asset) || ctx.attempted.has(f.id);
    const credible = cls === "confirmed" || cls === "likely";
    let tier: Tier;
    if (f.rule_id.startsWith("arch.") || f.severity === "info") tier = "strategic";
    else if (credible && points >= 50 && (exploited || (f.severity === "critical" && (live || asset?.facts.exposure === "internet")))) tier = "immediate";
    else if (points >= 25 || f.severity === "high" || f.severity === "critical") tier = "priority";
    else tier = isEngineering(f.rule_id) || f.severity === "low" ? "strategic" : "priority";
    const urgency: Urgency = tier === "immediate" ? "now" : tier === "priority" ? "this week" : "this quarter";
    const why =
      tier === "immediate"
        ? `Credible (${cls.replace("_", " ")}), high impact and ${exploited ? "there's evidence of exploitation activity" : "exposed to the internet"}.`
        : tier === "priority"
          ? "Important weakness to fix soon; no evidence it's being exploited."
          : "Longer-term improvement (low impact, maintainability or hardening).";
    ranked.push({ finding: f, tier, urgency, classification: cls, factors, points, why });
  }
  ranked.sort((a, b) => b.points - a.points);
  return { ranked, excluded };
}

/** Exceptions: accepted risks with an expiry, folded from "aegis.exception" events. Expired ones no longer count. */
export function activeExceptions(events: { detail: Record<string, unknown>; created_at: string }[], now = Date.now()): Map<string, { until: string; reason: string }> {
  const out = new Map<string, { until: string; reason: string }>();
  for (const e of [...events].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const id = e.detail.findingId;
    if (typeof id !== "string") continue;
    if (e.detail.revoked) out.delete(id);
    else if (typeof e.detail.until === "string" && Date.parse(e.detail.until) > now) out.set(id, { until: e.detail.until, reason: String(e.detail.reason ?? "") });
    else out.delete(id);
  }
  return out;
}
