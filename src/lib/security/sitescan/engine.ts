import "server-only";
import type { LookupFunction } from "node:net";
import { EXPOSURE_PROBES } from "../sentinel";
import type { SafeRequestOptions, SafeResponse } from "../net";
import { analyseDns, type DnsQuery } from "./dns";
import { gradeChecks } from "./grade";
import {
  analyseContent,
  analyseCookies,
  analyseCors,
  analyseDirectoryListing,
  analyseDisclosure,
  analyseErrorPage,
  analyseHeaders,
  analyseSecurityTxt,
  analyseTrace,
  analyseTransport,
  headerValue,
  pageFacts,
  type HttpResponse,
  type TransportEvidence,
} from "./http-analysis";
import { analyseCertificate, analyseTls, classifyCipher } from "./tls-analysis";
import { scanTls } from "./tls-scan";
import { NOT_COVERED } from "./report";
import { CATEGORY_LABEL, check, type CheckCategory, type CheckResult, type ScanReport } from "./types";

/**
 * Runs one website scan: resolve → TLS → HTTP → (active scope) exposure → DNS → grade. Every network call goes
 * through `net` (in production the guarded lookup and safeRequest: public addresses only, ports 80/443, size and time
 * limits, no automatic redirects) and only to the authorised hostname (plus its www/apex twin when it redirects
 * there). Nothing is posted, submitted or modified on the site.
 */

export interface ScanNet {
  lookup: LookupFunction;
  httpsPort: number;
  httpPort: number;
  /** Test lab only: the lab's root CA. */
  ca?: string[];
  request: (url: string, opts?: SafeRequestOptions) => Promise<SafeResponse>;
}

export type ScanStep = "resolve" | "tls" | "http" | "exposure" | "dns" | "grade";
export const STEP_LABEL: Record<ScanStep, string> = {
  resolve: "Resolve the hostname",
  tls: "TLS protocols, ciphers and certificate",
  http: "HTTPS redirect, headers, cookies and content",
  exposure: "Exposed files and server methods",
  dns: "DNS: CAA, DNSSEC, SPF and DMARC",
  grade: "Score and grade",
};

export interface ScanEvents {
  step?: (id: ScanStep, status: "running" | "done" | "skipped" | "failed", detail?: string) => void;
  progress?: (text: string) => void;
}


const CATEGORY_ORDER: CheckCategory[] = ["certificate", "tls", "headers", "cookies", "content", "server", "exposure", "dns"];
const PROBE_ORIGIN = "https://orbis-cors-check.invalid";

export class ScanAbort extends Error {
  constructor(
    message: string,
    readonly kind: "dns" | "blocked",
  ) {
    super(message);
  }
}

function resolveAll(host: string, lookup: LookupFunction): Promise<string[]> {
  return new Promise((resolve, reject) =>
    lookup(host, { all: true }, (err, addrs) => (err ? reject(err) : resolve((addrs as unknown as { address: string }[]).map((a) => a.address)))),
  );
}

