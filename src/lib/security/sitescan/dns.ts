/**
 * DNS checks for the website scan: CAA (which CAs may issue certificates), DNSSEC (whether answers are signed and
 * validated) and the domain's email-spoofing records (SPF, DMARC). Lookups go through a DNS-over-HTTPS resolver
 * (Google Public DNS, then Cloudflare), because the AD ("authenticated data") flag that shows DNSSEC validation isn't
 * available from Node's resolver. Only the scanned hostname and its parent names are sent to the resolver.
 */
import { check, type CheckResult } from "./types";

export interface DnsAnswer {
  /** DNS RCODE: 0 NOERROR, 2 SERVFAIL, 3 NXDOMAIN. */
  status: number;
  /** The resolver validated the answer with DNSSEC. */
  ad: boolean;
  answers: { name: string; type: number; data: string }[];
}
export type DnsQuery = (name: string, type: "A" | "AAAA" | "CAA" | "TXT" | "DS" | "DNSKEY") => Promise<DnsAnswer>;

const TYPE = { A: 1, AAAA: 28, CAA: 257, TXT: 16, DS: 43, DNSKEY: 48 } as const;
const RESOLVERS = ["https://dns.google/resolve", "https://cloudflare-dns.com/dns-query"];

/** DNS-over-HTTPS JSON API (supported by both resolvers), DNSSEC OK bit set, short timeout, tries the next resolver on failure. */
export function dohQuery(opts: { timeoutMs?: number; fetchImpl?: typeof fetch; signal?: AbortSignal } = {}): DnsQuery {
  const f = opts.fetchImpl ?? fetch;
  return async (name, type) => {
    let lastErr: unknown;
    for (const base of RESOLVERS) {
      try {
        const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs ?? 5000)]) : AbortSignal.timeout(opts.timeoutMs ?? 5000);
        const res = await f(`${base}?name=${encodeURIComponent(name)}&type=${type}&do=1`, { headers: { accept: "application/dns-json" }, signal, redirect: "error" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = (await res.json()) as { Status?: number; AD?: boolean; Answer?: { name: string; type: number; data: string }[] };
        if (typeof j.Status !== "number") throw new Error("Unexpected resolver response");
        return { status: j.Status, ad: !!j.AD, answers: (j.Answer ?? []).filter((a) => a.type === TYPE[type]) };
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        lastErr = e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("DNS lookup failed");
  };
}

/** The name and its parents, stopping above the registrable part (two labels; good enough to find a CAA/DMARC record). */
export function ancestors(host: string): string[] {
  const labels = host.split(".");
  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join("."));
  return out;
}

const unquote = (s: string) => s.replace(/^"|"$/g, "").replace(/"\s*"/g, "");

