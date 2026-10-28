/**
 * HTTP-level checks for the website scan: HTTPS redirect, security headers, cookies, mixed content, information
 * disclosure, error pages and CORS. Pure functions over recorded responses (no network), so they're testable.
 * Headers are parsed by their specifications' grammar (HSTS: RFC 6797 §6.1, CSP: CSP3 §2.2.1, Set-Cookie: RFC 6265
 * via the `cookie` package); HTML is parsed with parse5 (the HTML5 parsing algorithm), not pattern-matched.
 */
import { parseSetCookie } from "cookie";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { check, type CheckResult, type Evidence } from "./types";

export interface HttpResponse {
  url: string;
  status: number;
  headers: Record<string, string | string[]>;
  body: string;
  truncated: boolean;
}

const REF = {
  hsts: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Strict-Transport-Security",
  csp: "https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP",
  xcto: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/X-Content-Type-Options",
  frame: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/frame-ancestors",
  referrer: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Referrer-Policy",
  cookies: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Cookies#security",
  mixed: "https://developer.mozilla.org/en-US/docs/Web/Security/Mixed_content",
  cors: "https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS",
  owaspHeaders: "https://owasp.org/www-project-secure-headers/",
  securitytxt: "https://www.rfc-editor.org/rfc/rfc9116",
};

export function headerValue(res: HttpResponse, name: string): string | null {
  const v = res.headers[name.toLowerCase()];
  if (v === undefined) return null;
  return Array.isArray(v) ? v.join(", ") : v;
}
const headerValues = (res: HttpResponse, name: string): string[] => {
  const v = res.headers[name.toLowerCase()];
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
};
const clip = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n)}…` : s);

/* ---------------------------------------------------------------- transport */

export interface TransportEvidence {
  host: string;
  /** The final HTTPS response after same-site redirects, or the error that stopped it. */
  https: { ok: true; res: HttpResponse; chain: string[] } | { ok: false; error: string };
  /** GET http://host/ (port 80). */
  http: { ok: true; res: HttpResponse } | { ok: false; error: string };
}

export function analyseTransport(e: TransportEvidence): CheckResult[] {
  const out: CheckResult[] = [];
  out.push(
    e.https.ok
      ? check({ id: "https.available", category: "server", title: "Website loads over HTTPS", status: "passed", severity: "critical", summary: `https://${e.host}/ answered HTTP ${e.https.res.status}${e.https.chain.length > 1 ? ` after ${e.https.chain.length - 1} redirect(s)` : ""}.`, evidence: e.https.chain.map((u, i) => ({ label: i ? `Redirect ${i}` : "Requested", value: u })) })
      : check({ id: "https.available", category: "server", title: "Website loads over HTTPS", status: "inconclusive", severity: "critical", summary: `The HTTPS page couldn't be loaded: ${clip(e.https.error, 200)}. HTTP checks below that need it were skipped.` }),
  );
  if (!e.http.ok) {
    out.push(check({ id: "http.redirect", category: "server", title: "HTTP redirects to HTTPS", status: "info", severity: "medium", summary: `Plain HTTP (port 80) didn't answer (${clip(e.http.error, 120)}). Nothing is served unencrypted, but visitors who type http:// get an error instead of a redirect.` }));
    return out;
  }
  const r = e.http.res;
  const loc = headerValue(r, "location") ?? "";
  const ev: Evidence[] = [{ label: `GET http://${e.host}/`, value: `HTTP ${r.status}${loc ? ` → ${clip(loc, 200)}` : ""}` }];
  if (r.status >= 300 && r.status < 400 && loc) {
    let target: URL | null = null;
    try {
      target = new URL(loc, `http://${e.host}/`);
    } catch {
      /* invalid Location */
    }
    if (target?.protocol === "https:")
      out.push(check({ id: "http.redirect", category: "server", title: "HTTP redirects to HTTPS", status: "passed", severity: "medium", summary: `HTTP requests are redirected to HTTPS (${r.status}${r.status === 301 || r.status === 308 ? ", permanent" : ", temporary"}).`, evidence: ev }));
    else out.push(check({ id: "http.redirect", category: "server", title: "HTTP redirects to HTTPS", status: "failed", severity: "low", summary: "HTTP redirects, but not to an https:// address.", evidence: ev, remediation: "Redirect every http:// request straight to the https:// version of the same URL (301 or 308).", references: [REF.hsts] }));
  } else if (r.status >= 200 && r.status < 300)
    out.push(check({ id: "http.redirect", category: "server", title: "HTTP redirects to HTTPS", status: "failed", severity: "medium", summary: "The site serves content over plain HTTP instead of redirecting to HTTPS; anyone on the network can read or change those pages.", evidence: ev, remediation: "Redirect all HTTP requests to HTTPS with a 301/308 and enable HSTS.", references: [REF.hsts] }));
  else out.push(check({ id: "http.redirect", category: "server", title: "HTTP redirects to HTTPS", status: "inconclusive", severity: "medium", summary: `HTTP answered ${r.status} without a redirect; couldn't tell how visitors on http:// are treated.`, evidence: ev }));
  return out;
}

