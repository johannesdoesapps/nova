/**
 * Turning TLS evidence (from tls-probe handshakes) into checks. Pure functions: no network, so they can be tested
 * with recorded evidence. Certificates are parsed with Node's X509Certificate and @peculiar/asn1-x509 (for the
 * signature algorithm and extensions Node doesn't expose).
 */
import { X509Certificate } from "node:crypto";
import { AsnConvert } from "@peculiar/asn1-schema";
import { Certificate } from "@peculiar/asn1-x509";
import { check, type CertificateSummary, type CheckResult } from "./types";

const REF = {
  mozilla: "https://wiki.mozilla.org/Security/Server_Side_TLS",
  rfc8996: "https://www.rfc-editor.org/rfc/rfc8996",
  rfc5746: "https://www.rfc-editor.org/rfc/rfc5746",
  cabf: "https://cabforum.org/working-groups/server/baseline-requirements/",
  logjam: "https://weakdh.org/",
};

/* ------------------------------------------------------------------ certificates */

const SIG_OIDS: Record<string, string> = {
  "1.2.840.113549.1.1.4": "md5WithRSAEncryption",
  "1.2.840.113549.1.1.5": "sha1WithRSAEncryption",
  "1.2.840.113549.1.1.11": "sha256WithRSAEncryption",
  "1.2.840.113549.1.1.12": "sha384WithRSAEncryption",
  "1.2.840.113549.1.1.13": "sha512WithRSAEncryption",
  "1.2.840.113549.1.1.10": "RSASSA-PSS",
  "1.2.840.10045.4.1": "ecdsa-with-SHA1",
  "1.2.840.10045.4.3.2": "ecdsa-with-SHA256",
  "1.2.840.10045.4.3.3": "ecdsa-with-SHA384",
  "1.2.840.10045.4.3.4": "ecdsa-with-SHA512",
  "1.3.101.112": "Ed25519",
  "1.3.101.113": "Ed448",
};
const SCT_OID = "1.3.6.1.4.1.11129.2.4.2";
const MUST_STAPLE_OID = "1.3.6.1.5.5.7.1.24";

export interface ParsedCert {
  subject: string;
  issuer: string;
  names: string[];
  validFrom: Date;
  validTo: Date;
  keyType: string;
  keyBits: number | null;
  curve: string | null;
  signature: string;
  weakSignature: boolean;
  selfIssued: boolean;
  isCa: boolean;
  hasSct: boolean;
  mustStaple: boolean;
  serial: string;
  sha256: string;
  x509: X509Certificate;
}

const oneLine = (s: string) => s.replace(/\n/g, ", ");

export function parseCert(der: Buffer): ParsedCert {
  const x = new X509Certificate(der);
  const asn = AsnConvert.parse(der, Certificate);
  const sigOid = asn.signatureAlgorithm.algorithm;
  const signature = SIG_OIDS[sigOid] ?? sigOid;
  const exts = asn.tbsCertificate.extensions ?? [];
  const key = x.publicKey;
  const details = key.asymmetricKeyDetails ?? {};
  const names = (x.subjectAltName ?? "")
    .split(/,\s*/)
    .filter((n) => n.startsWith("DNS:"))
    .map((n) => n.slice(4));
  return {
    subject: oneLine(x.subject),
    issuer: oneLine(x.issuer),
    names,
    validFrom: new Date(x.validFrom),
    validTo: new Date(x.validTo),
    keyType: key.asymmetricKeyType ?? "unknown",
    keyBits: details.modulusLength ?? null,
    curve: details.namedCurve ?? null,
    signature,
    weakSignature: /md5|sha1/i.test(signature),
    selfIssued: x.subject === x.issuer,
    isCa: x.ca,
    hasSct: exts.some((e) => e.extnID === SCT_OID),
    mustStaple: exts.some((e) => e.extnID === MUST_STAPLE_OID),
    serial: x.serialNumber,
    sha256: x.fingerprint256,
    x509: x,
  };
}

const keyLabel = (c: ParsedCert) => (c.keyType === "rsa" || c.keyType === "rsa-pss" ? `RSA ${c.keyBits} bits` : c.keyType === "ec" ? `EC ${c.curve ?? "?"}` : c.keyType);
const EC_BITS: Record<string, number> = { prime256v1: 256, "P-256": 256, secp384r1: 384, "P-384": 384, secp521r1: 521, "P-521": 521, secp256k1: 256 };
const DAY = 86_400_000;

