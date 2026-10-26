# Orbis Website Scanner (SSL/TLS & website security audit)

`/agents/security/scanner`: an external, read-only check of a website **you own or are authorised to test**. It covers
the TLS configuration, the certificate, HTTP security headers, cookies, content, web-server configuration and DNS.
Every result carries its evidence. A check that couldn't run is labelled as such and never counts as a pass.

> A limited external scan can't show that a website is secure. It reports what it could observe from outside, on
> one hostname, at one moment.

The scanner was inspired by SSL Labs' idea of a letter grade with hard caps, but it is **independent**. It does not
call the SSL Labs API: the API's terms don't allow commercial use or use on a public site without permission. It also
does **not** reproduce SSL Labs' rating methodology, so the two grades can differ.

## How a scan runs

1. **Authorisation (server side).** The website must be a target on the user's account, and ownership is re-proved by
   the server right before every scan. The proof is one of:
   - a token at `/.well-known/orbis-security-verification.txt`;
   - a DNS TXT record on `_orbis-verify.<host>`;
   - an administrator scanning this deployment's own domain.

   The request must also carry `authorized: true`, which comes from the checkbox. Hostnames are normalised: IP
   addresses, `localhost`, `.local` and `.internal` names, and ports other than 80/443 are refused.
2. **Resolve.** The guarded lookup refuses any name that resolves to a private, loopback, link-local, CGNAT or other
   reserved address, and that check repeats on every connection (DNS rebinding can't reach internal networks).
3. **TLS.** Ordinary TLS handshakes through Node's TLS stack (OpenSSL 3), at most 3 at a time, at most 90 per scan,
   within a 50 s budget, each with an 8 s timeout. No application data is sent.
   - One handshake as a modern browser (ALPN h2/http1.1, OCSP stapling requested). If it fails, a legacy handshake
     still collects the certificate.
   - One handshake per version (TLS 1.3, 1.2, 1.1 and 1.0). A refusal (alert or reset) means "not supported"; a
     timeout means "inconclusive".
   - One client-initiated renegotiation attempt (TLS ≤ 1.2).
   - The TLS 1.3 suites, offered one at a time.
   - Targeted probes for NULL, anonymous and RSA key-exchange suites, so those are found however long the list is.
   - Cipher-suite listing per TLS ≤ 1.2 version: each handshake offers every suite except those already accepted
     (TLS 1.2 up to 48, older versions up to 16). The list is marked incomplete when a cap is hit.
4. **HTTP.**
   - The home page over HTTPS, following redirects on the same hostname only, and `http://` (port 80).
   - A random missing page, to check the error page.
   - `/.well-known/security.txt`.

   Requests go through `safeRequest`: no automatic redirects, a 10 s timeout and a 512 KB cap. Headers are read even
   when the certificate is invalid; that is reported separately, and no credentials are ever sent.
5. **Exposure (active scope only, "Standard + exposed files").** Eight well-known sensitive paths (`/.env`,
   `/.git/HEAD`, `/.git/config`, `/.aws/credentials`, `/wp-config.php.bak`, `/backup.sql`, `/server-status`,
   `/.DS_Store`) are requested one at a time, 200 ms apart, plus one `TRACE /`. A file only counts as exposed when its
   content matches. Secret values are never stored: evidence lists variable names only.
6. **DNS.**
   - CAA: the closest name up the tree that has records.
   - DNSSEC: the resolver's AD flag, plus whether a DS record exists.
   - SPF and DMARC, plus whether the name has IPv6.

   These run alongside the site checks through DNS-over-HTTPS (Google Public DNS, falling back to Cloudflare), because
   Node's resolver doesn't expose the AD flag. Only the hostname and its parent names are sent.
7. **Grade** (below), **findings** and **storage**:
   - Failed checks and warnings become findings in the shared Security findings list (rule ids `sitescan.*`, stable
     per host).
   - On a re-scan, findings for checks that now pass are marked "not detected" (and "verified" if they had been
     marked fixed).

**Rate limits and caching.**
- 12 security runs per user per 10 minutes, across all security agents.
- 4 scans per hostname per 10 minutes.
- A completed scan of the same host and scope is reused for 15 minutes; **Retest** forces a new scan.
- The route allows 120 s.

## Check statuses

| Status | Meaning |
|---|---|
| Passed | Ran; the site met the check (evidence attached). |
| Failed | Ran; a problem was found. **Inferred** marks a failure deduced from other evidence rather than observed directly. |
| Warning | Ran; not a failure, but worth attention (e.g. the certificate expires within 30 days). |
| Info | Ran; reported for context, no judgement. |
| Skipped | Not run on purpose (e.g. exposure probes in standard scope). |
| Inconclusive | Ran but couldn't decide (timeout, resolver failure). |
| Not tested | Orbis can't test this (see the limitations below). |

## What is checked

**SSL/TLS**
- A modern client can connect.
- TLS 1.2/1.3 supported.
- TLS 1.3 offered.
- TLS 1.0/1.1 refused (RFC 8996).
- No insecure suites: NULL, anonymous, EXPORT, RC4, DES, MD5.
- Weak suites: RSA key exchange, 3DES, IDEA, SEED.
- Forward secrecy.
- DH group size (Logjam).
- Secure renegotiation (RFC 5746). This is *inferred*: OpenSSL 3 only completes a TLS ≤ 1.2 handshake with servers
  that support it.
- Client-initiated renegotiation.
- BEAST precondition (TLS 1.0 with CBC, *inferred*).

**Certificate**
- Trusted chain (Node's root store).
- Hostname match.
- Validity and expiry: expired or not yet valid → critical; ≤ 7 days → high; ≤ 30 days → warning.
- Key strength: RSA ≥ 2048, EC ≥ 256.
- Signature algorithms: MD5 and SHA-1 rejected (the root's own signature is ignored).
- Chain order.
- Lifetime over 398 days.
- OCSP stapling, including Must-Staple.
- Embedded SCTs.

**HTTP security headers**
- HSTS: parsed per RFC 6797; ≥ 180 days recommended.
- Content-Security-Policy: parsed per CSP3, including a `<meta>` CSP. It flags `'unsafe-inline'` without nonces,
  hashes or `'strict-dynamic'`, `'unsafe-eval'`, wildcard script sources, a missing `object-src`, and report-only
  mode.
- X-Content-Type-Options.
- Clickjacking protection: `frame-ancestors` or X-Frame-Options.
- Referrer-Policy.
- Permissions-Policy and COOP (informational).

**Web configuration**
- HTTPS available.
- HTTP → HTTPS redirect.
- Cookies: Secure, HttpOnly for session-like names (*inferred* from the name), and SameSite. Cookie values are never
  stored.
- Mixed content: active (script, stylesheet, frame, object) and passive (media), plus forms posting to `http://`. The
  HTML is parsed with parse5.
- Third-party scripts and Subresource Integrity.
- Version banners in headers.
- Debug and stack-trace error pages.
- Soft 404s.
- Directory listing.
- CORS: an arbitrary origin reflected with credentials.
- security.txt.
- TRACE and exposed files (active scope).

**DNS:** CAA, DNSSEC (including a signed zone that fails validation), SPF, DMARC and IPv6.

## The grade

This is Orbis's own documented method (`src/lib/security/sitescan/grade.ts`):

1. Two part scores start at 100:
   - **transport**: the TLS and certificate checks;
   - **web**: everything else.
2. Each check deducts by severity: failed critical 40, high 25, medium 12, low 4. A warning, or a failure that is
   only inferred, deducts half. Passed, info, skipped, inconclusive and not-tested checks deduct nothing.
3. Score = round(0.6 × transport + 0.4 × web).
4. Letter: A ≥ 90, B ≥ 80, C ≥ 65, D ≥ 50, otherwise F.
5. Caps:
   - any confirmed critical failure → F;
   - any confirmed high failure → at most C;
   - TLS 1.0/1.1 accepted, no forward secrecy for modern clients, or DH groups under 2048 bits → at most B.
6. **A+** means an uncapped A, HSTS ≥ 180 days, TLS 1.3, and no transport warnings.
7. There is no grade if HTTPS couldn't be reached or no certificate was received.

## Limitations and what needs manual verification

- **Not tested by Orbis:**
  - SSL 2.0/3.0, and 3DES, RC4 and EXPORT suites. Node's OpenSSL 3 build can't offer them.
  - TLS implementation bugs that need crafted handshakes: Heartbleed, ROBOT, CCS injection, Ticketbleed, Zombie
    POODLE/GOLDENDOODLE, compression (CRIME) and TLS_FALLBACK_SCSV.

  Use a dedicated TLS scanner (e.g. testssl.sh) on a server you control for these.
- **One address.** TLS checks use the first address the hostname resolves to. Sites behind several servers or a CDN
  can differ per edge.
- **Cipher lists** stop at a cap. The dangerous categories are probed separately, so they're found anyway.
- **Revocation.** OCSP response contents aren't validated, and certificate revocation isn't checked.
- **Trust store.** Trust is judged against Node's bundled Mozilla root store, not every browser's.
- **Inferred checks.** Session-cookie detection is by name. Secure renegotiation and BEAST are inferred and labelled
  so.
- **Needs authenticated or deeper testing** (listed on every report):
  - pages behind sign-in;
  - application vulnerabilities (XSS, SQL injection, access control);
  - other hostnames and ports;
  - content loaded by JavaScript;
  - load and denial-of-service resilience (never tested, by design).

## Storage and privacy

- A scan is a Sentinel run (`security_runs`, action `site_scan`), so it is protected by the existing row-level security
  (owner only). No database migration was needed.
- The full report is stored gzip-compressed in the run's `stats` (`reportGz`). A shortened copy marked `trimmed` is
  used only if the compressed report doesn't fit.
- The Markdown report is stored in `summary`.
- History reads only the small `stats.overview`.
- Exports: `GET /api/security/sitescan/<id>/export?format=md|json|html`. The HTML is self-contained, with no scripts
  and its own `default-src 'none'` policy.
- The audit log records scan start/finish and exports, without the report contents.

## API

| Method | Path | |
|---|---|---|
| POST | `/api/security/sitescan` | `{ targetId, scope: "passive" \| "active", authorized: true, force? }` returns an NDJSON stream of `run`, `step`, `progress`, `notice`, `findings`, `cached`, `scan_report`, `done` or `error` events. |
| GET | `/api/security/sitescan?host=&limit=` | Scan history (overview only). |
| GET | `/api/security/sitescan/<id>` | One scan's report, steps and status. |
| GET | `/api/security/sitescan/<id>/export?format=` | Download Markdown, HTML or JSON. |

Targets and ownership use the existing `/api/security/targets` and `/api/security/targets/<id>/verify`.

## Code

All files are in `src/lib/security/sitescan/` unless a path is given.

| File | Role |
|---|---|
| `tls-probe.ts` | One TLS handshake and what it showed (`server-only`). |
| `tls-scan.ts` | Probe orchestration: versions, suites, renegotiation, budgets. |
| `tls-analysis.ts` | Certificate parsing (X509Certificate + @peculiar/asn1-x509) and TLS/certificate checks (pure). |
| `http-analysis.ts` | Header, cookie, content, server and CORS checks (pure; parse5, `cookie`). |
| `dns.ts` | DNS-over-HTTPS client and DNS checks. |
| `grade.ts` | The grade. |
| `report.ts` | Findings, Markdown and HTML exports, fitting a report to a size. |
| `store.ts` | Compressed storage. |
| `engine.ts` | The scan pipeline. |
| `scan-net.ts` | Production network wiring, and the local test lab. |
| `src/lib/security/runners.ts` (`runWebsiteScan`) | Authorisation, rate limits, cache, persistence and findings. |
| `src/components/security/site-scanner.tsx` | The dashboard. |

New dependencies, pinned to exact versions: `@peculiar/asn1-x509` and `@peculiar/asn1-schema` 2.10.0, `parse5`
8.0.1, and `cookie` 1.1.1 (already installed transitively).

## Testing

- `tests/sitescan-probe.test.ts`, `tests/sitescan-tls.test.ts` and `tests/sitescan-engine.test.ts` run against a
  **controlled lab**, `tests/helpers/tls-lab.ts`:
  - a private test CA, generated with the openssl CLI into a temporary folder (no keys are kept in the repository);
  - local HTTPS/HTTP servers on 127.0.0.1 with known configurations: modern, legacy (TLS 1.0/1.1, NULL, anonymous and
    RSA-kx suites, 1024-bit DH, renegotiation allowed), TLS 1.3-only, expired, expiring soon, self-signed, missing
    intermediate, 1024-bit key, SHA-1 signed and EC;
  - a well-configured site and a deliberately bad one.
- `tests/sitescan-analysis.test.ts`: parser, DNS and grade unit tests.
- **End-to-end lab.** With `ORBIS_SITESCAN_LAB=<config.json>`, the server routes `*.test` hostnames (reserved,
  RFC 2606) to local lab servers, the lab CA and recorded DNS answers. This lets the real UI → API → ownership proof
  → scan → storage → export flow be exercised in a browser. The lab path is **disabled whenever `VERCEL` is set** and
  never applies to other hostnames.