/* ---------------------------------------------------------------- headers */

export interface Hsts {
  maxAge: number | null;
  includeSubDomains: boolean;
  preload: boolean;
}

/** RFC 6797 §6.1: directives separated by ";", name[=value], case-insensitive names, quoted values allowed. */
export function parseHsts(v: string): Hsts {
  const out: Hsts = { maxAge: null, includeSubDomains: false, preload: false };
  // Several headers are joined with ", "; browsers use the first one.
  for (const part of v.split(",")[0]!.split(";")) {
    const [rawName, ...rest] = part.split("=");
    const name = rawName!.trim().toLowerCase();
    const value = rest.join("=").trim().replace(/^"(.*)"$/, "$1");
    if (name === "max-age" && /^\d+$/.test(value)) out.maxAge = Number(value);
    if (name === "includesubdomains") out.includeSubDomains = true;
    if (name === "preload") out.preload = true;
  }
  return out;
}

/** CSP3 §2.2.1: policies separated by ",", directives by ";", tokens by ASCII whitespace; the first directive of a name wins. */
export function parseCsp(v: string): Map<string, string[]>[] {
  return v
    .split(",")
    .map((policy) => {
      const m = new Map<string, string[]>();
      for (const d of policy.split(";")) {
        const tokens = d.trim().split(/[\t\n\f\r ]+/).filter(Boolean);
        if (!tokens.length) continue;
        const name = tokens[0]!.toLowerCase();
        if (!m.has(name)) m.set(name, tokens.slice(1));
      }
      return m;
    })
    .filter((m) => m.size);
}

const HALF_YEAR = 15_552_000;

