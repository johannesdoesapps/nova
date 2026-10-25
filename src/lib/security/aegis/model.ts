import { isEngineering } from "../guardian/categories";

/**
 * Aegis's unified security model, built only from what Orbis has recorded: assets (verified websites, audited
 * repositories and uploads, log sources), the findings on them, identities seen in investigations, and the facts
 * you've declared — how critical an asset is, whether it's internet-facing, what data it holds, and which assets
 * belong together (e.g. "this repository deploys this website"). Relationships you declared are confirmed;
 * relationships Aegis infers are marked as hypotheses.
 */

export interface AegisFinding {
  id: string;
  agent: string;
  rule_id: string;
  title: string;
  description: string;
  severity: string;
  confidence: string;
  status: string;
  verification: string;
  asset: string;
  location: string | null;
  evidence: { source: string; detail: string }[];
  evidence_source: string;
  remediation: string;
  duplicate_of: string | null;
  related: string[];
  first_seen: string;
  last_seen: string;
  /** Last change to the finding (a re-check updates it). */
  updated_at: string;
  verification_note: string | null;
  occurrences: number;
}

export interface AegisRun {
  id: string;
  agent: string;
  action: string;
  status: string;
  asset: string | null;
  started_at: string;
  finished_at: string | null;
  tools: { tool: string; status: string; detail: string }[];
  stats: Record<string, unknown>;
}

/** Facts a person declared about an asset (stored as audit events; latest wins). */
export interface AssetFacts {
  criticality: "critical" | "high" | "medium" | "low" | null;
  exposure: "internet" | "internal" | null;
  data: ("personal" | "financial" | "credentials" | "health" | "public")[];
  owner: string | null;
  links: string[];
  at: string | null;
}

export type AssetKind = "website" | "repository" | "upload" | "log_source";

export interface Asset {
  key: string;
  kind: AssetKind;
  label: string;
  facts: AssetFacts;
  findings: { open: number; bySeverity: Record<string, number>; engineering: number };
  lastAssessed: { agent: string; at: string; runId: string }[];
  /** Assets this one is linked to: declared by you, or suggested by Aegis (hypothesis). */
  related: { key: string; basis: "declared" | "suggested"; why: string }[];
}

export interface Identity {
  name: string;
  assets: string[];
  investigations: { runId: string; invId: string; title: string; state: string }[];
}

export const OPEN = new Set(["open", "investigating", "fix_proposed"]);
export const EMPTY_FACTS: AssetFacts = { criticality: null, exposure: null, data: [], owner: null, links: [], at: null };

export function assetKind(key: string, verifiedHosts: Set<string>, logAssets: Set<string>): AssetKind {
  if (key.startsWith("github:")) return "repository";
  if (verifiedHosts.has(key) || /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(key)) return "website";
  if (logAssets.has(key)) return "log_source";
  return "upload";
}

/** Fold "aegis.asset" audit events into the latest facts per asset. */
export function foldAssetFacts(events: { detail: Record<string, unknown>; created_at: string }[]): Map<string, AssetFacts> {
  const out = new Map<string, AssetFacts>();
  for (const e of [...events].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const key = typeof e.detail.asset === "string" ? e.detail.asset : null;
    if (!key) continue;
    const prev = out.get(key) ?? EMPTY_FACTS;
    const d = e.detail as Partial<AssetFacts>;
    out.set(key, {
      criticality: d.criticality !== undefined ? d.criticality : prev.criticality,
      exposure: d.exposure !== undefined ? d.exposure : prev.exposure,
      data: Array.isArray(d.data) ? d.data : prev.data,
      owner: d.owner !== undefined ? d.owner : prev.owner,
      links: Array.isArray(d.links) ? d.links : prev.links,
      at: e.created_at,
    });
  }
  return out;
}

const stem = (key: string) =>
  key
    .replace(/^github:/, "")
    .split(/[/.:-]/)
    .filter((p) => p.length >= 4 && !/^(www|com|org|net|app|main|repo|github|io|dev)$/i.test(p))
    .map((p) => p.toLowerCase());

