import type { IpReputation } from "../reputation";

/**
 * Threat intelligence records. Every record says where it came from, when it was retrieved, how old the
 * underlying observation is, and why it might mislead (shared hosting, CDNs, VPNs, Tor, recycled addresses).
 * Reputation is context, never proof. Sources that aren't connected are listed as such, not simulated.
 */

export interface IndicatorRecord {
  type: "ip" | "domain" | "url";
  value: string;
  source: string;
  retrievedAt: string | null;
  lastSeen: string | null;
  /** The source's own rating, in its own terms. */
  rating: string | null;
  context: string[];
  /** Reasons the match may say little about this specific actor. */
  caveats: string[];
  stale: boolean;
  /** How many of the uploaded events involve this indicator. */
  seenInLogs: number;
  checked: boolean;
}

const SHARED_USAGE = /(data center|web hosting|transit|content delivery|cdn|fixed line isp|mobile isp)/i;
const SHARED_ISP = /(cloudflare|akamai|fastly|amazon|google|microsoft|digitalocean|ovh|hetzner|linode|vultr|oracle)/i;

export function ipRecord(r: IpReputation, seenInLogs: number, now = Date.now()): IndicatorRecord {
  const last = r.lastReportedAt;
  const ageDays = last ? (now - Date.parse(last)) / 86_400_000 : null;
  const caveats: string[] = [];
  if (r.usageType && SHARED_USAGE.test(r.usageType)) caveats.push(`${r.usageType} address: many unrelated customers or users can share it.`);
  else if (r.isp && SHARED_ISP.test(r.isp)) caveats.push(`Belongs to ${r.isp}, a large provider whose addresses are shared and recycled.`);
  if (r.isTor) caveats.push("Tor exit node: traffic from many unrelated people.");
  if (r.isWhitelisted) caveats.push("AbuseIPDB lists this address as allow-listed (a known legitimate service).");
  if (ageDays !== null && ageDays > 30) caveats.push(`Last reported ${Math.round(ageDays)} days ago; the address may have changed hands.`);
  return {
    type: "ip",
    value: r.ip,
    source: "AbuseIPDB",
    retrievedAt: r.retrievedAt ?? null,
    lastSeen: last,
    rating: `abuse confidence ${r.score}/100, ${r.reports} report(s)${r.distinctReporters ? ` from ${r.distinctReporters} reporter(s)` : ""} in 90 days`,
    context: [r.isp, r.usageType, r.domain, r.country].filter((x): x is string => !!x),
    caveats,
    stale: ageDays !== null && ageDays > 30,
    seenInLogs,
    checked: true,
  };
}

export function uncheckedRecord(type: IndicatorRecord["type"], value: string, why: string, seenInLogs = 0): IndicatorRecord {
  return { type, value, source: "Not checked", retrievedAt: null, lastSeen: null, rating: null, context: [], caveats: [why], stale: false, seenInLogs, checked: false };
}

/* ------------------------------------------------- CISA known exploited */

export interface KevEntry {
  cveID: string;
  vendorProject: string;
  product: string;
  vulnerabilityName: string;
  dateAdded: string;
  shortDescription: string;
  requiredAction: string;
  dueDate: string;
  knownRansomwareCampaignUse?: string;
}

export interface KevCatalog {
  version: string;
  released: string;
  retrievedAt: string;
  entries: KevEntry[];
}

export const KEV_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";

let cache: { at: number; catalog: KevCatalog } | null = null;

