import "server-only";
import { header, headerList, safeRequest, type SafeResponse } from "./net";
import { fingerprint, maskSecret, type FindingDraft, type Severity, type Confidence } from "./types";

/**
 * Orbis Sentinel's checks. "passive" makes ordinary page requests only
 * (home page over https and http, security.txt). "active" also requests a
 * short list of sensitive paths and confirms exposure by their content.
 */
export type SentinelScope = "passive" | "active";

const REF = {
  hsts: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Strict-Transport-Security",
  csp: "https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP",
  headers: "https://owasp.org/www-project-secure-headers/",
  cookies: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Cookies#security",
  clickjacking: "https://cheatsheetseries.owasp.org/cheatsheets/Clickjacking_Defense_Cheat_Sheet.html",
  cors: "https://portswigger.net/web-security/cors",
  tls: "https://cheatsheetseries.owasp.org/cheatsheets/Transport_Layer_Security_Cheat_Sheet.html",
  securitytxt: "https://securitytxt.org/",
  exposure: "https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/02-Configuration_and_Deployment_Management_Testing/04-Review_Old_Backup_and_Unreferenced_Files_for_Sensitive_Information",
  mixed: "https://developer.mozilla.org/en-US/docs/Web/Security/Mixed_content",
};

export interface SentinelProgress {
  (step: string): void;
}

export interface SentinelResult {
  findings: FindingDraft[];
  /** Rule-id prefixes that were actually evaluated (used when re-checking). */
  checked: string[];
  requests: number;
  finalUrl: string | null;
  notes: string[];
}

type Draft = Omit<FindingDraft, "agent" | "fingerprint" | "asset" | "evidenceSource"> & { key?: string };