/** What Node/OpenSSL's verification error means in plain words. */
const TRUST_ERRORS: Record<string, string> = {
  CERT_HAS_EXPIRED: "the certificate has expired",
  CERT_NOT_YET_VALID: "the certificate isn't valid yet",
  DEPTH_ZERO_SELF_SIGNED_CERT: "the certificate is self-signed",
  SELF_SIGNED_CERT_IN_CHAIN: "the chain ends in a self-signed certificate that browsers don't trust",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "the server doesn't send the intermediate certificate(s), so the chain can't be completed",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "the certificate's issuer isn't a trusted authority (or an intermediate is missing)",
  UNABLE_TO_GET_ISSUER_CERT: "the issuer certificate couldn't be found",
  CERT_REVOKED: "the certificate has been revoked",
  CERT_SIGNATURE_FAILURE: "a signature in the chain doesn't verify",
  INVALID_CA: "an intermediate isn't allowed to act as a certificate authority",
};

export interface CertEvidence {
  host: string;
  chain: Buffer[];
  authorized: boolean;
  authError: string | null;
  hostnameError: string | null;
  ocspStapled: boolean;
  now: Date;
}

export function analyseCertificate(e: CertEvidence): { checks: CheckResult[]; summary: CertificateSummary | null } {
  const checks: CheckResult[] = [];
  if (!e.chain.length) {
    checks.push(check({ id: "cert.present", category: "certificate", title: "Certificate", status: "inconclusive", severity: "critical", summary: "No certificate was received, so it couldn't be checked." }));
    return { checks, summary: null };
  }
  let parsed: ParsedCert[];
  try {
    parsed = e.chain.map(parseCert);
  } catch (err) {
    checks.push(check({ id: "cert.parse", category: "certificate", title: "Certificate", status: "inconclusive", severity: "high", summary: `The certificate couldn't be parsed: ${err instanceof Error ? err.message : "unknown error"}.` }));
    return { checks, summary: null };
  }
  const leaf = parsed[0];
  const daysLeft = Math.floor((leaf.validTo.getTime() - e.now.getTime()) / DAY);
  const leafEvidence = [
    { label: "Subject", value: leaf.subject },
    { label: "Issuer", value: leaf.issuer },
    { label: "Names", value: leaf.names.join(", ") || "(none)" },
    { label: "Valid", value: `${leaf.validFrom.toISOString().slice(0, 10)} → ${leaf.validTo.toISOString().slice(0, 10)}` },
    { label: "SHA-256", value: leaf.sha256 },
  ];

  // Trust (the chain, as OpenSSL verified it against the trusted root store; the hostname is separate).
  const trustWhy = e.authError ? (TRUST_ERRORS[e.authError] ?? e.authError) : null;
  checks.push(
    e.authorized
      ? check({ id: "cert.trusted", category: "certificate", title: "Certificate is trusted", status: "passed", severity: "critical", summary: `The chain verifies up to a trusted root (${parsed.at(-1)!.subject}).`, evidence: leafEvidence })
      : check({
          id: "cert.trusted",
          category: "certificate",
          title: "Certificate is trusted",
          status: "failed",
          severity: e.authError === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ? "high" : "critical",
          summary: `Browsers won't trust this certificate: ${trustWhy}.`,
          evidence: [...leafEvidence, { label: "Verification error", value: e.authError ?? "unknown" }],
          remediation:
            e.authError === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
              ? "Serve the full chain: the server certificate followed by its intermediate certificate(s) (most CAs provide a 'fullchain' file)."
              : e.authError === "CERT_HAS_EXPIRED"
                ? "Renew the certificate now and set up automatic renewal (e.g. Let's Encrypt with certbot or your host's managed certificates)."
                : "Use a certificate from a publicly trusted certificate authority (e.g. Let's Encrypt) and serve its full chain.",
          references: [REF.cabf],
        }),
  );

  // Hostname
  checks.push(
    e.hostnameError
      ? check({
          id: "cert.hostname",
          category: "certificate",
          title: "Certificate matches the hostname",
          status: "failed",
          severity: "critical",
          summary: `The certificate isn't valid for ${e.host}.`,
          evidence: [{ label: "Names on certificate", value: leaf.names.join(", ") || leaf.subject }, { label: "Check", value: e.hostnameError }],
          remediation: `Issue a certificate whose Subject Alternative Names include ${e.host}.`,
        })
      : check({ id: "cert.hostname", category: "certificate", title: "Certificate matches the hostname", status: "passed", severity: "critical", summary: `Valid for ${e.host}.`, evidence: [{ label: "Names", value: leaf.names.join(", ") }] }),
  );

  // Validity window
  if (leaf.validFrom.getTime() > e.now.getTime())
    checks.push(check({ id: "cert.expiry", category: "certificate", title: "Certificate validity", status: "failed", severity: "critical", summary: `Not valid until ${leaf.validFrom.toISOString().slice(0, 10)}.`, evidence: leafEvidence.slice(3, 4), remediation: "Check the server clock and the certificate's start date; reissue if needed." }));
  else if (daysLeft < 0)
    checks.push(check({ id: "cert.expiry", category: "certificate", title: "Certificate validity", status: "failed", severity: "critical", summary: `Expired ${-daysLeft} day${daysLeft === -1 ? "" : "s"} ago (${leaf.validTo.toISOString().slice(0, 10)}).`, evidence: leafEvidence.slice(3, 4), remediation: "Renew the certificate now and set up automatic renewal." }));
  else if (daysLeft <= 7)
    checks.push(check({ id: "cert.expiry", category: "certificate", title: "Certificate validity", status: "failed", severity: "high", summary: `Expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"} (${leaf.validTo.toISOString().slice(0, 10)}).`, evidence: leafEvidence.slice(3, 4), remediation: "Renew now; check that automatic renewal is working." }));
  else if (daysLeft <= 30)
    checks.push(check({ id: "cert.expiry", category: "certificate", title: "Certificate validity", status: "warning", severity: "medium", summary: `Expires in ${daysLeft} days (${leaf.validTo.toISOString().slice(0, 10)}).`, evidence: leafEvidence.slice(3, 4), remediation: "Make sure automatic renewal is set up; most CAs renew 30 days before expiry." }));
  else checks.push(check({ id: "cert.expiry", category: "certificate", title: "Certificate validity", status: "passed", severity: "critical", summary: `Valid for ${daysLeft} more days (until ${leaf.validTo.toISOString().slice(0, 10)}).`, evidence: leafEvidence.slice(3, 4) }));

  // Key strength
  const bits = leaf.keyType.startsWith("rsa") ? (leaf.keyBits ?? 0) : leaf.keyType === "ec" ? (EC_BITS[leaf.curve ?? ""] ?? 0) : 256;
  const weakKey = leaf.keyType.startsWith("rsa") ? bits < 2048 : leaf.keyType === "ec" ? bits < 256 : false;
  checks.push(
    check({
      id: "cert.key",
      category: "certificate",
      title: "Certificate key strength",
      status: weakKey ? "failed" : "passed",
      severity: "high",
      summary: weakKey ? `${keyLabel(leaf)} is too weak; modern clients require at least RSA 2048 bits or a 256-bit EC key.` : `${keyLabel(leaf)}.`,
      evidence: [{ label: "Key", value: keyLabel(leaf) }],
      remediation: weakKey ? "Generate a new key (RSA 2048+ or ECDSA P-256) and reissue the certificate." : null,
      references: weakKey ? [REF.mozilla] : [],
    }),
  );

  // Signature algorithms (the root's own signature doesn't matter: it's trusted by being in the store)
  const signed = parsed.filter((c, i) => !(i === parsed.length - 1 && c.selfIssued && parsed.length > 1));
  const weakSigs = signed.filter((c) => c.weakSignature);
  checks.push(
    check({
      id: "cert.signature",
      category: "certificate",
      title: "Signature algorithms",
      status: weakSigs.length ? "failed" : "passed",
      severity: "high",
      summary: weakSigs.length ? `${weakSigs.map((c) => `${c.subject} is signed with ${c.signature}`).join("; ")}. SHA-1 and MD5 signatures are rejected by browsers.` : `All certificates use strong signatures (${[...new Set(signed.map((c) => c.signature))].join(", ")}).`,
      evidence: parsed.map((c) => ({ label: c.subject, value: c.signature })),
      remediation: weakSigs.length ? "Reissue the certificate (and use an intermediate) signed with SHA-256 or better." : null,
    }),
  );

  // Chain order: each certificate should be issued by the next one.
  const misordered = parsed.slice(0, -1).some((c, i) => !c.x509.checkIssued(parsed[i + 1].x509));
  if (parsed.length > 1)
    checks.push(
      check({
        id: "cert.chain-order",
        category: "certificate",
        title: "Chain order",
        status: misordered ? "warning" : "passed",
        severity: "low",
        summary: misordered ? "The certificates aren't in issuing order; some clients can't build the chain." : `${parsed.length} certificates, each issued by the next.`,
        evidence: parsed.map((c, i) => ({ label: `#${i}`, value: `${c.subject} ← ${c.issuer}` })),
        remediation: misordered ? "Serve the leaf first, then each intermediate in order." : null,
      }),
    );

  // Lifetime (public CAs may not issue certificates valid for more than 398 days).
  const lifetime = Math.round((leaf.validTo.getTime() - leaf.validFrom.getTime()) / DAY);
  if (lifetime > 398)
    checks.push(check({ id: "cert.lifetime", category: "certificate", title: "Certificate lifetime", status: "warning", severity: "low", summary: `Issued for ${lifetime} days; browsers reject publicly trusted certificates valid for more than 398 days.`, evidence: leafEvidence.slice(3, 4), references: [REF.cabf] }));

  checks.push(
    check({
      id: "cert.ocsp-stapling",
      category: "certificate",
      title: "OCSP stapling",
      status: e.ocspStapled ? "passed" : leaf.mustStaple ? "failed" : "info",
      severity: leaf.mustStaple ? "high" : "info",
      summary: e.ocspStapled
        ? "The server staples an OCSP response (its contents weren't validated by Orbis)."
        : leaf.mustStaple
          ? "The certificate requires OCSP stapling (Must-Staple) but none was sent: browsers that enforce it will refuse the site."
          : "No OCSP response stapled. Optional, but it speeds up revocation checks.",
    }),
  );
  checks.push(
    check({
      id: "cert.transparency",
      category: "certificate",
      title: "Certificate Transparency",
      status: leaf.hasSct ? "passed" : "info",
      severity: "info",
      summary: leaf.hasSct ? "Signed certificate timestamps are embedded in the certificate." : "No embedded SCTs found; they may still be delivered in the TLS handshake or OCSP (not checked).",
    }),
  );

  const summary: CertificateSummary = {
    subject: leaf.subject,
    issuer: leaf.issuer,
    names: leaf.names,
    validFrom: leaf.validFrom.toISOString(),
    validTo: leaf.validTo.toISOString(),
    daysLeft,
    key: keyLabel(leaf),
    signature: leaf.signature,
    trusted: e.authorized,
    chain: parsed.map((c) => ({ subject: c.subject, issuer: c.issuer, validTo: c.validTo.toISOString(), key: keyLabel(c), signature: c.signature })),
  };
  return { checks, summary };
}

