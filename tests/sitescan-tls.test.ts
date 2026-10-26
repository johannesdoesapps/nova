import type { LookupFunction } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanTls } from "@/lib/security/sitescan/tls-scan";
import { analyseCertificate, analyseTls, classifyCipher } from "@/lib/security/sitescan/tls-analysis";
import type { CheckResult } from "@/lib/security/sitescan/types";
import { hasOpenssl, makeLab, presets, serveTls, type Lab, type LabServer } from "./helpers/tls-lab";

const loopback = ((_h: string, o: { all?: boolean }, cb: (e: null, a: unknown, f?: number) => void) =>
  o?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4)) as unknown as LookupFunction;

const byId = (checks: CheckResult[]) => Object.fromEntries(checks.map((c) => [c.id, c]));

describe("classifyCipher", () => {
  it("grades suites by key exchange, cipher and mode", () => {
    expect(classifyCipher("TLS_AES_128_GCM_SHA256", "TLSv1.3")).toMatchObject({ strength: "strong", forwardSecrecy: true });
    expect(classifyCipher("ECDHE-RSA-AES128-GCM-SHA256", "TLSv1.2")).toMatchObject({ strength: "strong", forwardSecrecy: true });
    expect(classifyCipher("ECDHE-RSA-AES128-SHA", "TLSv1.2")).toMatchObject({ strength: "acceptable", forwardSecrecy: true });
    expect(classifyCipher("AES128-GCM-SHA256", "TLSv1.2")).toMatchObject({ strength: "weak", forwardSecrecy: false });
    expect(classifyCipher("DES-CBC3-SHA", "TLSv1.2").strength).toBe("weak");
    expect(classifyCipher("NULL-SHA256", "TLSv1.2")).toMatchObject({ strength: "insecure", why: "no encryption" });
    expect(classifyCipher("ADH-AES128-SHA", "TLSv1.2")).toMatchObject({ strength: "insecure", why: "no authentication (anonymous)" });
    expect(classifyCipher("RC4-SHA", "TLSv1.0").strength).toBe("insecure");
  });
});