export function analyseHeaders(res: HttpResponse, opts: { metaCsp?: string | null } = {}): CheckResult[] {
  const out: CheckResult[] = [];
  const at = { label: "Response", value: `${res.url} (HTTP ${res.status})` };

  // HSTS
  const hstsRaw = headerValue(res, "strict-transport-security");
  if (!hstsRaw)
    out.push(check({ id: "headers.hsts", category: "headers", title: "HTTP Strict Transport Security (HSTS)", status: "failed", severity: "medium", summary: "No Strict-Transport-Security header: browsers will still try http:// first, which a network attacker can intercept.", evidence: [at], remediation: 'Send "Strict-Transport-Security: max-age=31536000; includeSubDomains" on HTTPS responses (add "preload" once every subdomain is HTTPS).', references: [REF.hsts] }));
  else {
    const h = parseHsts(hstsRaw);
    const ev = [{ label: "Strict-Transport-Security", value: clip(hstsRaw) }];
    if (h.maxAge === null || h.maxAge === 0)
      out.push(check({ id: "headers.hsts", category: "headers", title: "HTTP Strict Transport Security (HSTS)", status: "failed", severity: "medium", summary: h.maxAge === 0 ? "HSTS is switched off (max-age=0)." : "The HSTS header has no valid max-age, so browsers ignore it.", evidence: ev, remediation: "Use max-age=31536000 (one year).", references: [REF.hsts] }));
    else if (h.maxAge < HALF_YEAR)
      out.push(check({ id: "headers.hsts", category: "headers", title: "HTTP Strict Transport Security (HSTS)", status: "warning", severity: "low", summary: `HSTS is on, but max-age is only ${Math.round(h.maxAge / 86400)} days; at least 180 days is recommended.`, evidence: ev, remediation: "Raise max-age to 31536000 (one year) once you're sure HTTPS works everywhere.", references: [REF.hsts] }));
    else
      out.push(check({ id: "headers.hsts", category: "headers", title: "HTTP Strict Transport Security (HSTS)", status: "passed", severity: "medium", summary: `HSTS for ${Math.round(h.maxAge / 86400)} days${h.includeSubDomains ? ", including subdomains" : ""}${h.preload ? ", preload requested" : ""}.`, evidence: ev }));
  }

  // CSP
  const cspRaw = headerValue(res, "content-security-policy");
  const reportOnly = headerValue(res, "content-security-policy-report-only");
  const cspSource = cspRaw ?? opts.metaCsp ?? null;
  if (!cspSource)
    out.push(check({ id: "headers.csp", category: "headers", title: "Content Security Policy", status: reportOnly ? "warning" : "failed", severity: reportOnly ? "low" : "medium", summary: reportOnly ? "A CSP is set in report-only mode, so it doesn't block anything yet." : "No Content-Security-Policy: if an attacker can inject HTML, nothing limits which scripts run.", evidence: reportOnly ? [{ label: "Content-Security-Policy-Report-Only", value: clip(reportOnly) }] : [at], remediation: "Add a Content-Security-Policy. Start with default-src 'self'; script-src 'self' (plus the hosts you need); object-src 'none'; base-uri 'self'; frame-ancestors 'self'. Test in report-only mode first.", references: [REF.csp] }));
  else {
    // Every policy applies (a script must be allowed by all of them), so a weakness only counts when each policy that
    // restricts scripts has it, and objects are open only when no policy restricts them.
    const policies = parseCsp(cspSource);
    const issues: string[] = [];
    const scriptLists = policies.map((p) => p.get("script-src") ?? p.get("default-src")).filter((x): x is string[] => !!x);
    if (!scriptLists.length) issues.push("no script-src or default-src, so scripts from anywhere are allowed");
    else {
      const weak = scriptLists.map((scripts) => {
        const nonceOrHash = scripts.some((t) => /^'(nonce-|sha(256|384|512)-)/i.test(t));
        const strictDynamic = scripts.includes("'strict-dynamic'");
        const wild = scripts.filter((t) => t === "*" || /^(https?|data):$/i.test(t));
        return {
          inline: scripts.includes("'unsafe-inline'") && !nonceOrHash && !strictDynamic,
          evalOk: scripts.includes("'unsafe-eval'"),
          wild: wild.length && !strictDynamic ? wild : null,
        };
      });
      if (weak.every((w) => w.inline)) issues.push("'unsafe-inline' scripts are allowed, which defeats most of CSP's protection against injected scripts");
      if (weak.every((w) => w.evalOk)) issues.push("'unsafe-eval' is allowed");
      if (weak.every((w) => w.wild)) issues.push(`script sources include ${weak[0]!.wild!.join(" ")}, which allows scripts from any host`);
    }
    if (!policies.some((p) => p.has("object-src") || (p.get("default-src") ?? []).includes("'none'"))) issues.push("no object-src (plugins fall back to default-src)");
    const ev = [{ label: cspRaw ? "Content-Security-Policy" : "CSP (meta tag)", value: clip(cspSource, 600) }];
    out.push(
      issues.length
        ? check({ id: "headers.csp", category: "headers", title: "Content Security Policy", status: "warning", severity: "low", summary: `A CSP is set, but ${issues.join("; ")}.`, evidence: ev, remediation: "Replace 'unsafe-inline' with nonces or hashes (or 'strict-dynamic'), drop 'unsafe-eval' and broad sources, and add object-src 'none'.", references: [REF.csp] })
        : check({ id: "headers.csp", category: "headers", title: "Content Security Policy", status: "passed", severity: "medium", summary: `A Content-Security-Policy restricts script sources${cspRaw ? "" : " (set in a <meta> tag; frame-ancestors doesn't work there)"}.`, evidence: ev }),
    );
  }

  // X-Content-Type-Options
  const xcto = headerValue(res, "x-content-type-options");
  out.push(
    xcto?.trim().toLowerCase() === "nosniff"
      ? check({ id: "headers.xcto", category: "headers", title: "X-Content-Type-Options", status: "passed", severity: "low", summary: "nosniff is set." })
      : check({ id: "headers.xcto", category: "headers", title: "X-Content-Type-Options", status: "failed", severity: "low", summary: xcto ? `Set to "${clip(xcto, 60)}" instead of nosniff.` : "Missing: browsers may guess (sniff) content types, e.g. run an uploaded file as a script.", evidence: [at], remediation: 'Send "X-Content-Type-Options: nosniff".', references: [REF.xcto] }),
  );

  // Clickjacking: frame-ancestors (only from a header) or X-Frame-Options
  const fa = cspRaw ? parseCsp(cspRaw).find((p) => p.has("frame-ancestors"))?.get("frame-ancestors") : undefined;
  const xfo = headerValue(res, "x-frame-options")?.trim().toUpperCase() ?? null;
  const faOk = fa && !fa.includes("*") && !fa.some((t) => /^https?:$/i.test(t));
  if (faOk || xfo === "DENY" || xfo === "SAMEORIGIN")
    out.push(check({ id: "headers.clickjacking", category: "headers", title: "Clickjacking protection", status: "passed", severity: "medium", summary: faOk ? `Framing is limited by CSP frame-ancestors ${fa!.join(" ")}.` : `X-Frame-Options: ${xfo}.`, evidence: [{ label: faOk ? "frame-ancestors" : "X-Frame-Options", value: faOk ? fa!.join(" ") : xfo! }] }));
  else
    out.push(
      check({
        id: "headers.clickjacking",
        category: "headers",
        title: "Clickjacking protection",
        status: "failed",
        severity: "medium",
        summary: xfo ? `X-Frame-Options is "${clip(xfo, 60)}", which modern browsers don't honour, and there's no frame-ancestors.` : "Any site can embed this page in a frame and trick visitors into clicking on it.",
        evidence: [at],
        remediation: "Add frame-ancestors 'self' to the CSP header (and X-Frame-Options: SAMEORIGIN for older browsers).",
        references: [REF.frame],
      }),
    );

  // Referrer-Policy
  const rp = headerValue(res, "referrer-policy");
  const rpLast = rp?.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).at(-1) ?? null;
  if (!rp) out.push(check({ id: "headers.referrer", category: "headers", title: "Referrer-Policy", status: "info", severity: "low", summary: "Not set; current browsers default to strict-origin-when-cross-origin, which is reasonable. Setting it explicitly protects older browsers.", remediation: 'Send "Referrer-Policy: strict-origin-when-cross-origin".', references: [REF.referrer] }));
  else if (rpLast === "unsafe-url" || rpLast === "no-referrer-when-downgrade")
    out.push(check({ id: "headers.referrer", category: "headers", title: "Referrer-Policy", status: "warning", severity: "low", summary: `"${rpLast}" sends full URLs (including paths and query strings) to other sites.`, evidence: [{ label: "Referrer-Policy", value: clip(rp) }], remediation: 'Use "strict-origin-when-cross-origin" or stricter.', references: [REF.referrer] }));
  else out.push(check({ id: "headers.referrer", category: "headers", title: "Referrer-Policy", status: "passed", severity: "low", summary: `${rpLast}.`, evidence: [{ label: "Referrer-Policy", value: clip(rp) }] }));

  const pp = headerValue(res, "permissions-policy");
  out.push(check({ id: "headers.permissions-policy", category: "headers", title: "Permissions-Policy", status: pp ? "passed" : "info", severity: "info", summary: pp ? "Set; it limits which browser features (camera, geolocation, …) pages and frames may use." : "Not set. Optional: it limits which browser features embedded content may use.", evidence: pp ? [{ label: "Permissions-Policy", value: clip(pp) }] : [], references: [REF.owaspHeaders] }));
  const coop = headerValue(res, "cross-origin-opener-policy");
  out.push(check({ id: "headers.coop", category: "headers", title: "Cross-Origin-Opener-Policy", status: coop ? "passed" : "info", severity: "info", summary: coop ? `${clip(coop, 60)}.` : "Not set. Optional: same-origin isolates the page from windows it opens or that open it.", references: [REF.owaspHeaders] }));
  return out;
}