export async function runSentinel(
  host: string,
  scope: SentinelScope,
  opts: { signal?: AbortSignal; progress?: SentinelProgress; request?: typeof safeRequest; delayMs?: number } = {},
): Promise<SentinelResult> {
  const req = opts.request ?? safeRequest;
  const progress = opts.progress ?? (() => {});
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const drafts: Draft[] = [];
  const notes: string[] = [];
  const checked = ["transport.", "headers.", "cookies.", "cors.", "content.", "disclosure.", "policy."];
  let requests = 0;
  const get = async (url: string, extra?: Record<string, string>, maxBytes?: number) => {
    requests++;
    return req(url, { headers: extra, signal: opts.signal, maxBytes });
  };

  // 1. HTTPS and redirects
  progress("Connecting over HTTPS");
  let res: SafeResponse | null = null;
  let finalUrl = `https://${host}/`;
  try {
    res = await get(finalUrl, { origin: "https://orbis-cors-check.invalid" });
    for (let hop = 0; hop < 5 && res.status >= 300 && res.status < 400; hop++) {
      const loc = header(res, "location");
      if (!loc) break;
      const next = new URL(loc, finalUrl);
      const sameSite = next.hostname === host || next.hostname === `www.${host}` || `www.${next.hostname}` === host;
      if (!sameSite || next.protocol !== "https:") {
        notes.push(`The site redirects to ${next.origin}, which is outside the authorised target, so headers were checked on the redirect response itself.`);
        break;
      }
      finalUrl = next.toString();
      res = await get(finalUrl, { origin: "https://orbis-cors-check.invalid" });
    }
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    const code = (err as { code?: string }).code ?? "";
    if (/CERT|SSL|TLS|self.signed|unable to verify/i.test(code + msg)) {
      drafts.push({
        ruleId: "transport.tls-invalid",
        title: "HTTPS certificate is not trusted",
        description: "Browsers will show a security warning because the certificate could not be validated.",
        severity: "high",
        confidence: "confirmed",
        rationale: "Visitors can't safely tell the real site from an impostor, and many will click through warnings.",
        location: `https://${host}/`,
        evidence: [{ source: "TLS handshake", detail: `${code} ${msg}`.trim().slice(0, 300) }],
        remediation: "Install a valid certificate from a trusted authority (for example Let's Encrypt) that covers this hostname, and include the full certificate chain.",
        references: [REF.tls],
      });
    } else {
      notes.push(`HTTPS request failed: ${msg.slice(0, 200)}`);
    }
  }

  progress("Checking HTTP to HTTPS redirect");
  try {
    const plain = await get(`http://${host}/`);
    const loc = header(plain, "location") ?? "";
    if (plain.status >= 200 && plain.status < 300) {
      drafts.push({
        ruleId: "transport.no-https-redirect",
        title: "Plain HTTP is served without redirecting to HTTPS",
        description: "The site answers unencrypted HTTP requests with content instead of redirecting to HTTPS.",
        severity: "medium",
        confidence: "confirmed",
        rationale: "Anyone on the same network can read or alter pages loaded over HTTP.",
        location: `http://${host}/`,
        evidence: [{ source: "GET http:// response", detail: `HTTP ${plain.status}, no redirect` }],
        remediation: "Redirect all HTTP requests to HTTPS with a 301/308 and enable HSTS.",
        references: [REF.hsts],
      });
    } else if (plain.status >= 300 && plain.status < 400 && loc && !loc.startsWith("https://")) {
      drafts.push({
        ruleId: "transport.redirect-not-https",
        title: "HTTP redirects somewhere other than HTTPS",
        description: "The HTTP version of the site redirects, but not to an https:// address.",
        severity: "low",
        confidence: "confirmed",
        rationale: "Visitors may stay on an unencrypted connection.",
        location: `http://${host}/`,
        evidence: [{ source: "GET http:// response", detail: `HTTP ${plain.status} → ${loc.slice(0, 200)}` }],
        remediation: "Redirect HTTP requests directly to the https:// version of the same URL.",
        references: [REF.hsts],
      });
    }
  } catch {
    notes.push("Plain HTTP (port 80) did not answer; nothing to check there.");
  }

  if (res && res.status > 0) {
    progress("Reviewing security headers");
    drafts.push(...headerChecks(res, finalUrl));
    drafts.push(...cookieChecks(res, finalUrl));
    drafts.push(...corsChecks(res, finalUrl));
    drafts.push(...contentChecks(res, finalUrl));
  }

  progress("Looking for security.txt");
  try {
    const st = await get(`https://${host}/.well-known/security.txt`, undefined, 16 * 1024);
    if (!(st.status === 200 && /^\s*contact\s*:/im.test(st.body))) {
      drafts.push({
        ruleId: "policy.security-txt-missing",
        title: "No security.txt contact file",
        description: "There's no /.well-known/security.txt telling researchers how to report vulnerabilities.",
        severity: "info",
        confidence: "confirmed",
        rationale: "Not a vulnerability; it makes responsible disclosure easier.",
        location: `https://${host}/.well-known/security.txt`,
        evidence: [{ source: "GET /.well-known/security.txt", detail: `HTTP ${st.status}` }],
        remediation: "Publish a security.txt with at least a Contact and Expires field.",
        references: [REF.securitytxt],
      });
    }
  } catch {
    /* already reported connectivity problems */
  }

  if (scope === "active") {
    checked.push("exposure.");
    progress("Checking for exposed sensitive files");
    for (const probe of EXPOSURE_PROBES) {
      if (opts.signal?.aborted) break;
      try {
        const r = await get(`https://${host}${probe.path}`, undefined, 32 * 1024);
        const type = header(r, "content-type") ?? "";
        if (r.status === 200 && !/text\/html/i.test(type) && probe.match(r.body)) {
          drafts.push({
            ruleId: `exposure.${probe.id}`,
            title: probe.title,
            description: probe.description,
            severity: probe.severity,
            confidence: "confirmed",
            rationale: probe.rationale,
            location: `https://${host}${probe.path}`,
            evidence: [{ source: `GET ${probe.path}`, detail: `HTTP 200, ${type || "no content type"}. ${probe.evidence(r.body)}` }],
            remediation: probe.remediation,
            references: [REF.exposure],
          });
        }
      } catch {
        /* unreachable path: not exposed */
      }
      await delay(opts.delayMs ?? 250);
    }
  }

  const findings = drafts.map<FindingDraft>((d) => ({
    ...d,
    agent: "sentinel",
    asset: host,
    evidenceSource: d.ruleId.startsWith("exposure.") ? "orbis:exposure" : "orbis:headers",
    fingerprint: fingerprint("sentinel", d.ruleId, host, d.key ?? ""),
  }));
  return { findings, checked, requests, finalUrl: res ? finalUrl : null, notes };
}

