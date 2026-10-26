import "server-only";
import { checkServerIdentity, connect, type PeerCertificate, type TLSSocket } from "node:tls";
import type { LookupFunction } from "node:net";

/**
 * One TLS handshake with a website, through Node's TLS stack (OpenSSL), and what it showed. Every connection goes
 * through the caller's lookup (in production the scanner's guarded lookup, so a hostname can't be pointed at a
 * private address), sends SNI, and is closed right after the handshake: no application data is sent.
 *
 * Probes for legacy protocols and weak ciphers use OpenSSL security level 0, so Orbis can see what a server
 * accepts; that never changes how Orbis itself connects anywhere else.
 */

export interface TlsTarget {
  host: string;
  port: number;
  lookup: LookupFunction;
  /** Tests only: trust these roots instead of Node's built-in store (production never sets it). */
  ca?: (string | Buffer)[];
}

export type TlsVersion = "TLSv1" | "TLSv1.1" | "TLSv1.2" | "TLSv1.3";

export interface HandshakeOptions {
  minVersion?: TlsVersion;
  maxVersion?: TlsVersion;
  /** OpenSSL cipher list for TLS ≤ 1.2. */
  ciphers?: string;
  /** TLS 1.3 suites. */
  ciphersuites?: string;
  /** Allow legacy protocols, small keys and weak ciphers on this one connection (to observe them). */
  legacy?: boolean;
  alpn?: string[];
  ocsp?: boolean;
  /** Try one client-initiated renegotiation after the handshake (TLS 1.2 and below). */
  renegotiate?: boolean;
  timeoutMs?: number;
}

export interface ChainCert {
  der: Buffer;
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  bits: number | null;
  curve: string | null;
  fingerprint256: string;
}

export interface HandshakeResult {
  ok: boolean;
  /** OpenSSL / Node error code and message when the handshake failed. */
  error: { code: string; message: string } | null;
  address: string | null;
  protocol: string | null;
  cipher: { name: string; standardName: string } | null;
  alpn: string | null;
  authorized: boolean;
  authError: string | null;
  /** Hostname check against the leaf (null = matches). */
  hostnameError: string | null;
  chain: ChainCert[];
  ocspStapled: boolean;
  ephemeral: { type: string; name: string | null; size: number | null } | null;
  renegotiation: "allowed" | "refused" | "not-applicable" | null;
  ms: number;
}

const LEGACY_CIPHERS = "ALL:COMPLEMENTOFALL:@SECLEVEL=0";

