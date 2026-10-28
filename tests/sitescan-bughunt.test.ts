/**
 * Website scan regressions from the 2026-10-27 bug hunt: findings for checks that only ever report problems are
 * cleared once their group is re-checked, SPF and DMARC are looked up on the registrable domain (not co.uk), SPF's
 * catch-all is read as a whole term, and several CSP policies are judged together.
 */
import { describe, expect, it } from "vitest";
import { registrableDomain, spfAll } from "@/lib/security/sitescan/dns";
import { analyseHeaders, type HttpResponse } from "@/lib/security/sitescan/http-analysis";
import { clearedRules } from "@/lib/security/sitescan/report";
import { check, type CheckResult, type ScanReport } from "@/lib/security/sitescan/types";

const res = (headers: Record<string, string | string[]>): HttpResponse => ({ url: "https://site.test/", status: 200, headers, body: "", truncated: false });
const csp = (v: string | string[]) => analyseHeaders(res({ "content-security-policy": v })).find((c) => c.id === "headers.csp")!;
const report = (checks: CheckResult[]) => ({ checks }) as unknown as ScanReport;
const c = (id: string, status: CheckResult["status"]) => check({ id, category: id.split(".")[0] as CheckResult["category"], title: id, status, severity: "low", summary: "" });

describe("clearing earlier findings", () => {
  it("clears a whole group that was evaluated, so a fixed exposed .env stops showing as detected", () => {
    const cleared = clearedRules(report([c("exposure.files", "passed"), c("headers.csp", "passed"), c("headers.hsts", "failed")]));
    expect(cleared).toContain("sitescan.exposure.");
    expect(cleared).toContain("sitescan.headers.");
    expect("sitescan.exposure.env-file".startsWith("sitescan.exposure.")).toBe(true);
  });
  it("clears only what passed in a group that wasn't fully evaluated", () => {
    const cleared = clearedRules(report([c("exposure.files", "skipped"), c("cert.chain", "passed"), c("cert.ocsp", "inconclusive")]));
    expect(cleared).not.toContain("sitescan.exposure.");
    expect(cleared).not.toContain("sitescan.cert.");
    expect(cleared).toContain("sitescan.cert.chain");
  });
});

describe("email DNS records", () => {
  it("uses the registrable domain under multi-label suffixes", () => {
    expect(registrableDomain("www.example.com")).toBe("example.com");
    expect(registrableDomain("shop.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("example.com.au")).toBe("example.com.au");
    expect(registrableDomain("me.github.io")).toBe("me.github.io");
  });
  it("reads SPF's catch-all as a whole term", () => {
    expect(spfAll("v=spf1 include:spf.firewall.io -all")).toBe("-");
    expect(spfAll("v=spf1 include:spf.firewall.io")).toBeNull();
    expect(spfAll("v=spf1 a mx ~all")).toBe("~");
    expect(spfAll("v=spf1 all")).toBe("+");
    expect(spfAll("v=spf1 redirect=_spf.example.com")).toBe("redirect");
  });
});

describe("Content-Security-Policy with several policies", () => {
  it("passes when one policy restricts scripts and another restricts frames", () => {
    expect(csp("frame-ancestors 'self', script-src 'self'; object-src 'none'").status).toBe("passed");
    expect(csp(["frame-ancestors 'self'", "script-src 'self'; object-src 'none'"]).status).toBe("passed");
  });
  it("still warns when every script policy is weak", () => {
    expect(csp("script-src 'self' 'unsafe-inline'; object-src 'none', default-src * 'unsafe-inline'").status).toBe("warning");
    expect(csp("frame-ancestors 'self'").summary).toMatch(/no script-src or default-src/);
  });
});
