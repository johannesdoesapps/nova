import { isPublicAddress } from "./net-pure";
import { fingerprint, type FindingDraft } from "./types";

/** AbuseIPDB lookups. Only runs when ABUSEIPDB_API_KEY is configured. */

export interface IpReputation {
  ip: string;
  score: number;
  reports: number;
  country: string | null;
  isp: string | null;
  lastReportedAt: string | null;
}

export async function abuseIpLookup(ips: string[], apiKey: string, opts: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {}): Promise<{ results: IpReputation[]; failed: string[] }> {
  const f = opts.fetchImpl ?? fetch;
  const results: IpReputation[] = [];
  const failed: string[] = [];
  for (const ip of ips.filter(isPublicAddress).slice(0, 15)) {
    try {
      const r = await f(`https://api.abuseipdb.com/api/v2/check?ipAddress=${encodeURIComponent(ip)}&maxAgeInDays=90`, {
        headers: { Key: apiKey, Accept: "application/json" },
        signal: opts.signal,
      });
      if (!r.ok) {
        failed.push(ip);
        continue;
      }
      const d = ((await r.json()) as { data?: { abuseConfidenceScore?: number; totalReports?: number; countryCode?: string; isp?: string; lastReportedAt?: string } }).data ?? {};
      results.push({ ip, score: d.abuseConfidenceScore ?? 0, reports: d.totalReports ?? 0, country: d.countryCode ?? null, isp: d.isp ?? null, lastReportedAt: d.lastReportedAt ?? null });
    } catch {
      failed.push(ip);
    }
  }
  return { results, failed };
}

export function reputationFindings(results: IpReputation[], asset: string): FindingDraft[] {
  return results
    .filter((r) => r.score >= 25 && r.reports > 0)
    .map((r) => ({
      agent: "threat_hunter" as const,
      ruleId: "intel.abuseipdb",
      fingerprint: fingerprint("threat_hunter", "intel.abuseipdb", asset, r.ip),
      title: `${r.ip} has ${r.reports} abuse report(s) (AbuseIPDB score ${r.score})`,
      description: `AbuseIPDB lists ${r.reports} report(s) in the last 90 days for this address${r.isp ? ` (${r.isp}${r.country ? `, ${r.country}` : ""})` : ""}. This is third-party reputation data about the address, not proof of what it did to you.`,
      severity: r.score >= 75 ? "medium" : "low",
      confidence: "firm" as const,
      rationale: `AbuseIPDB confidence score ${r.score}/100. Shared or rotating addresses (VPNs, cloud hosts) can carry reports from other users.`,
      asset,
      location: r.ip,
      evidence: [{ source: "AbuseIPDB", detail: `score ${r.score}, ${r.reports} reports, last reported ${r.lastReportedAt ?? "unknown"}` }],
      evidenceSource: "abuseipdb",
      remediation: "Consider blocking the address at your firewall or CDN if it's also active in your logs.",
      references: [`https://www.abuseipdb.com/check/${r.ip}`],
    }));
}
