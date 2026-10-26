import { describe, expect, it } from "vitest";
import { analyseDns, ancestors, dohQuery, type DnsQuery } from "@/lib/security/sitescan/dns";
import { deduction, gradeChecks } from "@/lib/security/sitescan/grade";
import { analyseCookies, analyseHeaders, analyseTransport, pageFacts, parseCsp, parseHsts, type HttpResponse } from "@/lib/security/sitescan/http-analysis";
import { check, type CheckResult } from "@/lib/security/sitescan/types";

const res = (headers: Record<string, string | string[]>, body = "", url = "https://site.test/"): HttpResponse => ({ url, status: 200, headers, body, truncated: false });
const ids = (cs: CheckResult[]) => Object.fromEntries(cs.map((c) => [c.id, c]));

describe("header grammar", () => {
  it("parses HSTS directives case-insensitively, first header wins", () => {
    expect(parseHsts('max-age="31536000"; includeSubDomains; PRELOAD')).toEqual({ maxAge: 31536000, includeSubDomains: true, preload: true });
    expect(parseHsts("max-age=60, max-age=31536000")).toMatchObject({ maxAge: 60 });
    expect(parseHsts("includeSubDomains")).toMatchObject({ maxAge: null });
  });
  it("parses CSP into policies and keeps the first directive of a name", () => {
    const [p] = parseCsp("default-src 'self';  script-src 'self' 'nonce-abc'; script-src *");
    expect(p!.get("script-src")).toEqual(["'self'", "'nonce-abc'"]);
    expect(parseCsp("a b, c d")).toHaveLength(2);
  });
});

describe("header checks", () => {
  it("judges HSTS strength", () => {
    expect(ids(analyseHeaders(res({ "strict-transport-security": "max-age=86400" })))["headers.hsts"]).toMatchObject({ status: "warning" });
    expect(ids(analyseHeaders(res({ "strict-transport-security": "max-age=0" })))["headers.hsts"]).toMatchObject({ status: "failed" });
  });
  it("accepts unsafe-inline only alongside nonces/hashes or strict-dynamic", () => {
    const weak = ids(analyseHeaders(res({ "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; object-src 'none'" })))["headers.csp"];
    expect(weak.status).toBe("warning");
    expect(weak.summary).toMatch(/unsafe-inline/);
    const ok = ids(analyseHeaders(res({ "content-security-policy": "script-src 'nonce-r4nd' 'unsafe-inline' 'strict-dynamic'; object-src 'none'" })))["headers.csp"];
    expect(ok.status).toBe("passed");
    const meta = ids(analyseHeaders(res({}), { metaCsp: "default-src 'none'" }))["headers.csp"];
    expect(meta.summary).toMatch(/meta/);
    expect(ids(analyseHeaders(res({ "content-security-policy-report-only": "default-src 'self'" })))["headers.csp"].status).toBe("warning");
  });
  it("frame-ancestors beats a missing X-Frame-Options; ALLOW-FROM doesn't count", () => {
    expect(ids(analyseHeaders(res({ "content-security-policy": "frame-ancestors 'self'" })))["headers.clickjacking"].status).toBe("passed");
    expect(ids(analyseHeaders(res({ "x-frame-options": "ALLOW-FROM https://a.test" })))["headers.clickjacking"].status).toBe("failed");
  });
  it("treats an absent Referrer-Policy as informational and unsafe-url as a warning", () => {
    expect(ids(analyseHeaders(res({})))["headers.referrer"].status).toBe("info");
    expect(ids(analyseHeaders(res({ "referrer-policy": "no-referrer, unsafe-url" })))["headers.referrer"].status).toBe("warning");
  });
});

describe("cookies", () => {
  it("never puts cookie values in evidence", () => {
    const cs = ids(analyseCookies([res({ "set-cookie": ["session_token=SECRETVALUE; Path=/", "theme=dark; Secure; SameSite=Lax"] })]));
    expect(cs["cookies.secure"]).toMatchObject({ status: "failed", severity: "medium" });
    expect(cs["cookies.httponly"]).toMatchObject({ status: "failed", confirmed: false });
    expect(JSON.stringify(cs)).not.toContain("SECRETVALUE");
  });
  it("reports that there was nothing to check", () => {
    expect(analyseCookies([res({})])[0]).toMatchObject({ id: "cookies.none", status: "info" });
  });
});

describe("HTML facts (parse5)", () => {
  it("finds mixed content in real markup, not in text or comments", () => {
    const f = pageFacts(res({ "content-type": "text/html" }, '<!-- <script src="http://x.test/a.js"></script> --><p>http://y.test/b.js</p><link rel="preload stylesheet" href="http://z.test/s.css"><video><source src="http://v.test/m.mp4"></video><template><img src="http://t.test/i.png"></template>'));
    expect(f.activeMixed).toEqual([{ tag: "stylesheet", url: "http://z.test/s.css" }]);
    expect(f.passiveMixed.map((m) => m.url)).toEqual(expect.arrayContaining(["http://v.test/m.mp4", "http://t.test/i.png"]));
  });
  it("resolves relative URLs against the page and spots directory listings", () => {
    const f = pageFacts(res({ "content-type": "text/html" }, "<title>Index of /files</title><script src='//cdn.test/x.js' integrity='sha384-x'></script>"));
    expect(f.directoryListing).toBe(true);
    expect(f.thirdPartyScripts).toEqual([{ url: "https://cdn.test/x.js", integrity: true }]);
  });
});