describe.skipIf(!hasOpenssl())("TLS scan against controlled servers", () => {
  let lab: Lab;
  const servers: Record<string, LabServer> = {};
  const scan = async (name: string, host: string) => {
    const r = await scanTls({ host, port: servers[name].port, lookup: loopback, ca: [lab.root] }, { concurrency: 3 });
    const tls = byId(analyseTls(r.evidence));
    const cert = analyseCertificate({ host, chain: r.main.chain.map((c) => c.der), authorized: r.main.authorized, authError: r.main.authError, hostnameError: r.main.hostnameError, ocspStapled: r.main.ocspStapled, now: new Date() });
    return { r, tls, cert: byId(cert.checks), summary: cert.summary };
  };

  beforeAll(async () => {
    lab = makeLab();
    const p = presets(lab);
    for (const [k, v] of Object.entries(p)) servers[k] = await serveTls(v);
  }, 60_000);
  afterAll(async () => {
    await Promise.all(Object.values(servers).map((s) => s.close()));
  });

  it("a modern server passes the protocol, cipher and certificate checks", async () => {
    const { r, tls, cert, summary } = await scan("good", "good.test");
    expect(r.evidence.protocols).toEqual({ "TLSv1.3": "supported", "TLSv1.2": "supported", "TLSv1.1": "not supported", TLSv1: "not supported" });
    expect(tls["tls.modern-client"].status).toBe("passed");
    expect(tls["tls.legacy-protocols"].status).toBe("passed");
    expect(tls["tls.tls13"].status).toBe("passed");
    expect(tls["tls.ciphers-insecure"].status).toBe("passed");
    expect(r.evidence.ciphersComplete).toBe(true);
    expect(r.evidence.ciphers.filter((c) => c.protocol === "TLSv1.3").map((c) => c.name)).toEqual(expect.arrayContaining(["TLS_AES_256_GCM_SHA384", "TLS_AES_128_GCM_SHA256", "TLS_CHACHA20_POLY1305_SHA256"]));
    expect(tls["tls.client-renegotiation"].status).toBe("passed");
    expect(tls["tls.secure-renegotiation"]).toMatchObject({ status: "passed", confirmed: false });
    expect(tls["tls.ssl"].status).toBe("untested");
    expect(tls["tls.vuln-untested"].status).toBe("untested");
    expect(cert["cert.trusted"].status).toBe("passed");
    expect(cert["cert.hostname"].status).toBe("passed");
    expect(cert["cert.expiry"].status).toBe("passed");
    expect(cert["cert.key"].status).toBe("passed");
    expect(cert["cert.signature"].status).toBe("passed");
    expect(cert["cert.chain-order"].status).toBe("passed");
    // Issued for 390 days, within the 398-day limit for public certificates.
    expect(cert["cert.lifetime"]).toBeUndefined();
    expect(summary?.chain).toHaveLength(3);
    expect(r.handshakes).toBeLessThanOrEqual(60);
  });

  it("a legacy server: TLS 1.0/1.1, NULL and anonymous suites, RSA key exchange, 1024-bit DH, renegotiation", async () => {
    const { r, tls } = await scan("legacy", "good.test");
    expect(r.evidence.protocols.TLSv1).toBe("supported");
    expect(r.evidence.protocols["TLSv1.1"]).toBe("supported");
    expect(tls["tls.legacy-protocols"]).toMatchObject({ status: "failed", severity: "medium" });
    expect(tls["tls.ciphers-insecure"].status).toBe("failed");
    expect(tls["tls.ciphers-insecure"].summary).toMatch(/NULL/);
    expect(tls["tls.ciphers-insecure"].summary).toMatch(/ADH|AECDH/);
    expect(tls["tls.ciphers-weak"].status).toBe("warning");
    expect(tls["tls.dh-strength"]).toMatchObject({ status: "failed" });
    expect(tls["tls.dh-strength"].summary).toMatch(/1024-bit/);
    expect(tls["tls.client-renegotiation"].status).toBe("warning");
    expect(tls["tls.beast"]?.status).toBe("warning");
    expect(r.evidence.ciphers.length).toBeGreaterThan(10);
  }, 120_000);

  it("a TLS 1.3-only server has nothing older to offer", async () => {
    const { r, tls } = await scan("tls13only", "good.test");
    expect(r.evidence.protocols).toMatchObject({ "TLSv1.3": "supported", "TLSv1.2": "not supported" });
    expect(tls["tls.client-renegotiation"].status).toBe("info");
    expect(tls["tls.secure-renegotiation"]).toBeUndefined();
    expect(tls["tls.forward-secrecy"].status).toBe("passed");
  });

  it("flags expired, self-signed, incomplete-chain and wrong-host certificates", async () => {
    const expired = await scan("expired", "expired.test");
    expect(expired.cert["cert.trusted"]).toMatchObject({ status: "failed", severity: "critical" });
    expect(expired.cert["cert.expiry"]).toMatchObject({ status: "failed", severity: "critical" });
    expect(expired.cert["cert.expiry"].summary).toMatch(/^Expired \d+ days ago \(2021-01-01\)/);
    const self = await scan("self", "self.test");
    expect(self.cert["cert.trusted"].summary).toMatch(/self-signed/);
    const noInt = await scan("noIntermediate", "good.test");
    expect(noInt.cert["cert.trusted"]).toMatchObject({ status: "failed", severity: "high" });
    expect(noInt.cert["cert.trusted"].remediation).toMatch(/full chain/);
    const wrong = await scan("good", "other.test");
    expect(wrong.cert["cert.trusted"].status).toBe("passed");
    expect(wrong.cert["cert.hostname"]).toMatchObject({ status: "failed", severity: "critical" });
  });

  it("flags a soon-expiring certificate, a 1024-bit key and a SHA-1 signature, and reads EC keys", async () => {
    const soon = await scan("soon", "soon.test");
    expect(soon.cert["cert.expiry"]).toMatchObject({ status: "warning", severity: "medium" });
    expect(soon.summary?.daysLeft).toBeGreaterThanOrEqual(8);
    const weak = await scan("weak", "weak.test");
    expect(weak.cert["cert.key"]).toMatchObject({ status: "failed", severity: "high" });
    expect(weak.cert["cert.key"].summary).toMatch(/RSA 1024 bits/);
    const sha1 = await scan("sha1", "sha1.test");
    expect(sha1.cert["cert.signature"]).toMatchObject({ status: "failed" });
    expect(sha1.cert["cert.signature"].summary).toMatch(/sha1WithRSAEncryption/);
    // The other lab leaves are issued for 3000 days, longer than public CAs may issue.
    expect(weak.cert["cert.lifetime"]).toMatchObject({ status: "warning", severity: "low" });
    const ec = await scan("ec", "ec.test");
    expect(ec.summary?.key).toBe("EC prime256v1");
    expect(ec.cert["cert.key"].status).toBe("passed");
  });

  it("reports an unreachable port without guessing", async () => {
    const r = await scanTls({ host: "good.test", port: 1, lookup: loopback });
    expect(r.evidence.reachable).toBe(false);
    expect(r.handshakes).toBe(1);
    expect(r.notes[0]).toMatch(/ECONNREFUSED/);
  });
});