export function buildModel(input: { findings: AegisFinding[]; runs: AegisRun[]; verifiedHosts: string[]; facts: Map<string, AssetFacts> }): { assets: Asset[]; identities: Identity[] } {
  const hosts = new Set(input.verifiedHosts);
  const logAssets = new Set(input.runs.filter((r) => r.agent === "threat_hunter" && r.asset).map((r) => r.asset!));
  const keys = new Set<string>([...input.verifiedHosts, ...input.findings.map((f) => f.asset), ...input.runs.filter((r) => r.asset && r.agent !== "coordinated").map((r) => r.asset!)]);
  const assets: Asset[] = [...keys].map((key) => {
    const fs = input.findings.filter((f) => f.asset === key && OPEN.has(f.status) && !f.duplicate_of);
    const bySeverity: Record<string, number> = {};
    for (const f of fs) if (!isEngineering(f.rule_id)) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
    const last = new Map<string, { agent: string; at: string; runId: string }>();
    for (const r of input.runs) if (r.asset === key && r.status === "completed" && !last.has(r.agent)) last.set(r.agent, { agent: r.agent, at: r.started_at, runId: r.id });
    return {
      key,
      kind: assetKind(key, hosts, logAssets),
      label: key.replace(/^github:/, ""),
      facts: input.facts.get(key) ?? EMPTY_FACTS,
      findings: { open: fs.filter((f) => !isEngineering(f.rule_id)).length, bySeverity, engineering: fs.filter((f) => isEngineering(f.rule_id)).length },
      lastAssessed: [...last.values()],
      related: [],
    };
  });
  // Declared links (both directions), then suggestions from shared name parts — suggestions are hypotheses.
  for (const a of assets)
    for (const l of a.facts.links) {
      const b = assets.find((x) => x.key === l);
      if (!b) continue;
      if (!a.related.some((r) => r.key === b.key)) a.related.push({ key: b.key, basis: "declared", why: "You linked these assets." });
      if (!b.related.some((r) => r.key === a.key)) b.related.push({ key: a.key, basis: "declared", why: "You linked these assets." });
    }
  for (const a of assets)
    for (const b of assets) {
      if (a.key >= b.key || a.kind === b.kind || a.related.some((r) => r.key === b.key)) continue;
      const shared = stem(a.key).filter((p) => stem(b.key).includes(p));
      if (!shared.length) continue;
      const why = `Names share "${shared[0]}" — confirm or ignore; Aegis doesn't treat this as a real link until you do.`;
      a.related.push({ key: b.key, basis: "suggested", why });
      b.related.push({ key: a.key, basis: "suggested", why });
    }

  const identities = new Map<string, Identity>();
  for (const r of input.runs) {
    if (r.agent !== "threat_hunter" || !Array.isArray(r.stats.investigations)) continue;
    for (const inv of r.stats.investigations as { id: string; title: string; state: string; entities?: { users?: string[] } }[])
      for (const u of inv.entities?.users ?? []) {
        const cur = identities.get(u) ?? { name: u, assets: [], investigations: [] };
        if (r.asset && !cur.assets.includes(r.asset)) cur.assets.push(r.asset);
        if (cur.investigations.length < 10) cur.investigations.push({ runId: r.id, invId: inv.id, title: inv.title, state: inv.state });
        identities.set(u, cur);
      }
  }
  return { assets: assets.sort((a, b) => b.findings.open - a.findings.open || a.key.localeCompare(b.key)), identities: [...identities.values()].slice(0, 100) };
}

/** Assets treated as the same system for correlation: itself plus declared links (suggestions don't count). */
export function linkedSet(assets: Asset[], key: string): Set<string> {
  const a = assets.find((x) => x.key === key);
  return new Set([key, ...(a?.related.filter((r) => r.basis === "declared").map((r) => r.key) ?? [])]);
}