describe("transport", () => {
  it("separates a closed port 80 (info) from serving plain HTTP (failed)", () => {
    const https = { ok: true as const, res: res({}), chain: ["https://site.test/"] };
    expect(ids(analyseTransport({ host: "site.test", https, http: { ok: false, error: "ECONNREFUSED" } }))["http.redirect"].status).toBe("info");
    expect(ids(analyseTransport({ host: "site.test", https, http: { ok: true, res: { ...res({}), url: "http://site.test/" } } }))["http.redirect"].status).toBe("failed");
    expect(ids(analyseTransport({ host: "site.test", https, http: { ok: true, res: { ...res({ location: "https://site.test/" }), status: 308 } } }))["http.redirect"].status).toBe("passed");
  });
});

describe("DNS", () => {
  const zone =
    (z: Record<string, { status?: number; ad?: boolean; rr?: Partial<Record<string, string[]>> }>): DnsQuery =>
    async (name, type) => ({ status: z[name]?.status ?? 0, ad: !!z[name]?.ad, answers: (z[name]?.rr?.[type] ?? []).map((d) => ({ name, type: 0, data: d })) });

  it("walks up to the closest CAA record", async () => {
    expect(ancestors("a.b.example.com")).toEqual(["a.b.example.com", "b.example.com", "example.com"]);
    const { checks } = await analyseDns("www.example.com", zone({ "example.com": { rr: { CAA: ['0 issue "letsencrypt.org"', '0 iodef "mailto:x@example.com"'] } } }));
    expect(ids(checks)["dns.caa"]).toMatchObject({ status: "passed" });
    expect(ids(checks)["dns.caa"].summary).toMatch(/Set on example\.com: only letsencrypt\.org may issue/);
  });
  it("reports a signed zone that fails validation as a confirmed outage risk", async () => {
    const { checks } = await analyseDns("broken.test", zone({ "broken.test": { status: 2, rr: { DS: ["1 13 2 abc"] } } }));
    const c = ids(checks);
    expect(c["dns.caa"].status).toBe("inconclusive");
    expect(c["dns.dnssec"]).toMatchObject({ status: "failed", severity: "high" });
  });
  it("flags duplicate SPF records and DMARC in monitoring mode", async () => {
    const { checks } = await analyseDns("mail.test", zone({ "mail.test": { rr: { TXT: ['"v=spf1 -all"', '"v=spf1 ~all"'] } }, "_dmarc.mail.test": { rr: { TXT: ["v=DMARC1; p=none"] } } }));
    expect(ids(checks)["dns.spf"].status).toBe("failed");
    expect(ids(checks)["dns.dmarc"].status).toBe("warning");
  });
  it("DoH client falls back to the second resolver and reports AD", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      if (url.startsWith("https://dns.google")) return new Response("down", { status: 503 });
      return Response.json({ Status: 0, AD: true, Answer: [{ name: "x.test.", type: 1, data: "203.0.113.9" }, { name: "x.test.", type: 5, data: "cname" }] });
    }) as unknown as typeof fetch;
    const r = await dohQuery({ fetchImpl })("x.test", "A");
    expect(r).toEqual({ status: 0, ad: true, answers: [{ name: "x.test.", type: 1, data: "203.0.113.9" }] });
    expect(calls[1]).toMatch(/^https:\/\/cloudflare-dns\.com\/dns-query\?name=x\.test&type=A&do=1$/);
  });
});

describe("grade", () => {
  const base = [
    check({ id: "https.available", category: "server", title: "HTTPS", status: "passed", severity: "critical", summary: "" }),
    check({ id: "cert.trusted", category: "certificate", title: "Certificate is trusted", status: "passed", severity: "critical", summary: "" }),
    check({ id: "headers.hsts", category: "headers", title: "HSTS", status: "passed", severity: "medium", summary: "" }),
    check({ id: "tls.tls13", category: "tls", title: "TLS 1.3", status: "passed", severity: "low", summary: "" }),
  ];
  it("documented deductions: warnings and inferred failures count half; untested counts nothing", () => {
    expect(deduction(check({ id: "x", category: "tls", title: "", status: "failed", severity: "medium", summary: "" }))).toBe(12);
    expect(deduction(check({ id: "x", category: "tls", title: "", status: "warning", severity: "medium", summary: "" }))).toBe(6);
    expect(deduction(check({ id: "x", category: "tls", title: "", status: "failed", severity: "high", confirmed: false, summary: "" }))).toBe(12.5);
    expect(deduction(check({ id: "x", category: "tls", title: "", status: "untested", severity: "critical", summary: "" }))).toBe(0);
  });
  it("A+ needs HSTS, TLS 1.3 and no transport warnings", () => {
    expect(gradeChecks(base).grade).toMatchObject({ letter: "A+", score: 100 });
    const noHsts = base.map((c) => (c.id === "headers.hsts" ? { ...c, status: "failed" as const } : c));
    expect(gradeChecks(noHsts).grade).toMatchObject({ letter: "A", plus: "Not A+: needs HSTS of at least 180 days." });
  });
  it("caps: confirmed critical → F, confirmed high → C, legacy TLS → B", () => {
    const withCheck = (c: Partial<CheckResult>) => gradeChecks([...base, check({ id: "x", category: "tls", title: "X", status: "failed", severity: "low", summary: "", ...c })]).grade!;
    expect(withCheck({ severity: "critical" }).letter).toBe("F");
    expect(withCheck({ severity: "high" }).letter).toBe("C");
    expect(withCheck({ severity: "high", confirmed: false }).letter).not.toBe("C");
    expect(withCheck({ id: "tls.legacy-protocols", severity: "medium" })).toMatchObject({ letter: "B", caps: ["TLS 1.0/1.1 accepted (at most B)"] });
  });
  it("no grade without HTTPS or a certificate", () => {
    expect(gradeChecks([check({ id: "https.available", category: "server", title: "", status: "inconclusive", severity: "critical", summary: "" })]).grade).toBeNull();
  });
});