function headerChecks(res: SafeResponse, url: string): Draft[] {
  const out: Draft[] = [];
  const ev = (name: string) => ({ source: `Response headers of ${url}`, detail: `${name}: ${header(res, name) ?? "(not set)"}` });
  const isHttps = url.startsWith("https:");
  const hsts = header(res, "strict-transport-security");
  if (isHttps && !hsts) {
    out.push({
      ruleId: "headers.hsts-missing",
      title: "Strict-Transport-Security (HSTS) header is missing",
      description: "Without HSTS, browsers may still try plain HTTP first, which allows downgrade attacks on hostile networks.",
      severity: "medium",
      confidence: "confirmed",
      rationale: "Exploitation needs a network-positioned attacker, but the fix is one header.",
      location: url,
      evidence: [ev("strict-transport-security")],
      remediation: "Send `Strict-Transport-Security: max-age=63072000; includeSubDomains` (add `preload` once all subdomains are HTTPS).",
      references: [REF.hsts],
    });
  } else if (hsts) {
    const age = Number(/max-age=(\d+)/i.exec(hsts)?.[1] ?? 0);
    if (age < 15552000) {
      out.push({
        ruleId: "headers.hsts-short",
        title: "HSTS max-age is shorter than six months",
        description: `max-age is ${age} seconds, so browsers forget the HTTPS-only rule quickly.`,
        severity: "low",
        confidence: "confirmed",
        rationale: "Shorter protection windows leave more room for downgrade attacks.",
        location: url,
        evidence: [ev("strict-transport-security")],
        remediation: "Use max-age of at least 15552000 (180 days); 63072000 (2 years) is common.",
        references: [REF.hsts],
      });
    }
  }

  const csp = header(res, "content-security-policy");
  const cspRo = header(res, "content-security-policy-report-only");
  if (!csp) {
    out.push({
      ruleId: "headers.csp-missing",
      title: cspRo ? "Content Security Policy is report-only" : "Content-Security-Policy header is missing",
      description: cspRo
        ? "A CSP is configured in report-only mode, so it logs violations but does not block injected scripts."
        : "No CSP limits where scripts can load from, so any cross-site scripting bug is easier to exploit.",
      severity: cspRo ? "low" : "medium",
      confidence: "confirmed",
      rationale: "A CSP is defence in depth against XSS; its absence is not itself an exploitable bug.",
      location: url,
      evidence: [ev(cspRo ? "content-security-policy-report-only" : "content-security-policy")],
      remediation: "Add a Content-Security-Policy, starting from `default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'` and adding sources your site needs.",
      references: [REF.csp],
    });
  } else {
    const directive = (name: string) => new RegExp(`(?:^|;)\\s*${name}\\s+([^;]*)`, "i").exec(csp)?.[1] ?? null;
    const scripts = directive("script-src") ?? directive("default-src") ?? "";
    if (/'unsafe-inline'/.test(scripts) && !/'nonce-|'sha(256|384|512)-|'strict-dynamic'/.test(scripts)) {
      out.push({
        ruleId: "headers.csp-unsafe-inline",
        title: "CSP allows inline scripts ('unsafe-inline')",
        description: "The policy permits inline <script> blocks and event handlers, which is what most XSS payloads use.",
        severity: "low",
        confidence: "confirmed",
        rationale: "Weakens the CSP's protection against XSS; not a vulnerability on its own.",
        location: url,
        evidence: [ev("content-security-policy")],
        remediation: "Replace 'unsafe-inline' with nonces or hashes (most frameworks can generate nonces).",
        references: [REF.csp],
      });
    }
    if (/(^|\s)(\*|https?:|data:)(\s|$)/.test(scripts)) {
      out.push({
        ruleId: "headers.csp-wildcard-scripts",
        title: "CSP lets scripts load from any host",
        description: "script-src (or default-src) contains a wildcard or a whole scheme, so attackers can load scripts from servers they control.",
        severity: "medium",
        confidence: "confirmed",
        rationale: "Largely cancels the CSP's protection against XSS.",
        location: url,
        evidence: [ev("content-security-policy")],
        remediation: "List the specific hosts scripts may come from instead of *, http:, https: or data:.",
        references: [REF.csp],
      });
    }
  }

  const frameAncestors = /frame-ancestors/i.test(csp ?? "");
  if (!header(res, "x-frame-options") && !frameAncestors) {
    out.push({
      ruleId: "headers.clickjacking",
      title: "Page can be embedded in other sites (clickjacking)",
      description: "Neither X-Frame-Options nor CSP frame-ancestors is set, so other websites can frame this page and trick users into clicking.",
      severity: "medium",
      confidence: "confirmed",
      rationale: "Matters most for pages with sign-in or account actions.",
      location: url,
      evidence: [ev("x-frame-options")],
      remediation: "Send `X-Frame-Options: DENY` (or SAMEORIGIN), or `frame-ancestors 'self'` in the CSP.",
      references: [REF.clickjacking],
    });
  }
  if ((header(res, "x-content-type-options") ?? "").toLowerCase() !== "nosniff") {
    out.push({
      ruleId: "headers.nosniff-missing",
      title: "X-Content-Type-Options: nosniff is missing",
      description: "Browsers may guess content types, which can turn uploaded files into executable scripts.",
      severity: "low",
      confidence: "confirmed",
      rationale: "Defence in depth; exploitation needs another weakness such as user uploads.",
      location: url,
      evidence: [ev("x-content-type-options")],
      remediation: "Send `X-Content-Type-Options: nosniff` on all responses.",
      references: [REF.headers],
    });
  }
  if (!header(res, "referrer-policy")) {
    out.push({
      ruleId: "headers.referrer-policy-missing",
      title: "Referrer-Policy header is not set",
      description: "Modern browsers default to a safe policy, but older ones may leak full URLs (including tokens in query strings) to other sites.",
      severity: "info",
      confidence: "confirmed",
      rationale: "Current browsers already default to strict-origin-when-cross-origin.",
      location: url,
      evidence: [ev("referrer-policy")],
      remediation: "Send `Referrer-Policy: strict-origin-when-cross-origin`.",
      references: [REF.headers],
    });
  }
  const server = header(res, "server");
  const powered = header(res, "x-powered-by");
  if ((server && /\d/.test(server)) || powered) {
    out.push({
      ruleId: "disclosure.version-headers",
      title: "Server software version is disclosed",
      description: "Response headers reveal software names or versions, which helps attackers find matching exploits.",
      severity: "low",
      confidence: "confirmed",
      rationale: "Information only; it doesn't create a vulnerability but speeds up targeting.",
      location: url,
      evidence: [server && /\d/.test(server) ? ev("server") : null, powered ? ev("x-powered-by") : null].filter(Boolean) as { source: string; detail: string }[],
      remediation: "Remove X-Powered-By and version numbers from the Server header in your web server or framework settings.",
      references: [REF.headers],
    });
  }
  return out;
}

