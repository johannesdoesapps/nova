import type { LookupFunction } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { safeRequest } from "@/lib/security/net";
import type { DnsQuery } from "@/lib/security/sitescan/dns";
import { runSiteScan, ScanAbort, type ScanNet } from "@/lib/security/sitescan/engine";
import { findingsFrom, fitReport, toHtml, toMarkdown } from "@/lib/security/sitescan/report";
import { packReport, unpackReport } from "@/lib/security/sitescan/store";
import type { CheckResult, ScanReport } from "@/lib/security/sitescan/types";
import { badSite, goodSite, hasOpenssl, makeLab, presets, redirectToHttps, serveHttp, serveTls, type Lab, type LabServer } from "./helpers/tls-lab";

const loopback = ((_h: string, o: { all?: boolean }, cb: (e: null, a: unknown, f?: number) => void) =>
  o?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4)) as unknown as LookupFunction;

/** Recorded DNS answers for the lab domains (the real resolver is DNS-over-HTTPS, which tests don't reach). */
const dnsFor =
  (zone: Record<string, { CAA?: string[]; TXT?: string[]; ad?: boolean }>): DnsQuery =>
  async (name, type) => {
    const z = zone[name];
    const data = type === "A" ? ["127.0.0.1"] : type === "CAA" ? (z?.CAA ?? []) : type === "TXT" ? (z?.TXT ?? []) : [];
    return { status: 0, ad: !!zone[name]?.ad || (type === "A" && Object.values(zone).some((v) => v.ad)), answers: data.map((d) => ({ name, type: 0, data: d })) };
  };
const byId = (r: ScanReport) => Object.fromEntries(r.checks.map((c) => [c.id, c])) as Record<string, CheckResult>;

