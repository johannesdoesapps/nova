import "server-only";
import { readFileSync } from "node:fs";
import type { LookupFunction } from "node:net";
import { guardedLookup, safeRequest, type SafeRequestOptions } from "../net";
import { dohQuery, type DnsAnswer, type DnsQuery } from "./dns";
import type { ScanNet } from "./engine";

/**
 * How a scan reaches the network. Production: the guarded lookup (public addresses only), ports 443/80, safeRequest
 * and DNS-over-HTTPS. The local test lab is a separate path used only by Orbis's own end-to-end tests: it needs the
 * ORBIS_SITESCAN_LAB setting (a JSON file describing local test servers), works only for reserved *.test hostnames
 * (RFC 2606, never resolvable on the internet) and is never active on Vercel.
 */

interface LabHost {
  https: number;
  http?: number;
  dns?: Partial<Record<"A" | "AAAA" | "CAA" | "TXT" | "DS" | "DNSKEY", string[]>> & { ad?: boolean };
}
interface LabConfig {
  ca: string;
  hosts: Record<string, LabHost>;
}

export function labConfig(host: string): (LabConfig & { entry: LabHost | null }) | null {
  const file = process.env.ORBIS_SITESCAN_LAB;
  if (!file || process.env.VERCEL || !host.endsWith(".test")) return null;
  try {
    const cfg = JSON.parse(readFileSync(file, "utf8")) as LabConfig;
    return { ...cfg, entry: cfg.hosts[host] ?? null };
  } catch {
    return null;
  }
}

export function scanNetFor(host: string, signal?: AbortSignal): { net: ScanNet; dns: DnsQuery; lab: boolean; request: ScanNet["request"]; txt?: (name: string) => Promise<string[]> } {
  const lab = labConfig(host);
  if (!lab) {
    const request = (url: string, o?: SafeRequestOptions) => safeRequest(url, o);
    return { net: { lookup: guardedLookup, httpsPort: 443, httpPort: 80, request }, dns: dohQuery({ signal }), lab: false, request };
  }
  const known = (h: string) => !!lab.hosts[h];
  const lookup = ((h: string, o: { all?: boolean }, cb: (e: NodeJS.ErrnoException | null, a: unknown, f?: number) => void) => {
    if (!known(h)) return cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${h}`), { code: "ENOTFOUND" }), "", 4);
    return o?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4);
  }) as unknown as LookupFunction;
  const ca = [readFileSync(lab.ca, "utf8")];
  const entry = lab.entry ?? { https: 1, http: 1 };
  const request = (url: string, o: SafeRequestOptions = {}) => {
    const u = new URL(url);
    const e = lab.hosts[u.hostname];
    return safeRequest(url, { ...o, lookup, tls: { rejectUnauthorized: o.tls?.rejectUnauthorized ?? true, ca }, connectPort: u.protocol === "https:" ? e?.https : (e?.http ?? 1) });
  };
  const dns: DnsQuery = async (name, type): Promise<DnsAnswer> => {
    const owner = Object.entries(lab.hosts).find(([h]) => name === h || name.endsWith(`.${h}`) || h.endsWith(`.${name}`));
    const d = lab.hosts[name]?.dns;
    const data = d?.[type] ?? (type === "A" && known(name) ? ["127.0.0.1"] : []);
    const codes = { A: 1, AAAA: 28, CAA: 257, TXT: 16, DS: 43, DNSKEY: 48 } as const;
    return { status: owner || known(name) || name.startsWith("_dmarc.") ? 0 : 3, ad: !!d?.ad, answers: data.map((v) => ({ name, type: codes[type], data: v })) };
  };
  return {
    net: { lookup, httpsPort: entry.https, httpPort: entry.http ?? 1, ca, request },
    dns,
    lab: true,
    request,
    txt: async (name) => (name.startsWith("_orbis-verify.") ? (lab.hosts[name.slice("_orbis-verify.".length)]?.dns?.TXT ?? []) : []),
  };
}