const SESSIONISH = /sess|sid|token|auth|jwt|login|remember/i;

function cookieChecks(res: SafeResponse, url: string): Draft[] {
  const out: Draft[] = [];
  for (const raw of headerList(res, "set-cookie")) {
    const name = raw.split("=")[0]!.trim();
    const attrs = raw.toLowerCase();
    const sensitive = SESSIONISH.test(name);
    const problems: string[] = [];
    if (url.startsWith("https:") && !/;\s*secure/.test(attrs)) problems.push("Secure");
    if (sensitive && !/;\s*httponly/.test(attrs)) problems.push("HttpOnly");
    if (!/;\s*samesite=/.test(attrs)) problems.push("SameSite");
    if (!problems.length) continue;
    const masked = raw.replace(/=([^;]*)/, (_, v: string) => `=${maskSecret(v)}`);
    out.push({
      key: name,
      ruleId: "cookies.flags",
      title: `Cookie "${name}" is missing ${problems.join(", ")}`,
      description: `The cookie is set without ${problems.join(", ")}. ${problems.includes("Secure") ? "It can be sent over plain HTTP. " : ""}${problems.includes("HttpOnly") ? "Scripts (including injected ones) can read it. " : ""}${problems.includes("SameSite") ? "Browsers apply their default cross-site rules." : ""}`,
      severity: sensitive && (problems.includes("Secure") || problems.includes("HttpOnly")) ? "medium" : "low",
      confidence: sensitive ? "firm" : "tentative",
      rationale: sensitive ? "The name suggests a session or authentication cookie." : "The name doesn't look like a session cookie, so impact is likely low.",
      location: url,
      evidence: [{ source: `Set-Cookie on ${url}`, detail: masked.slice(0, 300) }],
      remediation: "Set cookies with `Secure; HttpOnly; SameSite=Lax` (or Strict) unless scripts genuinely need to read them.",
      references: [REF.cookies],
    });
  }
  return out;
}

