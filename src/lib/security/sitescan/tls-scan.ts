import "server-only";
import { boundedAll, handshake, type HandshakeOptions, type HandshakeResult, type TlsTarget, type TlsVersion } from "./tls-probe";
import type { CipherSeen, ProtocolState, TlsEvidence } from "./tls-analysis";

/**
 * The TLS part of a scan: a handful of ordinary handshakes (never more than `maxHandshakes`, at most `concurrency`
 * at once, inside a time budget) to learn which protocol versions and cipher suites a server accepts, what
 * certificate it presents and whether it allows renegotiation. No application data is sent.
 */

export interface TlsScanOptions {
  signal?: AbortSignal;
  progress?: (text: string) => void;
  maxHandshakes?: number;
  concurrency?: number;
  /** Stop starting new handshakes after this long (the scan reports what's left as incomplete). */
  budgetMs?: number;
  timeoutMs?: number;
}

export interface TlsScanResult {
  /** The handshake whose certificate is analysed (the modern one, or a legacy one when modern clients can't connect). */
  main: HandshakeResult;
  evidence: TlsEvidence;
  handshakes: number;
  notes: string[];
}

/** Connection-level failures: the server (or something in front of it) never got to a TLS answer. */
const UNREACHABLE = /^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|ERR_SOCKET|BLOCKED)/;
const TLS13_SUITES = ["TLS_AES_256_GCM_SHA384", "TLS_CHACHA20_POLY1305_SHA256", "TLS_AES_128_GCM_SHA256", "TLS_AES_128_CCM_SHA256", "TLS_AES_128_CCM_8_SHA256"];
const VERSIONS: TlsVersion[] = ["TLSv1.3", "TLSv1.2", "TLSv1.1", "TLSv1"];
/** OpenSSL cipher-string categories offered on their own: no encryption, no authentication, RSA key exchange. */
const CATEGORY_PROBES = ["eNULL", "aNULL:!eNULL", "kRSA:!eNULL"];

const codeOf = (r: HandshakeResult) => (r.error?.code === "ERR" && /private or reserved/.test(r.error.message) ? "BLOCKED" : (r.error?.code ?? ""));

/** A failed version probe: a refusal (alert / reset) means "not supported"; a timeout or dropped connection is inconclusive. */
export function protocolState(r: HandshakeResult): ProtocolState {
  if (r.ok) return "supported";
  const code = codeOf(r);
  if (code === "ETIMEDOUT" || code === "ECONNREFUSED" || code === "BLOCKED") return "inconclusive";
  return "not supported";
}