/* ---------------------------------------------------------------- cookies */

const SESSIONISH = /sess|sid|token|auth|jwt|login|remember|csrf|xsrf/i;

export function analyseCookies(responses: HttpResponse[]): CheckResult[] {
  const cookies = responses.flatMap((r) => headerValues(r, "set-cookie").map((raw) => ({ url: r.url, c: parseSetCookie(raw) })));
  const unique = cookies.filter((x, i) => cookies.findIndex((y) => y.c.name === x.c.name) === i);
  if (!unique.length) return [check({ id: "cookies.none", category: "cookies", title: "Cookies", status: "info", severity: "info", summary: "The pages loaded set no cookies (cookies set after signing in or by scripts weren't checked)." })];
  const names = (xs: typeof unique) => xs.map((x) => x.c.name).join(", ");
  const https = unique.filter((x) => x.url.startsWith("https:"));
  const out: CheckResult[] = [];

  const noSecure = https.filter((x) => !x.c.secure);
  const sensitiveNoSecure = noSecure.filter((x) => SESSIONISH.test(x.c.name));
  out.push(
    noSecure.length
      ? check({ id: "cookies.secure", category: "cookies", title: "Cookies use the Secure flag", status: "failed", severity: sensitiveNoSecure.length ? "medium" : "low", summary: `${noSecure.length} cookie${noSecure.length === 1 ? "" : "s"} without Secure can be sent over plain HTTP: ${names(noSecure)}.`, evidence: noSecure.map((x) => ({ label: x.c.name, value: `set by ${x.url}; value not shown` })), remediation: "Add the Secure attribute to every cookie set by an HTTPS site.", references: [REF.cookies] })
      : check({ id: "cookies.secure", category: "cookies", title: "Cookies use the Secure flag", status: "passed", severity: "medium", summary: `All ${unique.length} cookie${unique.length === 1 ? "" : "s"} are Secure.` }),
  );
  const sessionish = unique.filter((x) => SESSIONISH.test(x.c.name));
  const noHttpOnly = sessionish.filter((x) => !x.c.httpOnly);
  out.push(
    !sessionish.length
      ? check({ id: "cookies.httponly", category: "cookies", title: "Session cookies are HttpOnly", status: "info", severity: "medium", summary: `No cookie looks like a session cookie by name (${names(unique)}); HttpOnly wasn't judged.` })
      : noHttpOnly.length
        ? check({ id: "cookies.httponly", category: "cookies", title: "Session cookies are HttpOnly", status: "failed", severity: "medium", confirmed: false, summary: `${names(noHttpOnly)} look${noHttpOnly.length === 1 ? "s" : ""} like session or security cookie${noHttpOnly.length === 1 ? "" : "s"} (judged by name) and can be read by JavaScript, so an XSS bug could steal ${noHttpOnly.length === 1 ? "it" : "them"}.`, evidence: noHttpOnly.map((x) => ({ label: x.c.name, value: "no HttpOnly; value not shown" })), remediation: "Set HttpOnly on session cookies (CSRF tokens read by your own scripts are the usual exception).", references: [REF.cookies] })
        : check({ id: "cookies.httponly", category: "cookies", title: "Session cookies are HttpOnly", status: "passed", severity: "medium", summary: `${names(sessionish)}: HttpOnly.` }),
  );
  const noneInsecure = unique.filter((x) => x.c.sameSite === "none" && !x.c.secure);
  const noSameSite = unique.filter((x) => !x.c.sameSite);
  out.push(
    noneInsecure.length
      ? check({ id: "cookies.samesite", category: "cookies", title: "SameSite attribute", status: "failed", severity: "low", summary: `SameSite=None without Secure is rejected by browsers: ${names(noneInsecure)}.`, remediation: "Add Secure to SameSite=None cookies, or use SameSite=Lax.", references: [REF.cookies] })
      : noSameSite.length
        ? check({ id: "cookies.samesite", category: "cookies", title: "SameSite attribute", status: "warning", severity: "low", summary: `No SameSite on ${names(noSameSite)}; most browsers then treat them as Lax, but not all do.`, remediation: "Set SameSite=Lax (or Strict) explicitly.", references: [REF.cookies] })
        : check({ id: "cookies.samesite", category: "cookies", title: "SameSite attribute", status: "passed", severity: "low", summary: "Every cookie sets SameSite." }),
  );
  return out;
}

