import type { LookupFunction } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handshake } from "@/lib/security/sitescan/tls-probe";
import { hasOpenssl, makeLab, presets, serveTls, type Lab, type LabServer } from "./helpers/tls-lab";

// Every lab hostname resolves to the loopback server (only in tests; production uses the guarded lookup).
const loopback = ((_h: string, o: { all?: boolean }, cb: (e: null, a: unknown, f?: number) => void) =>
  o?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4)) as unknown as LookupFunction;

describe.skipIf(!hasOpenssl())("TLS probe against controlled servers", () => {
  let lab: Lab;
  const servers: Record<string, LabServer> = {};
  const target = (name: string, host: string) => ({ host, port: servers[name].port, lookup: loopback, ca: [lab.root] });

  beforeAll(async () => {
    lab = makeLab();
    const p = presets(lab);
    for (const [k, v] of Object.entries(p)) servers[k] = await serveTls(v);
  }, 60_000);
  afterAll(async () => {
    await Promise.all(Object.values(servers).map((s) => s.close()));
  });

  it("reads a modern server: TLS 1.3, trusted chain, hostname match, forward secrecy, ALPN", async () => {
    const r = await handshake(target("good", "good.test"), { alpn: ["h2", "http/1.1"] });
    expect(r.ok).toBe(true);
    expect(r.protocol).toBe("TLSv1.3");
    expect(r.authorized).toBe(true);
    expect(r.hostnameError).toBeNull();
    expect(r.chain.map((c) => c.subject)).toEqual(["CN=good.test", "CN=Orbis Test Intermediate", "CN=Orbis Test Root CA"]);
    expect(r.ephemeral?.type).toBe("TLS1.3");
    expect(r.alpn).toBe("http/1.1");
    const r12 = await handshake(target("good", "good.test"), { maxVersion: "TLSv1.2" });
    expect(r12.protocol).toBe("TLSv1.2");
    expect(r12.ephemeral).toMatchObject({ type: "ECDH", name: "X25519" });
  });

  it("sees which protocol versions are accepted", async () => {
    const at = (name: string, v: "TLSv1" | "TLSv1.1" | "TLSv1.2" | "TLSv1.3") => handshake(target(name, "good.test"), { minVersion: v, maxVersion: v, legacy: true });
    expect((await at("legacy", "TLSv1")).ok).toBe(true);
    expect((await at("legacy", "TLSv1.1")).ok).toBe(true);
    expect((await at("good", "TLSv1")).ok).toBe(false);
    expect((await at("good", "TLSv1.1")).ok).toBe(false);
    expect((await at("good", "TLSv1.2")).ok).toBe(true);
    expect((await at("tls13only", "TLSv1.2")).ok).toBe(false);
    expect((await at("tls13only", "TLSv1.3")).ok).toBe(true);
  });

  it("can tell an RSA key exchange, a NULL cipher and 1024-bit DH apart", async () => {
    const rsa = await handshake(target("legacy", "good.test"), { maxVersion: "TLSv1.2", ciphers: "AES128-SHA:@SECLEVEL=0", legacy: true });
    expect(rsa.ok && rsa.cipher?.name).toBe("AES128-SHA");
    expect(rsa.ephemeral).toBeNull();
    const nul = await handshake(target("legacy", "good.test"), { maxVersion: "TLSv1.2", ciphers: "eNULL:@SECLEVEL=0", legacy: true });
    expect(nul.ok).toBe(true);
    expect(nul.cipher?.name).toMatch(/NULL/);
    const dhe = await handshake(target("legacy", "good.test"), { maxVersion: "TLSv1.2", ciphers: "DHE-RSA-AES128-SHA:@SECLEVEL=0", legacy: true });
    expect(dhe.ephemeral).toMatchObject({ type: "DH", size: 1024 });
    const goodNull = await handshake(target("good", "good.test"), { maxVersion: "TLSv1.2", ciphers: "eNULL:@SECLEVEL=0", legacy: true });
    expect(goodNull.ok).toBe(false);
  });

  it("reports untrusted, expired, self-signed, missing-intermediate and wrong-host certificates", async () => {
    expect((await handshake(target("expired", "expired.test"))).authError).toBe("CERT_HAS_EXPIRED");
    expect((await handshake(target("self", "self.test"))).authError).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
    expect((await handshake(target("noIntermediate", "good.test"))).authError).toBe("UNABLE_TO_VERIFY_LEAF_SIGNATURE");
    const wrong = await handshake(target("good", "other.test"));
    expect(wrong.authorized).toBe(true);
    expect(wrong.hostnameError).toMatch(/other\.test/);
    const weak = await handshake(target("weak", "weak.test"), { legacy: true });
    expect(weak.chain[0].bits).toBe(1024);
  });

  it("tries one client-initiated renegotiation", async () => {
    expect((await handshake(target("legacy", "good.test"), { maxVersion: "TLSv1.2", renegotiate: true })).renegotiation).toBe("allowed");
    expect((await handshake(target("good", "good.test"), { maxVersion: "TLSv1.2", renegotiate: true })).renegotiation).toBe("refused");
    expect((await handshake(target("good", "good.test"), { renegotiate: true })).renegotiation).toBe("not-applicable");
  });

  it("times out and reports connection errors instead of hanging", async () => {
    const r = await handshake({ host: "good.test", port: 1, lookup: loopback });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toMatch(/ECONNREFUSED/);
  });
});