function corsChecks(res: SafeResponse, url: string): Draft[] {
  const acao = header(res, "access-control-allow-origin");
  const acac = (header(res, "access-control-allow-credentials") ?? "").toLowerCase() === "true";
  if (acao === "https://orbis-cors-check.invalid") {
    return [
      {
        ruleId: "cors.reflected-origin",
        title: acac ? "CORS reflects any origin and allows credentials" : "CORS reflects any origin",
        description: acac
          ? "The server echoes back whatever Origin it receives and allows cookies, so any website can read signed-in users' responses."
          : "The server echoes back whatever Origin it receives. Without credentials this exposes only public data, but it often indicates a permissive configuration.",
        severity: acac ? "high" : "low",
        confidence: "confirmed",
        rationale: acac ? "Allows cross-site reading of authenticated data." : "No credentials, so impact is limited to data that is already public.",
        location: url,
        evidence: [{ source: "Request with Origin: https://orbis-cors-check.invalid", detail: `access-control-allow-origin: ${acao}; access-control-allow-credentials: ${acac}` }],
        remediation: "Only allow specific, trusted origins from an allow-list; never reflect the Origin header blindly with credentials.",
        references: [REF.cors],
      },
    ];
  }
  return [];
}

function contentChecks(res: SafeResponse, url: string): Draft[] {
  if (!url.startsWith("https:") || !/text\/html/i.test(header(res, "content-type") ?? "")) return [];
  const m = /<script[^>]+src=["']http:\/\/[^"']+["']/i.exec(res.body);
  if (!m) return [];
  return [
    {
      ruleId: "content.mixed-scripts",
      title: "HTTPS page loads a script over plain HTTP",
      description: "A script is referenced with an http:// URL. Browsers block it, and if they didn't, a network attacker could replace it.",
      severity: "medium",
      confidence: "confirmed",
      rationale: "Breaks functionality today and is a script-injection risk on older clients.",
      location: url,
      evidence: [{ source: `HTML of ${url}`, detail: m[0].slice(0, 300) }],
      remediation: "Load the script over https:// or host it yourself.",
      references: [REF.mixed],
    },
  ];
}

interface Probe {
  id: string;
  path: string;
  title: string;
  description: string;
  severity: Severity;
  rationale: string;
  remediation: string;
  match: (body: string) => boolean;
  evidence: (body: string) => string;
}

const firstLine = (b: string) => `Starts with: "${b.split("\n")[0]!.slice(0, 60)}"`;