export async function analyseDns(host: string, q: DnsQuery): Promise<{ checks: CheckResult[]; queries: number }> {
  const out: CheckResult[] = [];
  let queries = 0;
  const ask: DnsQuery = (n, t) => {
    queries++;
    return q(n, t);
  };
  const safe = async <T,>(fn: () => Promise<T>): Promise<T | Error> => {
    try {
      return await fn();
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
  };

  // CAA: the closest name (the host or a parent) with CAA records governs issuance (RFC 8659 §3).
  const caa = await safe(async () => {
    for (const name of ancestors(host)) {
      const r = await ask(name, "CAA");
      if (r.status === 2) throw new Error(`SERVFAIL for ${name}`);
      if (r.answers.length) return { name, records: r.answers.map((a) => a.data) };
    }
    return null;
  });
  if (caa instanceof Error) out.push(check({ id: "dns.caa", category: "dns", title: "CAA records", status: "inconclusive", severity: "low", summary: `The CAA lookup failed (${caa.message}).` }));
  else if (!caa)
    out.push(check({ id: "dns.caa", category: "dns", title: "CAA records", status: "warning", severity: "low", summary: "No CAA records: any certificate authority may issue certificates for this domain.", remediation: 'Add a CAA record naming the CA you use, e.g. example.com. CAA 0 issue "letsencrypt.org".', references: ["https://www.rfc-editor.org/rfc/rfc8659"] }));
  else {
    const issuers = caa.records.filter((r) => /\bissue(wild)?\b/i.test(r)).map((r) => r.replace(/^\d+\s+/, ""));
    out.push(check({ id: "dns.caa", category: "dns", title: "CAA records", status: "passed", severity: "low", summary: `${caa.name === host ? "On this name" : `Set on ${caa.name}`}: ${issuers.length ? `only ${issuers.map((i) => unquote(i.split(/\s+/).slice(1).join(" ")).split(";")[0]!.trim() || "no CA").join(", ")} may issue certificates` : "CAA records exist but none restricts issuance (no issue tag)"}.`, evidence: caa.records.map((r) => ({ label: `CAA ${caa.name}`, value: r })) }));
  }

  // DNSSEC: the resolver sets AD when the answer validated; a DS record at the zone shows it's meant to be signed.
  const a = await safe(() => ask(host, "A"));
  const ds = await safe(async () => {
    for (const name of ancestors(host)) {
      const r = await ask(name, "DS");
      if (r.answers.length) return name;
    }
    return null;
  });
  if (a instanceof Error) out.push(check({ id: "dns.dnssec", category: "dns", title: "DNSSEC", status: "inconclusive", severity: "low", summary: `The DNS lookup failed (${a.message}).` }));
  else if (a.status === 2 && typeof ds === "string") out.push(check({ id: "dns.dnssec", category: "dns", title: "DNSSEC", status: "failed", severity: "high", summary: `The zone is signed (DS at ${ds}) but validation fails (SERVFAIL): validating resolvers can't reach the site.`, remediation: "Fix the DNSSEC chain (re-sign the zone or update the DS record at your registrar)." }));
  else if (a.ad) out.push(check({ id: "dns.dnssec", category: "dns", title: "DNSSEC", status: "passed", severity: "low", summary: "DNS answers are signed and validated (DNSSEC).", evidence: [{ label: "Resolver", value: "AD flag set" }] }));
  else out.push(check({ id: "dns.dnssec", category: "dns", title: "DNSSEC", status: "info", severity: "low", summary: "DNS answers aren't DNSSEC-signed. Optional, but it stops DNS spoofing from redirecting visitors or mis-issuing certificates.", remediation: "Enable DNSSEC at your DNS provider and add the DS record at your registrar." }));

  const aaaa = await safe(() => ask(host, "AAAA"));
  if (!(aaaa instanceof Error)) out.push(check({ id: "dns.ipv6", category: "dns", title: "IPv6", status: "info", severity: "info", summary: aaaa.answers.length ? `Reachable over IPv6 (${aaaa.answers.length} AAAA record${aaaa.answers.length === 1 ? "" : "s"}). Orbis's TLS checks used the first address returned.` : "No IPv6 (AAAA) address." }));

  // Email spoofing protection for the domain (anyone can send mail "from" a domain without these).
  const apex = ancestors(host).at(-1)!;
  const txt = await safe(() => ask(apex, "TXT"));
  if (txt instanceof Error) out.push(check({ id: "dns.spf", category: "dns", title: "SPF (email)", status: "inconclusive", severity: "low", summary: `The TXT lookup failed (${txt.message}).` }));
  else {
    const spf = txt.answers.map((x) => unquote(x.data)).filter((v) => /^v=spf1\b/i.test(v));
    const all = spf[0]?.match(/([~?+-])?all\b/i)?.[1] ?? null;
    out.push(
      !spf.length
        ? check({ id: "dns.spf", category: "dns", title: "SPF (email)", status: "warning", severity: "low", summary: `${apex} has no SPF record, so receivers can't tell which servers may send its email.`, remediation: `If ${apex} sends no email, publish "v=spf1 -all"; otherwise list your mail providers.`, references: ["https://www.rfc-editor.org/rfc/rfc7208"] })
        : spf.length > 1
          ? check({ id: "dns.spf", category: "dns", title: "SPF (email)", status: "failed", severity: "low", summary: `${apex} has ${spf.length} SPF records; that's a permanent error and receivers ignore them all.`, evidence: spf.map((v) => ({ label: "TXT", value: v })), remediation: "Merge them into one v=spf1 record." })
          : check({ id: "dns.spf", category: "dns", title: "SPF (email)", status: all === "+" || all === "?" || all === null ? "warning" : "passed", severity: "low", summary: all === "+" || all === "?" || all === null ? "SPF exists but doesn't reject other senders (no -all or ~all)." : `SPF ends with ${all}all.`, evidence: [{ label: `TXT ${apex}`, value: spf[0]! }] }),
    );
  }
  const dmarc = await safe(async () => {
    for (const name of [host, apex].filter((n, i, xs) => xs.indexOf(n) === i)) {
      const r = await ask(`_dmarc.${name}`, "TXT");
      const rec = r.answers.map((x) => unquote(x.data)).find((v) => /^v=DMARC1\b/i.test(v));
      if (rec) return { name, rec };
    }
    return null;
  });
  if (dmarc instanceof Error) out.push(check({ id: "dns.dmarc", category: "dns", title: "DMARC (email)", status: "inconclusive", severity: "low", summary: `The DMARC lookup failed (${dmarc.message}).` }));
  else if (!dmarc) out.push(check({ id: "dns.dmarc", category: "dns", title: "DMARC (email)", status: "warning", severity: "low", summary: `No DMARC record for ${apex}: mail forged in its name isn't rejected by policy.`, remediation: `Publish _dmarc.${apex} TXT "v=DMARC1; p=quarantine; rua=mailto:…" (start with p=none to monitor).`, references: ["https://www.rfc-editor.org/rfc/rfc7489"] }));
  else {
    const p = /(?:^|;)\s*p\s*=\s*(\w+)/i.exec(dmarc.rec)?.[1]?.toLowerCase() ?? "none";
    out.push(check({ id: "dns.dmarc", category: "dns", title: "DMARC (email)", status: p === "none" ? "warning" : "passed", severity: "low", summary: p === "none" ? "DMARC is in monitoring mode (p=none): forged mail isn't rejected." : `DMARC policy p=${p}.`, evidence: [{ label: `_dmarc.${dmarc.name}`, value: dmarc.rec }] }));
  }
  return { checks: out, queries };
}