/* ---------------------------------------------------------------- HTML content */

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

const ACTIVE: Record<string, string> = { script: "src", iframe: "src", frame: "src", object: "data", embed: "src" };
const PASSIVE: Record<string, string> = { img: "src", audio: "src", video: "src", source: "src", track: "src" };

export interface PageFacts {
  isHtml: boolean;
  metaCsp: string | null;
  activeMixed: { tag: string; url: string }[];
  passiveMixed: { tag: string; url: string }[];
  insecureForms: string[];
  thirdPartyScripts: { url: string; integrity: boolean }[];
  directoryListing: boolean;
}

/** Walk the parsed document once and collect what the checks need. */
export function pageFacts(res: HttpResponse): PageFacts {
  const facts: PageFacts = { isHtml: false, metaCsp: null, activeMixed: [], passiveMixed: [], insecureForms: [], thirdPartyScripts: [], directoryListing: false };
  if (!/text\/html|application\/xhtml/i.test(headerValue(res, "content-type") ?? "") || !res.body) return facts;
  facts.isHtml = true;
  const base = new URL(res.url);
  const resolve = (v: string) => {
    try {
      return new URL(v.trim(), base);
    } catch {
      return null;
    }
  };
  const doc = parse(res.body);
  const stack: Node[] = [doc as unknown as Node];
  let title = "";
  while (stack.length) {
    const n = stack.pop()!;
    if ("childNodes" in n && n.childNodes) stack.push(...n.childNodes);
    if ("content" in n && (n as { content?: Node }).content) stack.push((n as unknown as { content: Node }).content);
    if (!("tagName" in n)) continue;
    const el = n as Element;
    const attr = (name: string) => el.attrs.find((a) => a.name === name)?.value ?? null;
    const tag = el.tagName;
    if (tag === "title") title = el.childNodes.map((c) => ("value" in c ? (c as { value: string }).value : "")).join("");
    if (tag === "meta" && attr("http-equiv")?.toLowerCase() === "content-security-policy") facts.metaCsp = attr("content");
    const linkRel = tag === "link" ? (attr("rel") ?? "").toLowerCase().split(/\s+/) : [];
    const activeAttr = ACTIVE[tag] ?? (linkRel.includes("stylesheet") || linkRel.includes("modulepreload") ? "href" : null);
    if (activeAttr) {
      const u = attr(activeAttr) ? resolve(attr(activeAttr)!) : null;
      if (u?.protocol === "http:") facts.activeMixed.push({ tag: tag === "link" ? "stylesheet" : tag, url: u.href });
      if (tag === "script" && u && u.host !== base.host && u.protocol === "https:") facts.thirdPartyScripts.push({ url: u.href, integrity: !!attr("integrity") });
    }
    const passiveAttr = PASSIVE[tag];
    if (passiveAttr) {
      const u = attr(passiveAttr) ? resolve(attr(passiveAttr)!) : null;
      if (u?.protocol === "http:") facts.passiveMixed.push({ tag, url: u.href });
    }
    if (tag === "form") {
      const action = attr("action");
      const u = action ? resolve(action) : null;
      if (u?.protocol === "http:") facts.insecureForms.push(u.href);
    }
  }
  facts.directoryListing = /^Index of \//.test(title.trim());
  return facts;
}