const EXPOSURE_PROBES: Probe[] = [
  {
    id: "env-file",
    path: "/.env",
    title: "Environment file (.env) is publicly downloadable",
    description: "The site serves its .env file, which usually contains database passwords and API keys.",
    severity: "critical",
    rationale: "Secrets in the file can give direct access to databases and paid services.",
    remediation: "Block access to dotfiles in the web server, move .env outside the public directory, and rotate every secret it contained.",
    match: (b) => /^[A-Z][A-Z0-9_]{2,}\s*=/m.test(b),
    evidence: (b) => `Variable names found: ${[...b.matchAll(/^([A-Z][A-Z0-9_]{2,})\s*=/gm)].map((m) => m[1]).slice(0, 8).join(", ")} (values not shown).`,
  },
  {
    id: "git-head",
    path: "/.git/HEAD",
    title: "Git repository metadata is exposed",
    description: "The .git directory is served, so attackers can often reconstruct your source code and its history.",
    severity: "high",
    rationale: "Source code and past commits frequently contain secrets.",
    remediation: "Deny access to /.git in the web server and don't deploy the .git directory.",
    match: (b) => /^ref: refs\//.test(b.trim()),
    evidence: firstLine,
  },
  {
    id: "git-config",
    path: "/.git/config",
    title: "Git configuration is exposed",
    description: "The .git/config file is served, which confirms the repository is downloadable and may reveal remote URLs.",
    severity: "high",
    rationale: "Indicates the whole repository can likely be downloaded.",
    remediation: "Deny access to /.git in the web server and don't deploy the .git directory.",
    match: (b) => /\[core\]/.test(b),
    evidence: () => "Contains a [core] section.",
  },
  {
    id: "aws-credentials",
    path: "/.aws/credentials",
    title: "AWS credentials file is exposed",
    description: "An AWS credentials file is downloadable.",
    severity: "critical",
    rationale: "Grants access to your AWS account.",
    remediation: "Remove the file from the web root immediately and rotate the AWS keys.",
    match: (b) => /aws_access_key_id/i.test(b),
    evidence: () => "Contains aws_access_key_id (value not shown).",
  },
  {
    id: "config-backup",
    path: "/wp-config.php.bak",
    title: "Configuration backup is exposed",
    description: "A backup of wp-config.php is served as plain text, revealing database credentials.",
    severity: "critical",
    rationale: "Database credentials allow full data access.",
    remediation: "Delete backup files from the web root and rotate the database password.",
    match: (b) => /DB_PASSWORD|<\?php/.test(b),
    evidence: () => "Contains PHP source or DB_PASSWORD (values not shown).",
  },
  {
    id: "sql-dump",
    path: "/backup.sql",
    title: "Database dump is exposed",
    description: "A SQL dump is downloadable from the site.",
    severity: "high",
    rationale: "Likely contains user data.",
    remediation: "Remove database dumps from the web root and review what data was exposed.",
    match: (b) => /(CREATE TABLE|INSERT INTO)/i.test(b),
    evidence: () => "Contains SQL statements.",
  },
  {
    id: "server-status",
    path: "/server-status",
    title: "Apache server-status page is public",
    description: "The server-status page reveals live requests, client IPs and internal URLs.",
    severity: "medium",
    rationale: "Leaks visitors' data and internal paths.",
    remediation: "Restrict mod_status to localhost or remove it.",
    match: (b) => /Apache Server Status/i.test(b),
    evidence: () => 'Contains "Apache Server Status".',
  },
  {
    id: "ds-store",
    path: "/.DS_Store",
    title: ".DS_Store file is exposed",
    description: "A macOS folder index is served, which lists file names in the directory.",
    severity: "low",
    rationale: "Reveals file names that may point to unlinked content.",
    remediation: "Delete .DS_Store files from deployments and block dotfiles.",
    match: (b) => b.includes("Bud1"),
    evidence: () => "Contains a Bud1 signature.",
  },
];

export const EXPOSURE_PATHS = EXPOSURE_PROBES.map((p) => p.path);
export type { Confidence };