export async function runSiteScan(host: string, scope: "passive" | "active", net: ScanNet, dns: DnsQuery | null, o: ScanEvents & { signal?: AbortSignal; delayMs?: number; now?: () => Date } = {}): Promise<ScanReport> {
  const started = Date.now();
  const now = o.now ?? (() => new Date());
  const step = o.step ?? (() => {});
  const progress = o.progress ?? (() => {});
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const checks: CheckResult[] = [];
  const notes: string[] = [];
  let requests = 0;
  const abortIf = () => {
    if (o.signal?.aborted) throw o.signal.reason ?? new Error("Cancelled");
  };

  // 1. Resolve (through the same guarded lookup the connections use).
  step("resolve", "running");
  let addresses: string[];
  try {
    addresses = await resolveAll(host, net.lookup);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    const blocked = /private or reserved/.test(err.message ?? "");
    step("resolve", "failed", blocked ? "Resolves to a private or reserved address" : `DNS lookup failed (${err.code ?? err.message})`);
    throw new ScanAbort(blocked ? `${host} resolves to a private or reserved address, which Orbis never connects to.` : `${host} couldn't be resolved (${err.code ?? "DNS error"}). Check the domain name and its DNS records.`, blocked ? "blocked" : "dns");
  }
  step("resolve", "done", addresses.join(", "));

  // DNS record checks go to a different server (the DoH resolver), so they run alongside the site checks.
  const dnsJob = dns ? analyseDns(host, dns).catch((e) => ({ error: e instanceof Error ? e.message : String(e) })) : null;

  // 2. TLS
  abortIf();
  step("tls", "running");
  const tls = await scanTls({ host, port: net.httpsPort, lookup: net.lookup, ca: net.ca }, { signal: o.signal, progress, concurrency: 3 });
  notes.push(...tls.notes);
  let certificate: ScanReport["certificate"] = null;
  if (tls.evidence.reachable) {
    checks.push(...analyseTls(tls.evidence));
    const m = tls.main;
    const cert = analyseCertificate({ host, chain: m.chain.map((c) => c.der), authorized: m.authorized, authError: m.authError, hostnameError: m.hostnameError, ocspStapled: m.ocspStapled, now: now() });
    checks.push(...cert.checks);
    certificate = cert.summary;
    step("tls", "done", `${tls.handshakes} handshakes; ${Object.entries(tls.evidence.protocols).filter(([, v]) => v === "supported").map(([k]) => k.replace("TLSv1", "TLS 1.0").replace("TLS 1.0.", "TLS 1.")).join(", ") || "no protocol"} accepted`);
  } else {
    checks.push(check({ id: "tls.reachable", category: "tls", title: "HTTPS port reachable", status: "inconclusive", severity: "critical", summary: tls.notes[0] ?? "Port 443 couldn't be reached; no TLS checks were possible." }));
    step("tls", "failed", "Port 443 unreachable");
  }

  // 3. HTTP
  abortIf();
  step("http", "running");
  const get = async (url: string, extra: SafeRequestOptions = {}) => {
    requests++;
    const u = new URL(url);
    return net.request(url, {
      signal: o.signal,
      maxBytes: 512 * 1024,
      timeoutMs: 10_000,
      ...extra,
      // Headers are still read when the certificate is invalid (that's reported above); no credentials are sent.
      tls: { rejectUnauthorized: false, ...(net.ca ? { ca: net.ca } : {}) },
      connectPort: u.protocol === "https:" ? (net.httpsPort === 443 ? undefined : net.httpsPort) : net.httpPort === 80 ? undefined : net.httpPort,
    });
  };
  const sameSite = (h: string) => h === host || h === `www.${host}` || `www.${h}` === host;
  progress("Loading the home page over HTTPS");
  let transport: TransportEvidence["https"];
  try {
    let url = `https://${host}/`;
    const chain = [url];
    let res = await get(url, { headers: { origin: PROBE_ORIGIN } });
    for (let hop = 0; hop < 5 && res.status >= 300 && res.status < 400; hop++) {
      const loc = headerValue(res, "location");
      if (!loc) break;
      const next = new URL(loc, url);
      if (next.protocol !== "https:" || next.hostname !== host) {
        if (next.protocol === "https:" && sameSite(next.hostname)) notes.push(`${host} redirects to ${next.hostname}; scan that hostname too for its own headers and certificate.`);
        else notes.push(`The home page redirects to ${next.origin}, outside the authorised hostname, so the redirect response itself was checked.`);
        break;
      }
      url = next.toString();
      chain.push(url);
      res = await get(url, { headers: { origin: PROBE_ORIGIN } });
    }
    transport = { ok: true, res: { ...res, url }, chain };
  } catch (e) {
    transport = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  progress("Checking the plain HTTP redirect");
  let plain: TransportEvidence["http"];
  try {
    plain = { ok: true, res: await get(`http://${host}/`, { maxBytes: 16 * 1024 }) };
  } catch (e) {
    plain = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  checks.push(...analyseTransport({ host, https: transport, http: plain }));
  if (transport.ok) {
    const res: HttpResponse = transport.res;
    const facts = pageFacts(res);
    checks.push(...analyseHeaders(res, { metaCsp: facts.metaCsp }));
    checks.push(...analyseCookies([res]));
    checks.push(...analyseContent(res, facts));
    checks.push(...analyseDirectoryListing(facts, res.url));
    checks.push(...analyseDisclosure(res));
    checks.push(...analyseCors(res, PROBE_ORIGIN));
    progress("Requesting a page that doesn't exist");
    const missing = `https://${host}/orbis-scan-${Math.random().toString(36).slice(2, 10)}`;
    const nf = await get(missing, { maxBytes: 64 * 1024 }).then(
      (r) => ({ r, e: null }),
      (e: Error) => ({ r: null, e: e.message }),
    );
    checks.push(...analyseErrorPage(nf.r, nf.e ?? undefined));
    progress("Looking for security.txt");
    const st = await get(`https://${host}/.well-known/security.txt`, { maxBytes: 16 * 1024 }).catch(() => null);
    checks.push(...analyseSecurityTxt(st));
    step("http", "done", `HTTP ${res.status} from ${res.url}`);
  } else {
    for (const c of ["headers", "cookies", "content"] as const) checks.push(check({ id: `${c}.skipped`, category: c, title: CATEGORY_LABEL[c], status: "skipped", severity: "info", summary: "Skipped: the HTTPS home page couldn't be loaded." }));
    step("http", "failed", transport.error.slice(0, 160));
  }

  // 4. Exposure (active scope only): a fixed list of well-known sensitive paths, read-only GETs, one at a time.
  if (scope === "active" && transport.ok) {
    abortIf();
    step("exposure", "running");
    const exposed: CheckResult[] = [];
    let probed = 0;
    for (const p of EXPOSURE_PROBES) {
      if (o.signal?.aborted) break;
      progress(`Checking ${p.path}`);
      try {
        const r = await get(`https://${host}${p.path}`, { maxBytes: 32 * 1024 });
        probed++;
        const type = headerValue(r, "content-type") ?? "";
        if (r.status === 200 && !/text\/html/i.test(type) && p.match(r.body))
          exposed.push(check({ id: `exposure.${p.id}`, category: "exposure", title: p.title, status: "failed", severity: p.severity, summary: p.description, evidence: [{ label: `GET ${p.path}`, value: `HTTP 200, ${type || "no content type"}` }, { label: "Matched", value: p.evidence(r.body) }], remediation: p.remediation }));
      } catch {
        probed++;
      }
      await delay(o.delayMs ?? 200);
    }
    checks.push(...exposed);
    // A summary row; each exposed file is its own failed check above (and only those count towards the grade).
    checks.push(check({ id: "exposure.files", category: "exposure", title: "Well-known sensitive files", status: exposed.length ? "info" : "passed", severity: "high", summary: exposed.length ? `${exposed.length} of ${probed} sensitive paths are publicly readable (listed separately).` : `None of ${probed} well-known sensitive paths (${EXPOSURE_PROBES.map((p) => p.path).join(", ")}) is publicly readable.` }));
    progress("Checking whether TRACE is enabled");
    const tr = await get(`https://${host}/`, { method: "TRACE", maxBytes: 8 * 1024 }).catch(() => null);
    checks.push(...analyseTrace(tr));
    step("exposure", "done", `${probed} paths and TRACE checked`);
  } else {
    checks.push(check({ id: "exposure.files", category: "exposure", title: "Well-known sensitive files", status: "skipped", severity: "high", summary: scope === "active" ? "Skipped: the HTTPS home page couldn't be loaded." : "Skipped: passive scans don't request paths that aren't linked. Run an active scan to check for exposed .env, .git and backup files." }));
    step("exposure", "skipped", scope === "active" ? "HTTPS unavailable" : "Passive scope");
  }

  // 5. DNS
  step("dns", "running");
  if (dnsJob) {
    const d = await dnsJob;
    if ("error" in d) {
      checks.push(check({ id: "dns.records", category: "dns", title: "DNS records", status: "inconclusive", severity: "low", summary: `DNS record checks failed: ${d.error}.` }));
      step("dns", "failed", d.error.slice(0, 160));
    } else {
      checks.push(...d.checks);
      step("dns", "done", `${d.queries} DNS-over-HTTPS queries`);
    }
  } else {
    checks.push(check({ id: "dns.records", category: "dns", title: "DNS records", status: "untested", severity: "low", summary: "DNS record checks weren't available for this scan." }));
    step("dns", "skipped", "No resolver");
  }

  // Cancelled part-way: no grade from a partial scan.
  abortIf();
  step("grade", "running");
  checks.sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category));
  const { grade, note } = gradeChecks(checks);
  step("grade", "done", grade ? `${grade.letter} (${grade.score}/100)` : (note ?? "No grade"));

  return {
    version: 1,
    host,
    scope,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date().toISOString(),
    addresses,
    grade,
    gradeNote: note,
    checks,
    certificate,
    protocols: tls.evidence.protocols,
    ciphers: tls.evidence.ciphers.map((c) => ({ protocol: c.protocol, name: c.name, ...(({ strength, forwardSecrecy }) => ({ strength, forwardSecrecy }))(classifyCipher(c.name, c.protocol)) })),
    requests,
    handshakes: tls.handshakes,
    durationMs: Date.now() - started,
    notes,
    notCovered: NOT_COVERED,
  };
}