/** CISA's Known Exploited Vulnerabilities catalogue (public, no key), cached for six hours per server instance. */
export async function fetchKev(opts: { fetchImpl?: typeof fetch; signal?: AbortSignal; now?: number } = {}): Promise<KevCatalog> {
  const now = opts.now ?? Date.now();
  if (cache && now - cache.at < 6 * 3_600_000) return cache.catalog;
  const r = await (opts.fetchImpl ?? fetch)(KEV_URL, { signal: opts.signal, headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`CISA KEV answered ${r.status}`);
  const j = (await r.json()) as { catalogVersion?: string; dateReleased?: string; vulnerabilities?: KevEntry[] };
  if (!Array.isArray(j.vulnerabilities)) throw new Error("CISA KEV returned an unexpected format");
  const catalog = { version: j.catalogVersion ?? "unknown", released: j.dateReleased ?? "unknown", retrievedAt: new Date(now).toISOString(), entries: j.vulnerabilities };
  cache = { at: now, catalog };
  return catalog;
}

export interface Advisory {
  cve: string;
  title: string;
  vendor: string;
  product: string;
  dateAdded: string;
  dueDate: string;
  ransomware: boolean;
  description: string;
  requiredAction: string;
  source: string;
  sourceUrl: string;
  /** How this advisory relates to you. */
  match: { kind: "dependency" | "technology"; detail: string; verified: boolean };
}

/**
 * Advisories from the catalogue that touch the user's actual stack:
 *  - dependency: a CVE that a Code Guardian dependency finding already lists (version-specific, so verified);
 *  - technology: a product seen in a website or code map, added to the catalogue in the last year. The
 *    version in use isn't known, so these are leads to check, not confirmed exposure.
 */
export function matchKev(catalog: KevCatalog, stack: { cves: { cve: string; where: string }[]; technologies: string[] }, now = Date.now()): Advisory[] {
  const out = new Map<string, Advisory>();
  const byCve = new Map(catalog.entries.map((e) => [e.cveID.toUpperCase(), e]));
  const to = (e: KevEntry, match: Advisory["match"]): Advisory => ({
    cve: e.cveID,
    title: e.vulnerabilityName,
    vendor: e.vendorProject,
    product: e.product,
    dateAdded: e.dateAdded,
    dueDate: e.dueDate,
    ransomware: /known/i.test(e.knownRansomwareCampaignUse ?? ""),
    description: e.shortDescription.slice(0, 500),
    requiredAction: e.requiredAction.slice(0, 300),
    source: `CISA KEV catalog ${catalog.version} (released ${catalog.released}, retrieved ${catalog.retrievedAt.slice(0, 10)})`,
    sourceUrl: `https://nvd.nist.gov/vuln/detail/${e.cveID}`,
    match,
  });
  for (const { cve, where } of stack.cves) {
    const e = byCve.get(cve.toUpperCase());
    if (e) out.set(e.cveID, to(e, { kind: "dependency", detail: `Listed by your dependency finding: ${where}`, verified: true }));
  }
  const yearAgo = now - 365 * 86_400_000;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const tech = [...new Set(stack.technologies.map((t) => norm(t.replace(/\s+\d[\w.^~<>=-]*$/, ""))).filter((t) => t.length >= 4))];
  for (const e of catalog.entries) {
    if (out.has(e.cveID) || Date.parse(e.dateAdded) < yearAgo) continue;
    const p = norm(e.product);
    const v = norm(e.vendorProject);
    const hit = tech.find((t) => t === p || t === v || (p.length >= 5 && t.includes(p)) || (t.length >= 5 && p.includes(t)));
    if (hit)
      out.set(
        e.cveID,
        to(e, {
          kind: "technology",
          detail: `${e.vendorProject} ${e.product} matches "${stack.technologies.find((x) => norm(x).includes(hit)) ?? hit}" in your website or code map; your version wasn't checked.`,
          verified: false,
        }),
      );
  }
  return [...out.values()].sort((a, b) => Number(b.match.verified) - Number(a.match.verified) || b.dateAdded.localeCompare(a.dateAdded)).slice(0, 40);
}

/** CVE ids in finding evidence, e.g. "OSV.dev GHSA-xxxx (CVE-2024-1234)". */
export function cvesIn(text: string): string[] {
  return [...new Set((text.match(/CVE-\d{4}-\d{4,7}/gi) ?? []).map((c) => c.toUpperCase()))];
}