/* --------------------------------------------------------------- protocols & ciphers */

export type ProtocolState = "supported" | "not supported" | "untested" | "inconclusive";
export type Strength = "strong" | "acceptable" | "weak" | "insecure";

export function classifyCipher(name: string, protocol: string): { strength: Strength; forwardSecrecy: boolean; why: string } {
  const n = name.toUpperCase();
  if (protocol === "TLSv1.3" || n.startsWith("TLS_")) return { strength: /CCM_8/.test(n) ? "acceptable" : "strong", forwardSecrecy: true, why: "TLS 1.3 suite" };
  const fs = /^(ECDHE|DHE|EDH)-/.test(n);
  if (/NULL|^ADH|^AECDH|EXP|RC4|(^|-)DES-CBC-|MD5|ANON/.test(n)) return { strength: "insecure", forwardSecrecy: fs, why: /NULL/.test(n) ? "no encryption" : /^A(DH|ECDH)|ANON/.test(n) ? "no authentication (anonymous)" : "broken algorithm" };
  if (/3DES|DES-CBC3|IDEA|SEED/.test(n)) return { strength: "weak", forwardSecrecy: fs, why: "64-bit block cipher" };
  if (!fs) return { strength: "weak", forwardSecrecy: false, why: "RSA key exchange (no forward secrecy)" };
  if (/GCM|CHACHA20|CCM/.test(n)) return { strength: "strong", forwardSecrecy: true, why: "forward secrecy + authenticated encryption" };
  return { strength: "acceptable", forwardSecrecy: true, why: "forward secrecy, CBC mode" };
}