const dn = (o: Record<string, string | string[] | undefined> | undefined) =>
  o
    ? Object.entries(o)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("+") : v}`)
        .join(", ")
    : "";

/** The certificates the server presented, leaf first (Node links each to its issuer; a self-signed root links to itself). */
function chainOf(s: TLSSocket): ChainCert[] {
  const out: ChainCert[] = [];
  let c = s.getPeerCertificate(true) as (PeerCertificate & { issuerCertificate?: PeerCertificate; bits?: number; asn1Curve?: string; nistCurve?: string }) | null;
  const seen = new Set<string>();
  while (c && c.raw && !seen.has(c.fingerprint256) && out.length < 8) {
    seen.add(c.fingerprint256);
    out.push({
      der: c.raw,
      subject: dn(c.subject as unknown as Record<string, string>),
      issuer: dn(c.issuer as unknown as Record<string, string>),
      validFrom: c.valid_from,
      validTo: c.valid_to,
      bits: typeof c.bits === "number" ? c.bits : null,
      curve: c.nistCurve ?? c.asn1Curve ?? null,
      fingerprint256: c.fingerprint256,
    });
    c = (c.issuerCertificate ?? null) as typeof c;
  }
  return out;
}

export function handshake(t: TlsTarget, o: HandshakeOptions = {}): Promise<HandshakeResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    let stapled = false;
    let renegotiating: Partial<HandshakeResult> | null = null;
    let socket: TLSSocket;
    const result = (partial: Partial<HandshakeResult>): HandshakeResult => ({
      ok: false,
      error: null,
      address: null,
      protocol: null,
      cipher: null,
      alpn: null,
      authorized: false,
      authError: null,
      hostnameError: null,
      chain: [],
      ocspStapled: stapled,
      ephemeral: null,
      renegotiation: null,
      ms: Date.now() - started,
      ...partial,
    });
    const finish = (r: HandshakeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => finish(result({ error: { code: "ETIMEDOUT", message: "The TLS handshake timed out." } })), o.timeoutMs ?? 8000);
    try {
      socket = connect({
        host: t.host,
        port: t.port,
        servername: t.host,
        lookup: t.lookup,
        rejectUnauthorized: false,
        // Chain trust only: the hostname is checked separately (Node would otherwise fold it into "authorized").
        checkServerIdentity: () => undefined,
        ...(t.ca ? { ca: t.ca } : {}),
        minVersion: o.minVersion ?? (o.legacy ? "TLSv1" : undefined),
        maxVersion: o.maxVersion,
        ciphers: o.ciphers ?? (o.legacy ? LEGACY_CIPHERS : undefined),
        ...(o.ciphersuites ? { ciphersuites: o.ciphersuites } : {}),
        ALPNProtocols: o.alpn,
        // Node supports requestOCSP on tls.connect; @types/node only lists it for TLSSocket.
        ...({ requestOCSP: o.ocsp ?? false } as object),
      });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      return finish(result({ error: { code: err.code ?? "ERR", message: err.message } }));
    }
    socket.on("OCSPResponse", (r: Buffer) => {
      if (r && r.length) stapled = true;
    });
    socket.on("error", (e: NodeJS.ErrnoException) => {
      // A server refusing renegotiation answers with an alert after a good handshake: that's the answer, not a failure.
      if (renegotiating) return finish(result({ ...renegotiating, ocspStapled: stapled, renegotiation: "refused" }));
      finish(result({ error: { code: e.code ?? "ERR", message: e.message.slice(0, 300) }, address: socket.remoteAddress ?? null }));
    });
    socket.once("secureConnect", () => {
      const cipher = socket.getCipher();
      const leaf = socket.getPeerCertificate();
      const ident = leaf && leaf.raw ? checkServerIdentity(t.host, leaf) : new Error("No certificate");
      const eph = socket.getEphemeralKeyInfo() as { type?: string; name?: string; size?: number } | null;
      const base: Partial<HandshakeResult> = {
        ok: true,
        address: socket.remoteAddress ?? null,
        protocol: socket.getProtocol(),
        cipher: cipher ? { name: cipher.name, standardName: cipher.standardName ?? cipher.name } : null,
        alpn: typeof socket.alpnProtocol === "string" ? socket.alpnProtocol : null,
        authorized: socket.authorized,
        authError: socket.authorizationError ? String(socket.authorizationError) : null,
        hostnameError: ident ? ident.message.slice(0, 300) : null,
        chain: chainOf(socket),
        // TLS 1.3 key exchange is always ephemeral; Node doesn't report its details.
        ephemeral: eph && eph.type ? { type: eph.type, name: eph.name ?? null, size: eph.size ?? null } : socket.getProtocol() === "TLSv1.3" ? { type: "TLS1.3", name: null, size: null } : null,
      };
      // Let a stapled OCSP response arrive (it comes with the handshake), then optionally try renegotiation.
      setImmediate(() => {
        if (!o.renegotiate) return finish(result({ ...base, ocspStapled: stapled }));
        if (socket.getProtocol() === "TLSv1.3") return finish(result({ ...base, ocspStapled: stapled, renegotiation: "not-applicable" }));
        renegotiating = base;
        const ok = socket.renegotiate({ rejectUnauthorized: false }, (err) => finish(result({ ...base, ocspStapled: stapled, renegotiation: err ? "refused" : "allowed" })));
        if (!ok) finish(result({ ...base, ocspStapled: stapled, renegotiation: "refused" }));
        // A server that ignores the request: count it as refused after a short wait.
        setTimeout(() => finish(result({ ...base, ocspStapled: stapled, renegotiation: "refused" })), 3000);
      });
    });
  });
}

/** Run probes a few at a time (never more than `limit` handshakes in flight to one host). */
export async function boundedAll<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