export async function scanTls(t: TlsTarget, o: TlsScanOptions = {}): Promise<TlsScanResult> {
  const max = o.maxHandshakes ?? 90;
  const deadline = Date.now() + (o.budgetMs ?? 50_000);
  const progress = o.progress ?? (() => {});
  const notes: string[] = [];
  let count = 0;
  let cutShort = false;
  const go = async (opts: HandshakeOptions): Promise<HandshakeResult | null> => {
    if (o.signal?.aborted || count >= max || Date.now() > deadline) {
      cutShort = true;
      return null;
    }
    count++;
    return handshake(t, { timeoutMs: o.timeoutMs ?? 8000, ...opts });
  };

  progress("TLS handshake as a modern browser");
  let main = (await go({ alpn: ["h2", "http/1.1"], ocsp: true }))!;
  const modernError = main.ok ? null : `${main.error?.code ?? "error"}: ${main.error?.message ?? "handshake failed"}`;
  const empty: TlsEvidence = {
    reachable: false,
    modernError,
    negotiated: null,
    protocols: { "TLSv1.3": "untested", "TLSv1.2": "untested", "TLSv1.1": "untested", TLSv1: "untested" },
    ciphers: [],
    ciphersComplete: false,
    renegotiation: null,
    secureRenegotiation: null,
  };
  if (!main.ok && UNREACHABLE.test(codeOf(main))) return { main, evidence: empty, handshakes: count, notes: [`HTTPS (port ${t.port}) couldn't be reached: ${modernError}.`] };
  if (!main.ok) {
    // Modern clients fail; a legacy handshake still shows the certificate and what the server does accept.
    const legacy = await go({ legacy: true, ocsp: true });
    if (legacy?.ok) {
      main = legacy;
      notes.push("A modern client couldn't connect; the certificate shown comes from a legacy (TLS 1.0–1.2, weak cipher) handshake.");
    }
  }
  const negotiated = main.ok && main.protocol && main.cipher ? { protocol: main.protocol, cipher: main.cipher.standardName || main.cipher.name, forwardSecrecy: !!main.ephemeral, alpn: main.alpn } : null;

  progress("Checking which TLS versions are accepted");
  const versionResults = await boundedAll(VERSIONS, o.concurrency ?? 3, (v) => go({ minVersion: v, maxVersion: v, legacy: true }));
  const protocols = Object.fromEntries(VERSIONS.map((v, i) => [v, versionResults[i] ? protocolState(versionResults[i]!) : "untested"])) as TlsEvidence["protocols"];
  // OpenSSL 3 refuses TLS ≤ 1.2 servers that don't support RFC 5746; it says so explicitly.
  const unsafeReneg = /unsafe legacy renegotiation/i.test(modernError ?? "") || versionResults.some((r) => r && !r.ok && /unsafe legacy renegotiation/i.test(r.error?.message ?? ""));
  const legacyOk = versionResults.some((r, i) => r?.ok && VERSIONS[i] !== "TLSv1.3");

  // The cheap, important probes first (renegotiation, TLS 1.3 suites), then cipher listing with what's left of the budget.
  let renegotiation: TlsEvidence["renegotiation"] = null;
  if (protocols["TLSv1.2"] === "supported" || protocols["TLSv1.1"] === "supported" || protocols.TLSv1 === "supported") {
    progress("Trying one client-initiated renegotiation");
    const r = await go({ maxVersion: "TLSv1.2", legacy: true, renegotiate: true });
    renegotiation = r?.ok ? r.renegotiation : null;
  } else if (protocols["TLSv1.3"] === "supported") renegotiation = "not-applicable";

  const tls13: string[] = [];
  let complete = true;
  if (protocols["TLSv1.3"] === "supported") {
    progress("Listing TLS 1.3 cipher suites");
    const r13 = await boundedAll(TLS13_SUITES, o.concurrency ?? 3, (s) => go({ minVersion: "TLSv1.3", maxVersion: "TLSv1.3", ciphersuites: s }));
    r13.forEach((r, i) => {
      if (r?.ok) tls13.push(TLS13_SUITES[i]!);
      else if (!r || protocolState(r) === "inconclusive") complete = false;
    });
  }

  // Cipher suites. First, targeted probes for the dangerous categories (so they're found however long the list is),
  // then, per TLS ≤ 1.2 version, repeatedly offer everything except what was already accepted.
  const ciphers: CipherSeen[] = tls13.map((name) => ({ protocol: "TLSv1.3", name }));
  const add = (protocol: string, r: HandshakeResult) => {
    const name = r.cipher?.name;
    if (name && !ciphers.some((c) => c.protocol === protocol && c.name === name)) ciphers.push({ protocol, name, dhBits: r.ephemeral?.type === "DH" ? r.ephemeral.size : null });
  };
  const top = (["TLSv1.2", "TLSv1.1", "TLSv1"] as const).find((v) => protocols[v] === "supported");
  if (top) {
    progress("Probing for unencrypted, anonymous and non-forward-secret suites");
    const probes = await boundedAll(CATEGORY_PROBES, o.concurrency ?? 3, (c) => go({ minVersion: top, maxVersion: top, legacy: true, ciphers: `${c}:@SECLEVEL=0` }));
    probes.forEach((r) => r?.ok && add(top, r));
  }
  for (const v of ["TLSv1.2", "TLSv1.1", "TLSv1"] as const) {
    if (protocols[v] !== "supported") continue;
    progress(`Listing cipher suites for ${v === "TLSv1" ? "TLS 1.0" : v.replace("TLSv", "TLS ")}`);
    const seen: string[] = [];
    const limit = v === "TLSv1.2" ? 48 : 16;
    let finished = false;
    for (let i = 0; i < limit; i++) {
      const r = await go({ minVersion: v, maxVersion: v, legacy: true, ciphers: `ALL:COMPLEMENTOFALL${seen.map((c) => `:!${c}`).join("")}:@SECLEVEL=0` });
      if (!r) break;
      if (!r.ok) {
        // The server refused everything that's left: the list is complete (unless the refusal was a timeout).
        finished = protocolState(r) !== "inconclusive";
        break;
      }
      const name = r.cipher?.name;
      if (!name || seen.includes(name)) {
        finished = true;
        break;
      }
      seen.push(name);
      add(v, r);
    }
    if (!finished) {
      complete = false;
      notes.push(`${v === "TLSv1" ? "TLS 1.0" : v.replace("TLSv", "TLS ")} accepts more than ${seen.length} cipher suites; the list stops there (dangerous categories were probed separately).`);
    }
  }
  if (cutShort) notes.push(`The TLS checks stopped early (limit of ${max} handshakes or the time budget), so the cipher list may be incomplete.`);
  return {
    main,
    evidence: {
      reachable: true,
      modernError,
      negotiated,
      protocols,
      ciphers,
      ciphersComplete: complete && !cutShort,
      renegotiation,
      secureRenegotiation: unsafeReneg ? false : legacyOk ? true : null,
    },
    handshakes: count,
    notes,
  };
}