export interface CipherSeen {
  protocol: string;
  name: string;
  /** For DHE suites: the server's DH group size. */
  dhBits?: number | null;
}

export interface TlsEvidence {
  reachable: boolean;
  /** A default (modern) client handshake: ok, or the error it hit. */
  modernError: string | null;
  negotiated: { protocol: string; cipher: string; forwardSecrecy: boolean; alpn: string | null } | null;
  protocols: Record<"TLSv1" | "TLSv1.1" | "TLSv1.2" | "TLSv1.3", ProtocolState>;
  /** Accepted ciphers, in server preference order where known. */
  ciphers: CipherSeen[];
  /** True when the cipher list for TLS 1.2 was fully enumerated (not cut short). */
  ciphersComplete: boolean;
  renegotiation: "allowed" | "refused" | "not-applicable" | null;
  /** TLS ≤1.2 connected with OpenSSL's default secure-renegotiation requirement (RFC 5746). */
  secureRenegotiation: boolean | null;
}

export function analyseTls(e: TlsEvidence): CheckResult[] {
  const out: CheckResult[] = [];
  const p = e.protocols;
  const protoEvidence = Object.entries(p).map(([k, v]) => ({ label: k.replace("TLSv1", "TLS 1.0").replace("TLS 1.0.", "TLS 1."), value: v }));

  if (e.modernError)
    out.push(check({ id: "tls.modern-client", category: "tls", title: "Modern clients can connect", status: "failed", severity: "high", summary: `A default, modern TLS client couldn't connect: ${e.modernError}.`, evidence: protoEvidence, remediation: "Enable TLS 1.2 and 1.3 with modern cipher suites (see Mozilla's server-side TLS guide).", references: [REF.mozilla] }));
  else if (e.negotiated)
    out.push(check({ id: "tls.modern-client", category: "tls", title: "Modern clients can connect", status: "passed", severity: "high", summary: `Negotiated ${e.negotiated.protocol} with ${e.negotiated.cipher}${e.negotiated.alpn ? ` (ALPN ${e.negotiated.alpn})` : ""}.` }));

  const modern = p["TLSv1.2"] === "supported" || p["TLSv1.3"] === "supported";
  out.push(
    check({
      id: "tls.modern-protocols",
      category: "tls",
      title: "TLS 1.2 or 1.3 supported",
      status: modern ? "passed" : p["TLSv1.2"] === "inconclusive" && p["TLSv1.3"] === "inconclusive" ? "inconclusive" : "failed",
      severity: "critical",
      summary: modern ? `Supported: ${(["TLSv1.3", "TLSv1.2"] as const).filter((v) => p[v] === "supported").join(", ").replace(/TLSv/g, "TLS ")}.` : "Neither TLS 1.2 nor TLS 1.3 is accepted.",
      evidence: protoEvidence,
      remediation: modern ? null : "Enable TLS 1.2 and TLS 1.3.",
    }),
  );
  out.push(
    check({
      id: "tls.tls13",
      category: "tls",
      title: "TLS 1.3",
      status: p["TLSv1.3"] === "supported" ? "passed" : p["TLSv1.3"] === "not supported" ? "warning" : "inconclusive",
      severity: "low",
      summary: p["TLSv1.3"] === "supported" ? "TLS 1.3 is supported." : p["TLSv1.3"] === "not supported" ? "TLS 1.3 isn't supported. It's faster and removes legacy options." : "Couldn't determine TLS 1.3 support.",
      remediation: p["TLSv1.3"] === "not supported" ? "Enable TLS 1.3 in the web server or CDN." : null,
    }),
  );
  const legacy = (["TLSv1", "TLSv1.1"] as const).filter((v) => p[v] === "supported");
  out.push(
    check({
      id: "tls.legacy-protocols",
      category: "tls",
      title: "TLS 1.0 and 1.1 disabled",
      status: legacy.length ? "failed" : (["TLSv1", "TLSv1.1"] as const).some((v) => p[v] === "inconclusive") ? "inconclusive" : "passed",
      severity: "medium",
      summary: legacy.length ? `${legacy.map((v) => v.replace("TLSv1", "TLS 1.0").replace("TLS 1.0.", "TLS 1.")).join(" and ")} accepted. Both are deprecated (RFC 8996) and lack modern protections.` : "TLS 1.0 and 1.1 are refused.",
      evidence: protoEvidence,
      remediation: legacy.length ? "Disable TLS 1.0 and 1.1; keep TLS 1.2 and 1.3." : null,
      references: [REF.rfc8996],
    }),
  );
  out.push(
    check({
      id: "tls.ssl",
      category: "tls",
      title: "SSL 2.0 and 3.0",
      status: "untested",
      severity: "critical",
      summary: "Not tested: Orbis's TLS client (OpenSSL 3) can't speak SSL 2.0/3.0, so it can't tell whether the server would accept them (POODLE). Servers that accept TLS 1.2+ only almost never do.",
      references: ["https://www.rfc-editor.org/rfc/rfc7568"],
    }),
  );

  // Ciphers
  const classified = e.ciphers.map((c) => ({ ...c, ...classifyCipher(c.name, c.protocol) }));
  // One entry per suite name (the same suite is often accepted on several versions).
  const uniq = <T extends { name: string }>(xs: T[]) => xs.filter((x, i) => xs.findIndex((y) => y.name === x.name) === i);
  const insecure = uniq(classified.filter((c) => c.strength === "insecure"));
  const weak = uniq(classified.filter((c) => c.strength === "weak"));
  const list = (xs: { name: string; why: string }[], n: number) => {
    const groups = [...new Set(xs.map((x) => x.why))].map((why) => `${why}: ${xs.filter((x) => x.why === why).map((x) => x.name).slice(0, n).join(", ")}${xs.filter((x) => x.why === why).length > n ? ", …" : ""}`);
    return groups.join("; ");
  };
  const cipherEvidence = classified.slice(0, 40).map((c) => ({ label: `${c.protocol.replace("TLSv", "TLS ")} ${c.name}`, value: `${c.strength} (${c.why})` }));
  out.push(
    check({
      id: "tls.ciphers-insecure",
      category: "tls",
      title: "No insecure cipher suites",
      status: insecure.length ? "failed" : classified.length ? "passed" : "inconclusive",
      severity: "critical",
      summary: insecure.length ? `Accepts ${insecure.length} insecure suite${insecure.length === 1 ? "" : "s"}. ${list(insecure, 4)}.` : classified.length ? `None of the ${classified.length} accepted suites is insecure${e.ciphersComplete ? "" : " (the list may be incomplete)"}.` : "No cipher suites could be listed.",
      evidence: cipherEvidence,
      remediation: insecure.length ? "Remove NULL, anonymous, export, RC4 and DES suites from the server's cipher list." : null,
      references: [REF.mozilla],
    }),
  );
  out.push(
    check({
      id: "tls.ciphers-weak",
      category: "tls",
      title: "No weak cipher suites",
      status: weak.length ? "warning" : classified.length ? "passed" : "inconclusive",
      severity: "low",
      summary: weak.length ? `${weak.length} weak suite${weak.length === 1 ? "" : "s"} accepted. ${list(weak, 4)}. Clients only use them if nothing better is shared.` : classified.length ? "No weak suites among those accepted." : "No cipher suites could be listed.",
      evidence: cipherEvidence,
      remediation: weak.length ? "Prefer ECDHE with AES-GCM or ChaCha20-Poly1305 and drop RSA key-exchange suites." : null,
      references: [REF.mozilla],
    }),
  );
  out.push(
    check({
      id: "tls.ciphers-untestable",
      category: "tls",
      title: "3DES, RC4 and EXPORT suites",
      status: "untested",
      severity: "medium",
      summary: "Not tested: Orbis's TLS client doesn't include 3DES (SWEET32), RC4 or EXPORT suites (FREAK/Logjam export), so it can't offer them to see whether the server accepts them.",
    }),
  );

  if (e.negotiated)
    out.push(
      check({
        id: "tls.forward-secrecy",
        category: "tls",
        title: "Forward secrecy",
        status: e.negotiated.forwardSecrecy ? (classified.some((c) => !c.forwardSecrecy) ? "warning" : "passed") : "failed",
        severity: e.negotiated.forwardSecrecy ? "low" : "medium",
        summary: e.negotiated.forwardSecrecy
          ? classified.some((c) => !c.forwardSecrecy)
            ? "Modern clients get forward secrecy, but some accepted suites (RSA key exchange) don't provide it."
            : "Every accepted suite provides forward secrecy."
          : "A modern client was given a suite without forward secrecy: recorded traffic can be decrypted later if the server key leaks.",
        remediation: e.negotiated.forwardSecrecy ? null : "Prefer ECDHE suites and order them first.",
      }),
    );

  const dh = classified.filter((c) => typeof c.dhBits === "number").map((c) => c.dhBits as number);
  if (dh.length) {
    const min = Math.min(...dh);
    out.push(
      check({
        id: "tls.dh-strength",
        category: "tls",
        title: "Diffie-Hellman group strength",
        status: min < 2048 ? "failed" : "passed",
        severity: min < 1024 ? "high" : "medium",
        summary: min < 2048 ? `DHE suites use a ${min}-bit group; 2048 bits is the minimum today (Logjam).` : `DHE suites use ${min}-bit groups.`,
        remediation: min < 2048 ? "Use a 2048-bit (or larger) DH group, e.g. RFC 7919 ffdhe2048, or drop DHE in favour of ECDHE." : null,
        references: [REF.logjam],
      }),
    );
  }

  if (e.secureRenegotiation !== null)
    out.push(
      check({
        id: "tls.secure-renegotiation",
        category: "tls",
        title: "Secure renegotiation (RFC 5746)",
        status: e.secureRenegotiation ? "passed" : "failed",
        severity: "medium",
        confirmed: !e.secureRenegotiation,
        summary: e.secureRenegotiation
          ? "Supported. Inferred: OpenSSL 3 only completes a TLS ≤1.2 handshake when the server signals RFC 5746 support."
          : "The server doesn't signal secure renegotiation; OpenSSL refused the legacy handshake.",
        references: [REF.rfc5746],
      }),
    );
  if (e.renegotiation)
    out.push(
      check({
        id: "tls.client-renegotiation",
        category: "tls",
        title: "Client-initiated renegotiation",
        status: e.renegotiation === "allowed" ? "warning" : e.renegotiation === "refused" ? "passed" : "info",
        severity: "low",
        summary:
          e.renegotiation === "allowed"
            ? "The server accepted one client-initiated renegotiation. That lets a client make the server repeat expensive handshakes on one connection."
            : e.renegotiation === "refused"
              ? "Refused (one attempt was made)."
              : "Not applicable: TLS 1.3 has no renegotiation.",
        remediation: e.renegotiation === "allowed" ? "Disable client-initiated renegotiation in the server's TLS settings." : null,
      }),
    );

  if (p.TLSv1 === "supported" && classified.some((c) => c.protocol === "TLSv1" && /CBC|-SHA$/.test(c.name.toUpperCase()) && !/GCM|CHACHA/.test(c.name.toUpperCase())))
    out.push(check({ id: "tls.beast", category: "tls", title: "BEAST (TLS 1.0 with CBC)", status: "warning", severity: "low", confirmed: false, summary: "TLS 1.0 with CBC suites is accepted, the precondition for BEAST. Inferred; modern browsers mitigate it client-side.", remediation: "Disable TLS 1.0." }));

  out.push(
    check({
      id: "tls.vuln-untested",
      category: "tls",
      title: "Implementation vulnerability tests",
      status: "untested",
      severity: "high",
      summary: "Not tested: Heartbleed, ROBOT, CCS injection, Ticketbleed, Zombie POODLE / GOLDENDOODLE, TLS compression (CRIME) and TLS_FALLBACK_SCSV need specially crafted handshakes; Orbis only makes standard handshakes. Use a dedicated TLS scanner (e.g. testssl.sh) on a server you control for these.",
      references: ["https://testssl.sh/"],
    }),
  );
  return out;
}