export function analyseContent(res: HttpResponse, f: PageFacts): CheckResult[] {
  if (!f.isHtml) return [check({ id: "content.mixed", category: "content", title: "Mixed content", status: "skipped", severity: "high", summary: "The home page isn't HTML, so there was nothing to check for mixed content." })];
  const out: CheckResult[] = [];
  const page = { label: "Page", value: res.url };
  const note = res.truncated ? " Only the first part of the page was read (size limit)." : "";
  if (f.activeMixed.length)
    out.push(check({ id: "content.mixed", category: "content", title: "Mixed content", status: "failed", severity: "high", summary: `The HTTPS page loads ${f.activeMixed.length} script/style/frame resource${f.activeMixed.length === 1 ? "" : "s"} over plain HTTP. Browsers block them (breaking the page); on networks where they load, an attacker could swap them for malicious code.${note}`, evidence: [page, ...f.activeMixed.slice(0, 8).map((m) => ({ label: `<${m.tag}>`, value: m.url }))], remediation: "Load every resource over https:// (or with a relative URL). Adding upgrade-insecure-requests to the CSP is a stopgap.", references: [REF.mixed] }));
  else if (f.passiveMixed.length)
    out.push(check({ id: "content.mixed", category: "content", title: "Mixed content", status: "warning", severity: "low", summary: `${f.passiveMixed.length} image/media file${f.passiveMixed.length === 1 ? " is" : "s are"} referenced over plain HTTP (browsers upgrade or block them).${note}`, evidence: [page, ...f.passiveMixed.slice(0, 8).map((m) => ({ label: `<${m.tag}>`, value: m.url }))], remediation: "Reference images and media with https:// URLs.", references: [REF.mixed] }));
  else out.push(check({ id: "content.mixed", category: "content", title: "Mixed content", status: "passed", severity: "high", summary: `No http:// scripts, styles, frames or media on the home page.${note}`, evidence: [page] }));
  if (f.insecureForms.length)
    out.push(check({ id: "content.forms", category: "content", title: "Forms submit over HTTPS", status: "failed", severity: "medium", summary: `${f.insecureForms.length} form${f.insecureForms.length === 1 ? " submits" : "s submit"} to an http:// address, so what people type is sent unencrypted.`, evidence: f.insecureForms.slice(0, 5).map((u) => ({ label: "action", value: u })), remediation: "Point form actions at https:// URLs." }));
  const noSri = f.thirdPartyScripts.filter((s) => !s.integrity);
  if (f.thirdPartyScripts.length)
    out.push(check({ id: "content.third-party-scripts", category: "content", title: "Third-party scripts", status: "info", severity: "info", summary: `${f.thirdPartyScripts.length} script${f.thirdPartyScripts.length === 1 ? "" : "s"} from other hosts${noSri.length ? `, ${noSri.length} without Subresource Integrity` : ", all with Subresource Integrity"}. Each one can run any code on your page if its host is compromised.`, evidence: f.thirdPartyScripts.slice(0, 10).map((s) => ({ label: s.integrity ? "integrity" : "no integrity", value: s.url })) }));
  return out;
}

