import { NOT_CONNECTED } from "../hunt/events";
import type { Asset, AegisFinding, AegisRun } from "./model";
import { OPEN } from "./model";

/**
 * What Aegis can and can't see. Each security domain is assessed (recent, complete enough), partially assessed
 * (some checks ran, or results are old), not assessed (possible, but nothing has run) or unavailable (Orbis has no
 * way to assess it). An absence of findings in an area that isn't assessed means nothing.
 */

export type CoverageState = "assessed" | "partial" | "not_assessed" | "unavailable";

export interface DomainCoverage {
  id: string;
  label: string;
  state: CoverageState;
  sources: string[];
  gaps: string[];
  lastRun: string | null;
}

export const STALE_DAYS = 30;
const days = (iso: string, now: number) => (now - Date.parse(iso)) / 86_400_000;

export function securityCoverage(input: { runs: AegisRun[]; assets: Asset[]; findings: AegisFinding[]; verifiedHosts: string[]; abuseIpdb: boolean; kevAvailable: boolean; now?: number }): {
  domains: DomainCoverage[];
  stale: { asset: string; agent: string; at: string }[];
  unconfirmed: number;
  notes: string[];
} {
  const now = input.now ?? Date.now();
  const done = input.runs.filter((r) => r.status === "completed");
  const latest = (agent: string, pred: (r: AegisRun) => boolean = () => true) => done.find((r) => r.agent === agent && pred(r)) ?? null;
  const fresh = (r: AegisRun | null) => !!r && days(r.started_at, now) <= STALE_DAYS;
  const domains: DomainCoverage[] = [];

  const sentinel = latest("sentinel");
  const sentinelAssets = new Set(done.filter((r) => r.agent === "sentinel").map((r) => r.asset));
  const unscanned = input.verifiedHosts.filter((h) => !sentinelAssets.has(h));
  domains.push({
    id: "web",
    label: "Web applications",
    state: !input.verifiedHosts.length ? "not_assessed" : !sentinel ? "not_assessed" : fresh(sentinel) && !unscanned.length ? (sentinel.stats.audit ? "assessed" : "partial") : "partial",
    sources: sentinel ? [`Sentinel, last run ${sentinel.started_at.slice(0, 10)}`] : [],
    gaps: [
      ...(input.verifiedHosts.length ? [] : ["No verified website yet."]),
      ...unscanned.map((h) => `${h} is verified but has never been scanned.`),
      "Signed-in areas, forms and business logic aren't tested (Sentinel doesn't sign in or submit forms).",
    ],
    lastRun: sentinel?.started_at ?? null,
  });

  const guardian = latest("code_guardian");
  domains.push({
    id: "code",
    label: "Source code",
    state: !guardian ? "not_assessed" : fresh(guardian) ? "assessed" : "partial",
    sources: guardian ? [`Code Guardian, last run ${guardian.started_at.slice(0, 10)} on ${guardian.asset}`] : [],
    gaps: ["Code is read, not executed: runtime behaviour and tests aren't covered by audits."],
    lastRun: guardian?.started_at ?? null,
  });

  const deps = done.find((r) => r.agent === "code_guardian" && r.tools.some((t) => t.tool === "OSV dependency check" && t.status === "ok")) ?? null;
  domains.push({
    id: "supply_chain",
    label: "Dependencies and build pipeline",
    state: deps ? "partial" : "not_assessed",
    sources: deps ? [`OSV and compatibility checks (Code Guardian), ${deps.started_at.slice(0, 10)}`] : [],
    gaps: ["No package integrity, provenance or build-artifact verification.", "pnpm and yarn lockfiles only get vulnerability checks."],
    lastRun: deps?.started_at ?? null,
  });

  const hunter = latest("threat_hunter");
  domains.push({
    id: "telemetry",
    label: "Logs and suspicious activity",
    state: !hunter ? "not_assessed" : "partial",
    sources: hunter ? [`Threat Hunter on uploaded logs, last ${hunter.started_at.slice(0, 10)}`] : [],
    gaps: [...NOT_CONNECTED.map((n) => `${n.source}: not connected (${n.blocks})`), ...(hunter && !fresh(hunter) ? [`The latest hunt is over ${STALE_DAYS} days old.`] : [])],
    lastRun: hunter?.started_at ?? null,
  });

  const identityHunt = done.find(
    (r) =>
      r.agent === "threat_hunter" &&
      Array.isArray(r.stats.inventory) &&
      (r.stats.inventory as { formats?: Record<string, number> }[]).some((i) => i.formats && (i.formats.okta || i.formats.windows || i.formats.linux_auth || i.formats.ssh)),
  );
  domains.push({
    id: "identity",
    label: "Identity and access",
    state: identityHunt ? "partial" : "unavailable",
    sources: identityHunt ? [`Sign-in and privilege events in uploaded logs (${identityHunt.started_at.slice(0, 10)})`] : [],
    gaps: ["No identity-provider or IAM connection: users, roles, permissions and MFA can't be listed or checked."],
    lastRun: identityHunt?.started_at ?? null,
  });

  const cloudHunt = done.find(
    (r) => r.agent === "threat_hunter" && Array.isArray(r.stats.inventory) && (r.stats.inventory as { formats?: Record<string, number> }[]).some((i) => i.formats?.cloudtrail),
  );
  domains.push({
    id: "cloud",
    label: "Cloud infrastructure",
    state: cloudHunt ? "partial" : "unavailable",
    sources: cloudHunt ? [`CloudTrail events in uploaded logs (${cloudHunt.started_at.slice(0, 10)})`] : [],
    gaps: ["Cloud Guardian isn't built: cloud configuration (storage, networks, IAM policies) isn't assessed."],
    lastRun: cloudHunt?.started_at ?? null,
  });

  domains.push({
    id: "validation",
    label: "Attack validation (red team)",
    state: "unavailable",
    sources: [],
    gaps: ["No authorised attack-simulation capability: attack paths stay hypotheses."],
    lastRun: null,
  });
  domains.push({ id: "compliance", label: "Compliance and privacy", state: "unavailable", sources: [], gaps: ["Findings aren't mapped to control frameworks; no privacy assessment."], lastRun: null });
  domains.push({
    id: "intel",
    label: "Threat intelligence",
    state: input.kevAvailable ? "partial" : "not_assessed",
    sources: [...(input.kevAvailable ? ["CISA Known Exploited Vulnerabilities (fetched on request)"] : []), ...(input.abuseIpdb ? ["AbuseIPDB IP reputation"] : [])],
    gaps: [
      "No scheduled monitoring: intelligence is checked when you open Aegis or run an agent.",
      ...(input.abuseIpdb ? [] : ["IP reputation isn't configured."]),
      "No domain/URL reputation or vendor advisory feeds.",
    ],
    lastRun: null,
  });

  const stale = input.assets.flatMap((a) => a.lastAssessed.filter((l) => days(l.at, now) > STALE_DAYS).map((l) => ({ asset: a.key, agent: l.agent, at: l.at })));
  const unconfirmed = input.findings.filter((f) => OPEN.has(f.status) && !f.duplicate_of && f.confidence === "tentative").length;
  return {
    domains,
    stale,
    unconfirmed,
    notes: [
      "No alerts in an area that isn't assessed is not evidence that nothing is wrong there.",
      "Threat Hunter's detection rules are validated against synthetic scenarios, not against your environment.",
    ],
  };
}
