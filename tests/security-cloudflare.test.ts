/**
 * Security Team stage 5: Cloudflare Application Protection — findings from real settings, areas the token can't read
 * reported as not checked (never as secure), Access policies reviewed but never changed, token verification, and the
 * short, reversible list of changes Orbis may apply after approval.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { accessFindings, CF_CHANGES, coverageGaps, readZone, zoneFindings, type ZoneInfo, type ZoneSnapshot } from "@/lib/security/cloudflare-audit";
import { CF_TOKEN_RE, verifyToken } from "@/lib/connectors/providers/cloudflare";

const zone: ZoneInfo = { id: "z1", name: "shop.com", status: "active", paused: false, plan: "Pro Website", accountId: "acc1", accountName: "Acme" };
const allChecked = () => Object.fromEntries(["tls", "waf", "ratelimit", "ddos", "bot", "dns", "access", "events"].map((a) => [a, { status: "checked", detail: "" }])) as ZoneSnapshot["coverage"];
const snap = (over: Partial<ZoneSnapshot> = {}): ZoneSnapshot => ({
  zone,
  settings: { ssl: "strict", always_use_https: "on", min_tls_version: "1.2", security_header: { strict_transport_security: { enabled: true } } },
  phases: { http_request_firewall_managed: [{ action: "execute", enabled: true, description: "", expression: "true", executes: "efb7b8c949ac4650a09736fc376e9aee", overrides: null }], http_request_firewall_custom: null, http_ratelimit: [{ action: "block", enabled: true, description: "login", expression: "", executes: null, overrides: null }], ddos_l7: null },
  bot: { fightMode: true, definitelyAutomated: null, aiBotsProtection: null },
  dns: [{ name: "shop.com", type: "A", content: "34.120.54.10", proxied: true }],
  events: [],
  coverage: allChecked(),
  ...over,
});
const ids = (s: ZoneSnapshot) => zoneFindings(s).map((f) => f.ruleId);

describe("zone findings", () => {
  it("finds nothing on a well-configured zone", () => {
    expect(ids(snap())).toEqual([]);
  });

  it("reports weak TLS settings with the right confidence", () => {
    const fs = zoneFindings(snap({ settings: { ssl: "flexible", always_use_https: "off", min_tls_version: "1.0", security_header: { strict_transport_security: { enabled: false } } } }));
    expect(fs.map((f) => [f.ruleId, f.severity, f.confidence])).toEqual([
      ["cloudflare.tls.ssl-flexible", "high", "confirmed"],
      ["cloudflare.tls.http-allowed", "medium", "firm"],
      ["cloudflare.tls.min-tls-old", "low", "confirmed"],
      ["cloudflare.tls.hsts-off", "low", "tentative"],
    ]);
    expect(fs[0]).toMatchObject({ agent: "sentinel", asset: "cloudflare:shop.com", evidenceSource: "cloudflare:api" });
  });

  it("reports missing or log-only managed WAF, missing rate limits, weakened DDoS and bots off", () => {
    expect(ids(snap({ phases: { http_request_firewall_managed: null, http_ratelimit: null, ddos_l7: [{ action: "execute", enabled: true, description: "HTTP DDoS", expression: "true", executes: "x", overrides: { action: "log" } }] }, bot: { fightMode: false, definitelyAutomated: null, aiBotsProtection: null } }))).toEqual([
      "cloudflare.waf.managed-off",
      "cloudflare.ratelimit.none",
      "cloudflare.ddos.l7-weakened",
      "cloudflare.bot.off",
    ]);
    expect(ids(snap({ phases: { http_request_firewall_managed: [{ action: "execute", enabled: true, description: "", expression: "true", executes: "efb7b8c949ac4650a09736fc376e9aee", overrides: { action: "log" } }], http_ratelimit: [{ action: "block", enabled: true, description: "", expression: "", executes: null, overrides: null }] } }))).toEqual(["cloudflare.waf.managed-log-only"]);
  });

  it("confirms origin exposure only when a DNS-only record shares a proxied address; ignores mail and private addresses", () => {
    const fs = zoneFindings(
      snap({
        dns: [
          { name: "shop.com", type: "A", content: "34.120.54.10", proxied: true },
          { name: "direct.shop.com", type: "A", content: "34.120.54.10", proxied: false },
          { name: "mail.shop.com", type: "A", content: "34.120.54.10", proxied: false },
          { name: "legacy.shop.com", type: "A", content: "52.14.7.21", proxied: false },
          { name: "internal.shop.com", type: "A", content: "10.0.0.5", proxied: false },
        ],
      }),
    );
    expect(fs.map((f) => [f.ruleId, f.confidence])).toEqual([
      ["cloudflare.dns.origin-exposed", "confirmed"],
      ["cloudflare.dns.unproxied", "tentative"],
    ]);
    expect(fs[1]!.description).toContain("legacy.shop.com");
    expect(fs[1]!.description).not.toContain("internal.shop.com");
  });

  it("says nothing about areas it couldn't read", () => {
    const s = snap({ settings: null, phases: {}, bot: null, dns: null });
    expect(ids(s)).toEqual([]);
  });

  it("flags a paused zone", () => {
    expect(ids(snap({ zone: { ...zone, paused: true } }))).toEqual(["cloudflare.tls.zone-paused"]);
  });
});

describe("reading a zone", () => {
  it("marks areas the token can't read as missing permission and names the permission to add", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes("/settings")) return new Response(JSON.stringify({ success: true, result: [{ id: "ssl", value: "full" }] }));
      if (url.includes("http_request_firewall") || url.includes("http_ratelimit")) return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), { status: 403 });
      if (url.includes("ddos_l7")) return new Response(JSON.stringify({ success: false, errors: [{ code: 10003, message: "not found" }] }), { status: 404 });
      if (url.includes("bot_management")) return new Response(JSON.stringify({ success: true, result: { fight_mode: true } }));
      if (url.includes("dns_records")) return new Response(JSON.stringify({ success: true, result: [] }));
      if (url.includes("graphql")) return new Response(JSON.stringify({ data: null, errors: [{ message: "not authorized for that account" }] }));
      return new Response("{}", { status: 500 });
    }) as unknown as typeof fetch;
    const s = await readZone({ token: "t", fetch: fetchImpl }, zone);
    expect(s.coverage.tls.status).toBe("checked");
    expect(s.coverage.waf.status).toBe("missing_permission");
    expect(s.coverage.ratelimit.status).toBe("missing_permission");
    expect(s.coverage.ddos).toMatchObject({ status: "checked", detail: expect.stringMatching(/default/) });
    expect(s.coverage.events.status).toBe("missing_permission");
    expect(s.phases.http_request_firewall_managed).toBeUndefined();
    expect(zoneFindings(s).map((f) => f.ruleId)).toEqual(["cloudflare.tls.ssl-full-unvalidated"]);
    expect(coverageGaps(s.coverage).filter((g) => g.area !== "access")).toEqual([
      { area: "waf", status: "missing_permission", fix: "Zone WAF: Read" },
      { area: "ratelimit", status: "missing_permission", fix: "Zone WAF: Read" },
      { area: "events", status: "missing_permission", fix: "Analytics: Read" },
    ]);
  });
});

describe("Zero Trust Access", () => {
  it("flags allow/bypass-everyone as high and missing MFA as a lead, and never offers to change policies", () => {
    const fs = accessFindings("Acme", [
      { id: "a1", name: "Admin", domain: "admin.shop.com", type: "self_hosted", policies: [{ name: "all", decision: "bypass", everyone: true, mfa: false, include: ["everyone"] }] },
      { id: "a2", name: "Wiki", domain: "wiki.shop.com", type: "self_hosted", policies: [{ name: "staff", decision: "allow", everyone: false, mfa: false, include: ["email_domain"] }] },
      { id: "a3", name: "Grafana", domain: "g.shop.com", type: "self_hosted", policies: [{ name: "staff", decision: "allow", everyone: false, mfa: true, include: ["group"] }] },
    ]);
    expect(fs.map((f) => [f.ruleId, f.severity, f.confidence])).toEqual([
      ["cloudflare.access.everyone", "high", "confirmed"],
      ["cloudflare.access.no-mfa", "medium", "tentative"],
    ]);
    expect(fs[0]!.remediation).toMatch(/doesn't change Access policies/);
    expect(Object.keys(CF_CHANGES).some((k) => k.startsWith("cloudflare.access."))).toBe(false);
  });
});

describe("approved changes", () => {
  it("are limited to three reversible zone settings, each with its impact stated", () => {
    expect(new Set(Object.values(CF_CHANGES).map((c) => c.setting))).toEqual(new Set(["ssl", "always_use_https", "min_tls_version"]));
    for (const c of Object.values(CF_CHANGES)) {
      expect(c.impact.length).toBeGreaterThan(40);
      expect(c.from).not.toContain(c.value);
    }
    expect(Object.keys(CF_CHANGES).some((k) => /dns|waf|ddos|bot/.test(k))).toBe(false);
  });
});

describe("Cloudflare token", () => {
  it("accepts token-shaped values only", () => {
    expect(CF_TOKEN_RE.test("a".repeat(40))).toBe(true);
    expect(CF_TOKEN_RE.test("my token")).toBe(false);
    expect(CF_TOKEN_RE.test("short")).toBe(false);
  });

  it("verifies user tokens, accepts account tokens that can read zones, and rejects bad ones", async () => {
    const mk = (verify: number, zones: number) =>
      (async (url: string) =>
        url.includes("/user/tokens/verify")
          ? new Response(JSON.stringify(verify === 200 ? { success: true, result: { status: "active", expires_on: "2027-01-01T00:00:00Z" } } : { success: false }), { status: verify })
          : new Response(JSON.stringify(zones === 200 ? { success: true, result: [{}], result_info: { total_count: 3 } } : { success: false }), { status: zones })) as unknown as typeof fetch;
    expect(await verifyToken({ token: "t", fetch: mk(200, 200) })).toEqual({ status: "active", expiresOn: "2027-01-01T00:00:00Z", zones: 3 });
    expect(await verifyToken({ token: "t", fetch: mk(401, 200) })).toMatchObject({ zones: 3 });
    expect(await verifyToken({ token: "t", fetch: mk(200, 403) })).toMatchObject({ zones: null });
    await expect(verifyToken({ token: "t", fetch: mk(401, 401) })).rejects.toThrow(/didn't accept this token/);
    await expect(verifyToken({ token: "t", fetch: mk(400, 400) })).rejects.toThrow(/didn't accept this token/);
  });
});