/* ---------------------------------------------------------------- server configuration */

export function analyseDisclosure(res: HttpResponse): CheckResult[] {
  const leaks: Evidence[] = [];
  const server = headerValue(res, "server");
  if (server && /\d/.test(server)) leaks.push({ label: "Server", value: clip(server, 120) });
  for (const h of ["x-powered-by", "x-aspnet-version", "x-aspnetmvc-version", "x-generator", "x-drupal-cache", "x-runtime"]) {
    const v = headerValue(res, h);
    if (v) leaks.push({ label: h, value: clip(v, 120) });
  }
  return [
    leaks.length
      ? check({ id: "server.disclosure", category: "server", title: "Software versions in headers", status: "warning", severity: "low", summary: `Headers reveal software details (${leaks.map((l) => l.label).join(", ")}), which helps attackers match known vulnerabilities.`, evidence: leaks, remediation: "Remove X-Powered-By and similar headers and hide version numbers in the Server header (e.g. server_tokens off in nginx, ServerTokens Prod in Apache)." })
      : check({ id: "server.disclosure", category: "server", title: "Software versions in headers", status: "passed", severity: "low", summary: server ? `Server: ${clip(server, 60)} (no version number).` : "No server software versions in the response headers." }),
  ];
}

/** Error-page signatures of common frameworks' debug output. */
const STACK_TRACES: [RegExp, string][] = [
  [/Traceback \(most recent call last\)/, "Python traceback"],
  [/\bat [\w$.<>]+ \((?:\/|[A-Z]:\\|file:|webpack:|node:)[^)]+:\d+:\d+\)/, "JavaScript stack trace"],
  [/Exception in thread "|\bat (?:java|javax|org|com)\.[\w$.]+\([\w]+\.java:\d+\)/, "Java stack trace"],
  [/<b>(?:Fatal error|Warning|Parse error)<\/b>:.+ on line <b>\d+<\/b>/, "PHP error"],
  [/Whitelabel Error Page/, "Spring Boot error page"],
  [/Server Error in '\/' Application|Stack Trace:<\/b>/, "ASP.NET error page"],
  [/<title>[^<]*(?:Exception|Error) at \//, "Django debug page"],
  [/Laravel|Symfony\\Component\\ErrorHandler|Illuminate\\/, "Laravel/Symfony debug page"],
];

export function analyseErrorPage(res: HttpResponse | null, error?: string): CheckResult[] {
  if (!res) return [check({ id: "server.error-page", category: "server", title: "Error pages", status: "inconclusive", severity: "medium", summary: `A request for a page that doesn't exist failed: ${clip(error ?? "unknown error", 120)}.` })];
  const out: CheckResult[] = [];
  const found = STACK_TRACES.find(([re]) => re.test(res.body));
  out.push(
    found
      ? check({ id: "server.error-page", category: "server", title: "Error pages", status: "failed", severity: "medium", summary: `A missing page shows debug output (${found[1]}), which can reveal file paths, code and configuration.`, evidence: [{ label: "Request", value: `${res.url} → HTTP ${res.status}` }, { label: "Signature", value: found[1] }], remediation: "Turn off debug mode in production and serve a plain error page." })
      : check({ id: "server.error-page", category: "server", title: "Error pages", status: "passed", severity: "medium", summary: `A request for a missing page returned HTTP ${res.status} without debug output.`, evidence: [{ label: "Request", value: `${res.url} → HTTP ${res.status}` }] }),
  );
  if (res.status === 200) out.push(check({ id: "server.soft-404", category: "server", title: "Missing pages return 404", status: "info", severity: "info", summary: "A page that doesn't exist returned HTTP 200 (common for single-page apps). Not a vulnerability, but it can hide real errors and confuse scanners." }));
  return out;
}

export function analyseDirectoryListing(f: PageFacts, url: string): CheckResult[] {
  return f.directoryListing ? [check({ id: "server.directory-listing", category: "server", title: "Directory listing", status: "failed", severity: "medium", summary: "The home page is an automatic directory listing, which shows every file in the folder.", evidence: [{ label: "Page", value: url }], remediation: "Disable directory indexes (Options -Indexes in Apache, autoindex off in nginx) and add an index page." })] : [];
}

export function analyseCors(res: HttpResponse, probeOrigin: string): CheckResult[] {
  const acao = headerValue(res, "access-control-allow-origin");
  const creds = headerValue(res, "access-control-allow-credentials")?.toLowerCase() === "true";
  if (!acao) return [check({ id: "server.cors", category: "server", title: "Cross-origin access (CORS)", status: "passed", severity: "high", summary: "The home page doesn't grant other sites access to its responses." })];
  const ev = [{ label: "Request Origin", value: probeOrigin }, { label: "Access-Control-Allow-Origin", value: clip(acao, 200) }, { label: "Access-Control-Allow-Credentials", value: String(creds) }];
  if (acao === probeOrigin && creds)
    return [check({ id: "server.cors", category: "server", title: "Cross-origin access (CORS)", status: "failed", severity: "high", summary: "Any origin is reflected back with credentials allowed: another website can read this page as the signed-in visitor.", evidence: ev, remediation: "Only allow an explicit list of trusted origins, and only send Allow-Credentials for those.", references: [REF.cors] })];
  if (acao === probeOrigin) return [check({ id: "server.cors", category: "server", title: "Cross-origin access (CORS)", status: "warning", severity: "low", summary: "Any origin is reflected in Access-Control-Allow-Origin (without credentials). Fine for public content; review it if responses contain private data.", evidence: ev, references: [REF.cors] })];
  if (acao === "*") return [check({ id: "server.cors", category: "server", title: "Cross-origin access (CORS)", status: "info", severity: "info", summary: "Access-Control-Allow-Origin: * (public, no credentials). Fine for public content.", evidence: ev })];
  return [check({ id: "server.cors", category: "server", title: "Cross-origin access (CORS)", status: "passed", severity: "high", summary: `Access is limited to ${clip(acao, 80)}.`, evidence: ev })];
}

export function analyseTrace(res: HttpResponse | null): CheckResult[] {
  if (!res) return [check({ id: "server.trace", category: "server", title: "TRACE method", status: "inconclusive", severity: "low", summary: "The TRACE request didn't get an answer." })];
  const echoed = res.status === 200 && /^TRACE \/\S* HTTP\/1\.[01]/m.test(res.body);
  return [
    echoed
      ? check({ id: "server.trace", category: "server", title: "TRACE method", status: "warning", severity: "low", summary: "TRACE is enabled and echoes the request back (Cross-Site Tracing). Browsers block TRACE from pages, so the practical risk is low.", evidence: [{ label: "TRACE /", value: `HTTP ${res.status}` }], remediation: "Disable TRACE (TraceEnable off in Apache; nginx doesn't support it by default)." })
      : check({ id: "server.trace", category: "server", title: "TRACE method", status: "passed", severity: "low", summary: `TRACE is not echoed (HTTP ${res.status}).` }),
  ];
}

export function analyseSecurityTxt(res: HttpResponse | null): CheckResult[] {
  const ok = !!res && res.status === 200 && /^\s*contact\s*:/im.test(res.body) && !/text\/html/i.test(headerValue(res, "content-type") ?? "");
  const expires = ok ? /^\s*expires\s*:\s*(\S+)/im.exec(res!.body)?.[1] : undefined;
  const expired = expires ? Date.parse(expires) < Date.now() : false;
  return [
    check({
      id: "server.security-txt",
      category: "server",
      title: "security.txt",
      status: ok ? (expired ? "warning" : "passed") : "info",
      severity: "info",
      summary: ok ? (expired ? `Present, but its Expires date (${expires}) has passed.` : "Present, with a contact for reporting vulnerabilities.") : "No /.well-known/security.txt. Optional; it tells researchers how to report problems.",
      remediation: ok && !expired ? null : "Publish /.well-known/security.txt with Contact and Expires fields.",
      references: [REF.securitytxt],
    }),
  ];
}