describe.skipIf(!hasOpenssl())("website scan engine against controlled sites", () => {
  let lab: Lab;
  const s: Record<string, LabServer> = {};
  const net = (https: string, http?: string): ScanNet => ({
    lookup: loopback,
    httpsPort: s[https]!.port,
    httpPort: http ? s[http]!.port : 1,
    ca: [lab.root],
    request: (url, o) => safeRequest(url, { ...o, lookup: loopback }),
  });

  beforeAll(async () => {
    lab = makeLab();
    const p = presets(lab);
    s.good = await serveTls(p.good, goodSite);
    s.goodHttp = await serveHttp(redirectToHttps("good.test"));
    s.bad = await serveTls(p.legacy, badSite);
    s.badHttp = await serveHttp(badSite);
    s.expired = await serveTls(p.expired, goodSite);
  }, 60_000);
  afterAll(async () => {
    await Promise.all(Object.values(s).map((x) => x.close()));
  });

  it("grades a well-configured site A+ with every check accounted for", async () => {
    const steps: string[] = [];
    const r = await runSiteScan(
      "good.test",
      "active",
      net("good", "goodHttp"),
      dnsFor({ "good.test": { CAA: ['0 issue "letsencrypt.org"'], TXT: ["v=spf1 -all"], ad: true }, "_dmarc.good.test": { TXT: ["v=DMARC1; p=reject"] } }),
      { delayMs: 0, step: (id, status) => steps.push(`${id}:${status}`) },
    );
    const c = byId(r);
    const failing = r.checks.filter((x) => x.status === "failed" || x.status === "warning").map((x) => `${x.id}: ${x.summary}`);
    expect(failing).toEqual([]);
    expect(r.grade).toMatchObject({ letter: "A+", score: 100 });
    for (const id of ["https.available", "http.redirect", "headers.hsts", "headers.csp", "headers.xcto", "headers.clickjacking", "headers.referrer", "cookies.secure", "cookies.httponly", "cookies.samesite", "content.mixed", "server.disclosure", "server.error-page", "server.cors", "server.security-txt", "server.trace", "exposure.files", "dns.caa", "dns.dnssec", "dns.spf", "dns.dmarc"])
      expect(c[id]?.status, id).toBe("passed");
    expect(c["tls.ssl"].status).toBe("untested");
    expect(c["tls.vuln-untested"].status).toBe("untested");
    expect(steps).toEqual(["resolve:running", "resolve:done", "tls:running", "tls:done", "http:running", "http:done", "exposure:running", "exposure:done", "dns:running", "dns:done", "grade:running", "grade:done"]);
    expect(r.certificate?.names).toEqual(["good.test"]);
    expect(r.notCovered.length).toBeGreaterThan(3);
    expect(findingsFrom(r)).toEqual([]);
  }, 120_000);

  it("finds the problems on a badly configured site and grades it F", async () => {
    const r = await runSiteScan("bad.test", "active", net("bad", "badHttp"), dnsFor({}), { delayMs: 0 });
    const c = byId(r);
    expect(r.grade?.letter).toBe("F");
    expect(r.grade?.caps.join(" ")).toMatch(/insecure cipher suites/i);
    expect(c["tls.legacy-protocols"].status).toBe("failed");
    expect(c["tls.ciphers-insecure"].status).toBe("failed");
    expect(c["http.redirect"]).toMatchObject({ status: "failed", severity: "medium" });
    expect(c["headers.hsts"].status).toBe("failed");
    expect(c["headers.csp"].status).toBe("failed");
    expect(c["headers.clickjacking"].status).toBe("failed");
    expect(c["headers.xcto"].status).toBe("failed");
    expect(c["cookies.secure"]).toMatchObject({ status: "failed", severity: "medium" });
    expect(c["cookies.secure"].summary).toMatch(/sessionid/);
    expect(c["cookies.httponly"]).toMatchObject({ status: "failed", confirmed: false });
    expect(c["cookies.samesite"].status).toBe("failed");
    expect(c["content.mixed"]).toMatchObject({ status: "failed", severity: "high" });
    expect(c["content.mixed"].evidence.map((e) => e.value)).toContain("http://cdn.bad.test/jquery.js");
    expect(c["content.forms"].status).toBe("failed");
    expect(c["content.third-party-scripts"].summary).toMatch(/1 without Subresource Integrity/);
    expect(c["server.disclosure"].evidence.map((e) => e.label)).toEqual(["Server", "x-powered-by"]);
    expect(c["server.error-page"]).toMatchObject({ status: "failed" });
    expect(c["server.error-page"].summary).toMatch(/Python traceback/);
    expect(c["server.cors"]).toMatchObject({ status: "failed", severity: "high" });
    expect(c["server.trace"].status).toBe("warning");
    expect(c["exposure.env-file"]).toMatchObject({ status: "failed", severity: "critical" });
    // Secret values never reach the report.
    expect(JSON.stringify(r)).not.toContain("synthetic-lab-value");
    expect(c["dns.caa"].status).toBe("warning");
    expect(c["dns.dnssec"].status).toBe("info");
    const findings = findingsFrom(r);
    expect(findings.length).toBeGreaterThan(15);
    expect(new Set(findings.map((f) => f.fingerprint)).size).toBe(findings.length);
    // Exports: Markdown, self-contained HTML, and a stats-sized copy.
    expect(toMarkdown(r)).toMatch(/## Not covered by this scan/);
    const html = toHtml(r);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("Website security scan: bad.test");
    expect(Buffer.byteLength(JSON.stringify(r))).toBeGreaterThan(19_000);
    // Stored losslessly: gzip + base64 fits the run's stats budget; the trimmed copy is only a fallback.
    const packed = packReport(r, 18_000);
    expect("reportGz" in packed && packed.reportGz.length).toBeLessThan(18_000);
    expect(unpackReport(packed, "run-1")).toEqual({ ...r, runId: "run-1" });
    expect("report" in packReport(r, 2_000) && (packReport(r, 2_000) as { report: ScanReport }).report.trimmed).toBe(true);
    for (const max of [18_000, 14_000]) {
      const fitted = fitReport(r, max);
      expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(max);
      expect(fitted.trimmed).toBe(true);
      expect(fitted.checks.map((x) => x.status)).toEqual(r.checks.map((x) => x.status));
    }
  }, 120_000);

  it("passive scope doesn't request unlinked paths", async () => {
    const r = await runSiteScan("bad.test", "passive", net("bad", "badHttp"), dnsFor({}), { delayMs: 0 });
    const c = byId(r);
    expect(c["exposure.files"].status).toBe("skipped");
    expect(c["exposure.env-file"]).toBeUndefined();
    expect(c["server.trace"]).toBeUndefined();
  }, 120_000);

  it("an expired certificate fails the grade but the headers are still read", async () => {
    const r = await runSiteScan("expired.test", "passive", net("expired"), dnsFor({}), { delayMs: 0 });
    const c = byId(r);
    expect(r.grade?.letter).toBe("F");
    expect(c["cert.trusted"].status).toBe("failed");
    expect(c["headers.hsts"].status).toBe("passed");
    expect(c["http.redirect"].status).toBe("info");
  }, 120_000);

  it("unreachable HTTPS gives no grade instead of a guess; DNS failures and private addresses stop the scan", async () => {
    const closed: ScanNet = { lookup: loopback, httpsPort: 1, httpPort: 1, ca: [lab.root], request: (url, o) => safeRequest(url, { ...o, lookup: loopback }) };
    const r = await runSiteScan("down.test", "passive", closed, null, {});
    expect(r.grade).toBeNull();
    expect(r.gradeNote).toMatch(/couldn't be reached/);
    expect(byId(r)["tls.reachable"].status).toBe("inconclusive");
    expect(byId(r)["dns.records"].status).toBe("untested");

    const nx = ((_h: string, _o: unknown, cb: (e: Error) => void) => cb(Object.assign(new Error("getaddrinfo ENOTFOUND nope.test"), { code: "ENOTFOUND" }))) as unknown as LookupFunction;
    await expect(runSiteScan("nope.test", "passive", { ...closed, lookup: nx }, null)).rejects.toBeInstanceOf(ScanAbort);
    const priv = ((_h: string, _o: unknown, cb: (e: Error) => void) => cb(new Error("x.test resolves to a private or reserved address"))) as unknown as LookupFunction;
    await expect(runSiteScan("x.test", "passive", { ...closed, lookup: priv }, null)).rejects.toMatchObject({ kind: "blocked" });
  }, 60_000);
});
