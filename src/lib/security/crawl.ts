import "server-only";
import type { CrawlBudget } from "./audit";
import { scanTextForSecrets } from "./code-rules";
import { header, headerList, type SafeResponse } from "./net";
import { buildSurface, canonical, endpointsIn, parsePage, resolve, sameSite, sourceMapRef, type PageInfo, type Surface } from "./surface";
import { maskSecret, type Evidence, type FindingDraft, type Severity, type Confidence } from "./types";

/**
 * Sentinel's site mapping for an authorised, ownership-verified host. Strictly read-only:
 *  - GET requests only, to the same site (and its www twin), never following links to other hosts;
 *  - no form submissions, no sign-in attempts, no attack payloads, no parameters invented by Sentinel;
 *  - links that look like they change state (log out, delete, unsubscribe, cancel…) are never requested;
 *  - robots.txt Disallow rules are respected and listed as not fetched;
 *  - a page, script and time budget, with a pause between requests.
 * Read-only checks of the site's own API endpoints (a plain GET without credentials) and of its error page
 * only happen with active testing, which the user must choose and confirm.
 */

export type Get = (url: string, opts?: { headers?: Record<string, string>; maxBytes?: number }) => Promise<SafeResponse>;

export interface EndpointResult {
  path: string;
  status: number | null;
  type: string | null;
  /** "answered" = 2xx without credentials; "refused" = 401/403; "other" = anything else or no answer. */
  outcome: "answered" | "refused" | "other";
}

export interface CrawlResult {
  surface: Surface;
  findings: Omit<FindingDraft, "agent" | "fingerprint" | "asset" | "evidenceSource">[];
  pagesFetched: string[];
  scriptsFetched: string[];
  endpointResults: EndpointResult[];
  /** Responses whose cookies the header checks should also review (pages other than the home page). */
  responses: { url: string; res: SafeResponse }[];
  notes: string[];
  requests: number;
}

type Draft = CrawlResult["findings"][number] & { key?: string };

/** Link text or paths that may trigger an action on GET in badly-designed apps; Sentinel never requests them. */
export const UNSAFE_LINK =
  /(log-?out|sign-?out|logoff|delete|remove|destroy|unsubscribe|cancel|revoke|disconnect|deactivate|reset|purge|approve|reject|confirm|checkout|pay\b|\/pay\/|transfer|withdraw)/i;
const SKIP_EXT = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|mp4|webm|mov|mp3|wav|ogg|pdf|zip|gz|tgz|rar|7z|dmg|exe|msi|woff2?|ttf|otf|eot|css|xml|json|txt|csv|xlsx?|docx?|pptx?)$/i;
const PERSONAL_KEY =
  /"(e-?mail|email_address|phone(_?number)?|mobile|password(_?hash)?|passwd|access_?token|refresh_?token|session_?token|api_?key|secret|ssn|national_id|date_?of_?birth|dob|home_?address|street|iban|card_?number)"\s*:/i;
const STACK = [
  { re: /You're seeing this error because you have\s*<code>DEBUG = True<\/code>/i, label: "Django debug page", severity: "high" as Severity },
  { re: /Traceback \(most recent call last\)/, label: "Python traceback", severity: "medium" as Severity },
  { re: /\bat [\w.$<>]+ \((?:\/|[A-Z]:\\|webpack:|file:)[^)]+:\d+:\d+\)/, label: "JavaScript stack trace", severity: "medium" as Severity },
  { re: /(Whoops! There was an error|Illuminate\\|Symfony\\Component\\ErrorHandler)/, label: "PHP framework error page", severity: "medium" as Severity },
  { re: /(SQLSTATE\[|ORA-\d{5}|PG::\w+Error|SequelizeDatabaseError|PrismaClient\w*Error)/, label: "Database error message", severity: "medium" as Severity },
  { re: /(Exception in thread|java\.lang\.\w+Exception|at org\.springframework)/, label: "Java stack trace", severity: "medium" as Severity },
  { re: /Server Error in '\/' Application|ASP\.NET is configured to show verbose error messages/i, label: "ASP.NET error details", severity: "medium" as Severity },
];

const REF = {
  secrets: "https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html",
  sourcemaps: "https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/01-Information_Gathering/05-Review_Web_Page_Content_for_Information_Leakage",
  sri: "https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity",
  csrf: "https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html",
  redirect: "https://cheatsheetseries.owasp.org/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.html",
  errors: "https://owasp.org/www-community/Improper_Error_Handling",
  api: "https://owasp.org/API-Security/editions/2023/en/0xa3-broken-object-property-level-authorization/",
  tls: "https://cheatsheetseries.owasp.org/cheatsheets/Transport_Layer_Security_Cheat_Sheet.html",
};

/** robots.txt Disallow prefixes for all user agents, and the sitemaps it lists. */
export function parseRobots(text: string): { disallow: string[]; sitemaps: string[] } {
  const disallow: string[] = [];
  const sitemaps: string[] = [];
  let applies = false;
  let lastWasAgent = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const [k, v] = [m[1]!.toLowerCase(), m[2]!.trim()];
    if (k === "user-agent") {
      applies = lastWasAgent ? applies || v === "*" || /orbis/i.test(v) : v === "*" || /orbis/i.test(v);
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (k === "disallow" && applies && v) disallow.push(v);
    if (k === "sitemap" && v) sitemaps.push(v);
  }
  return { disallow, sitemaps };
}

const blockedByRobots = (path: string, disallow: string[]) => disallow.some((d) => (d.endsWith("$") ? path === d.slice(0, -1) : path.startsWith(d.replace(/\*.*$/, ""))));

export async function crawlSite(
  host: string,
  startUrl: string,
  budget: CrawlBudget,
  opts: { get: Get; active: boolean; signal?: AbortSignal; delayMs?: number; progress?: (s: string) => void; now?: () => number },
): Promise<CrawlResult> {
  const now = opts.now ?? Date.now;
  const deadline = now() + budget.seconds * 1000;
  const pause = () => new Promise((r) => setTimeout(r, opts.delayMs ?? 200));
  const progress = opts.progress ?? (() => {});
  const notes: string[] = [];
  const drafts: Draft[] = [];
  let requests = 0;
  const get: Get = async (url, o) => {
    requests++;
    return opts.get(url, o);
  };
  const timeLeft = () => now() < deadline && !opts.signal?.aborted;

  // robots.txt and sitemap: respected exclusions and extra pages to visit.
  let robots = { disallow: [] as string[], sitemaps: [] as string[] };
  try {
    const r = await get(`https://${host}/robots.txt`, { maxBytes: 64 * 1024 });
    if (r.status === 200 && !/text\/html/i.test(header(r, "content-type") ?? "")) robots = parseRobots(r.body);
  } catch {
    /* no robots.txt */
  }
  const queue: string[] = [canonical(new URL(startUrl))];
  const seen = new Set(queue);
  const skippedUnsafe = new Set<string>();
  const skippedRobots = new Set<string>();
  const enqueue = (u: URL) => {
    if (!sameSite(u.hostname, host) || SKIP_EXT.test(u.pathname)) return;
    const c = canonical(u);
    if (seen.has(c)) return;
    if (UNSAFE_LINK.test(u.pathname + u.search)) return void skippedUnsafe.add(c);
    if (blockedByRobots(u.pathname, robots.disallow)) return void skippedRobots.add(c);
    seen.add(c);
    queue.push(c);
  };
  for (const sm of robots.sitemaps.slice(0, 1)) {
    const u = resolve(sm, `https://${host}/`);
    if (!u || !sameSite(u.hostname, host)) continue;
    try {
      const r = await get(u.toString(), { maxBytes: 256 * 1024 });
      if (r.status === 200) for (const m of r.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) if (queue.length < budget.pages * 3) enqueue(new URL(m[1]!.replace(/&amp;/g, "&"), `https://${host}/`));
    } catch {
      notes.push("The sitemap listed in robots.txt couldn't be fetched.");
    }
  }

  const pages: PageInfo[] = [];
  const responses: CrawlResult["responses"] = [];
  progress("Mapping pages, forms and scripts");
  while (queue.length && pages.length < budget.pages && timeLeft()) {
    const url = queue.shift()!;
    try {
      const r = await get(url, { maxBytes: 512 * 1024 });
      if (r.status >= 300 && r.status < 400) {
        const loc = header(r, "location");
        const next = loc ? resolve(loc, url) : null;
        if (next) enqueue(next);
      } else if (/text\/html|application\/xhtml/i.test(header(r, "content-type") ?? "")) {
        const p = parsePage(url, r.status, r.body, host);
        pages.push(p);
        responses.push({ url, res: r });
        for (const l of p.links) {
          const u = resolve(l, url);
          if (u) enqueue(u);
        }
      }
    } catch {
      notes.push(`${url} couldn't be fetched.`);
    }
    await pause();
  }
  if (queue.length && pages.length >= budget.pages) notes.push(`Stopped after ${pages.length} pages (the page budget); ${queue.length} more same-site page(s) were found but not fetched.`);
  else if (queue.length) notes.push(`Stopped at the time budget; ${queue.length} same-site page(s) weren't fetched.`);
  if (skippedUnsafe.size) notes.push(`${skippedUnsafe.size} link(s) that look like actions (log out, delete, unsubscribe…) were deliberately not requested.`);
  if (skippedRobots.size) notes.push(`${skippedRobots.size} page(s) excluded by robots.txt were not requested.`);

  // First-party scripts: secrets, API endpoints, source maps.
  const scriptEndpoints: { path: string; seenIn: string }[] = [];
  const sourceMaps: string[] = [];
  const scriptsFetched: string[] = [];
  const firstParty = [...new Set(pages.flatMap((p) => p.scripts.filter((s) => s.firstParty).map((s) => s.src)))];
  if (firstParty.length) progress("Reading the site's JavaScript");
  for (const src of firstParty.slice(0, budget.scripts)) {
    if (!timeLeft()) break;
    try {
      const r = await get(src, { maxBytes: 3 * 1024 * 1024 });
      if (r.status !== 200) continue;
      scriptsFetched.push(src);
      for (const e of endpointsIn(r.body)) scriptEndpoints.push({ path: e, seenIn: src });
      for (const hit of scanTextForSecrets(r.body)) {
        const browserKey = hit.rule.id === "secret.google-api-key";
        drafts.push({
          key: `${hit.rule.id}:${hit.masked}`,
          ruleId: "surface.client-secret",
          title: `${hit.rule.title.replace(/ in source code$/, "")} in JavaScript served to every visitor`,
          description: `${hit.rule.description.replace("is committed in the code", "is in a script the site serves publicly")} Anyone can read it from the browser.`,
          severity: browserKey ? "info" : hit.rule.severity,
          confidence: hit.rule.confidence as Confidence,
          rationale: browserKey ? "Browser API keys are meant to be public; make sure it's restricted to your domains and APIs." : hit.rule.rationale,
          location: src,
          evidence: [{ source: `GET ${src}`, detail: hit.context }],
          remediation: browserKey
            ? "Restrict the key by HTTP referrer and to the APIs it needs in the provider's console."
            : "Remove the secret from client-side code (server-only environment variables must not use a public prefix such as NEXT_PUBLIC_), call the service from your server instead, and rotate the key now.",
          references: [REF.secrets, ...hit.rule.references.slice(0, 1)],
        });
      }
      const map = sourceMapRef(r.body, src) ?? (header(r, "sourcemap") ? (resolve(header(r, "sourcemap")!, src)?.toString() ?? null) : null);
      if (map && sourceMaps.length < 3 && sameSite(new URL(map).hostname, host)) {
        try {
          const m = await get(map, { maxBytes: 8 * 1024 });
          if (m.status === 200 && /^\s*\{/.test(m.body) && /"(sources|mappings)"\s*:/.test(m.body)) sourceMaps.push(map);
        } catch {
          /* not reachable */
        }
      }
    } catch {
      notes.push(`${src} couldn't be fetched.`);
    }
    await pause();
  }
  if (firstParty.length > budget.scripts) notes.push(`${firstParty.length - budget.scripts} first-party script(s) weren't read (the script budget).`);

  const surface = buildSurface(host, pages, { scriptEndpoints, sourceMaps, queued: queue });

  // Findings from what was mapped.
  for (const map of sourceMaps)
    drafts.push({
      key: map,
      ruleId: "surface.source-map-public",
      title: "JavaScript source maps are publicly downloadable",
      description: "The site serves .map files that reconstruct the original front-end source code, including comments and file structure.",
      severity: "low",
      confidence: "confirmed",
      rationale: "Not a vulnerability itself, but it makes reviewing your code for weaknesses much easier for anyone.",
      location: map,
      evidence: [{ source: `GET ${map}`, detail: "HTTP 200, JSON with a sources/mappings field." }],
      remediation: "Don't publish source maps in production (or upload them only to your error tracker).",
      references: [REF.sourcemaps],
    });
  const thirdParty = new Map<string, string[]>();
  for (const p of pages)
    for (const s of p.scripts) if (!s.firstParty && !s.integrity) thirdParty.set(new URL(s.src).hostname, [...new Set([...(thirdParty.get(new URL(s.src).hostname) ?? []), s.src])]);
  for (const [h, srcs] of thirdParty)
    drafts.push({
      key: h,
      ruleId: "surface.third-party-script",
      title: `Scripts from ${h} load without integrity pinning`,
      description: `${srcs.length} script(s) from ${h} run on your pages with full access, and nothing checks that their content is what you expect.`,
      severity: "low",
      confidence: "confirmed",
      rationale: "Only exploitable if that provider is compromised, but then every visitor is affected. Many providers serve changing scripts, so pinning isn't always possible.",
      location: srcs[0]!,
      evidence: srcs.slice(0, 3).map((s) => ({ source: "Script tag", detail: s })),
      remediation: "Add integrity and crossorigin attributes for versioned files, self-host them, or restrict them with a CSP; review whether each third-party script is still needed.",
      references: [REF.sri],
    });
  const cookiesWithoutSameSite = responses.some(({ res }) => headerList(res, "set-cookie").some((c) => !/;\s*samesite=/i.test(c)));
  for (const f of surface.forms) {
    const pageHttps = f.page.startsWith("https:");
    if (pageHttps && f.action.startsWith("http:")) {
      drafts.push({
        key: f.action,
        ruleId: "surface.form-insecure-action",
        title: `Form on ${new URL(f.page).pathname} submits over plain HTTP`,
        description: "A form on an HTTPS page sends its data to an http:// address.",
        severity: f.hasPassword ? "high" : "medium",
        confidence: "confirmed",
        rationale: "Submitted data, including any password, can be read or changed on the network.",
        location: f.page,
        evidence: [{ source: `HTML of ${f.page}`, detail: `<form method="${f.method}" action="${f.action}"> fields: ${f.fields.map((x) => `${x.name || "?"}:${x.type}`).join(", ")}` }],
        remediation: "Use an https:// (or relative) action URL.",
        references: [REF.tls],
      });
    }
    if (!pageHttps && f.hasPassword)
      drafts.push({
        key: f.page,
        ruleId: "surface.password-over-http",
        title: `Password form served over plain HTTP at ${f.page}`,
        description: "A page with a password field is served without HTTPS.",
        severity: "high",
        confidence: "confirmed",
        rationale: "Passwords can be captured on the network, and the page itself can be altered in transit.",
        location: f.page,
        evidence: [{ source: `HTML of ${f.page}`, detail: "Contains an input of type password." }],
        remediation: "Serve every page over HTTPS and redirect HTTP to HTTPS.",
        references: [REF.tls],
      });
    const meaningful = f.hasPassword || f.fields.filter((x) => x.type !== "hidden").length > 1;
    let sameSiteAction = false;
    try {
      sameSiteAction = sameSite(new URL(f.action).hostname, host);
    } catch {
      /* ignore */
    }
    if (f.method === "POST" && !f.hasCsrfField && meaningful && sameSiteAction && cookiesWithoutSameSite)
      drafts.push({
        key: `${f.action}`,
        ruleId: "surface.csrf-unverified",
        title: `POST form to ${new URL(f.action).pathname} has no anti-forgery field`,
        description:
          "The form has no hidden anti-forgery token, and the site sets at least one cookie without a SameSite attribute. Whether cross-site form posts are blocked depends on server-side checks Sentinel can't see (Origin checks, SameSite defaults, token headers).",
        severity: "low",
        confidence: "tentative",
        rationale: "Modern browsers default cookies to SameSite=Lax, which blocks most cross-site POSTs, so this is a lead to verify rather than a confirmed issue.",
        location: f.page,
        evidence: [{ source: `HTML of ${f.page}`, detail: `<form method="POST" action="${f.action}"> fields: ${f.fields.map((x) => `${x.name || "?"}:${x.type}`).join(", ")}` }],
        remediation: "Use anti-forgery tokens or verify the Origin header on state-changing requests, and set SameSite=Lax or Strict on session cookies explicitly.",
        references: [REF.csrf],
      });
  }
  if (surface.redirectParams.length)
    drafts.push({
      ruleId: "surface.redirect-param",
      title: `Links pass redirect targets in parameters (${surface.redirectParams.map((r) => r.param).join(", ")})`,
      description:
        "Some links carry a destination URL in a parameter such as next or redirect. If the server accepts any destination, it can be used to send users to other sites after visiting yours.",
      severity: "info",
      confidence: "tentative",
      rationale: "A lead to check, not a vulnerability: most apps only accept relative paths here. Sentinel doesn't try other destinations.",
      location: surface.redirectParams[0]!.seenIn,
      evidence: surface.redirectParams.slice(0, 3).map((r) => ({ source: `Links on ${r.seenIn}`, detail: `?${r.param}=…` })),
      remediation: "Accept only relative paths (starting with a single /) or an allow-list of your own hosts for redirect parameters.",
      references: [REF.redirect],
    });

  // Active testing only: read-only checks of the site's own endpoints and its error page.
  const endpointResults: EndpointResult[] = [];
  if (opts.active) {
    const candidates = surface.endpoints.map((e) => e.path).filter((p) => !p.includes(":") && !UNSAFE_LINK.test(p));
    if (candidates.length && budget.endpointChecks) progress("Checking how API endpoints answer signed-out requests");
    for (const path of candidates.slice(0, budget.endpointChecks)) {
      if (!timeLeft()) break;
      try {
        const r = await get(`https://${host}${path}`, { headers: { accept: "application/json" }, maxBytes: 64 * 1024 });
        const type = header(r, "content-type");
        const outcome: EndpointResult["outcome"] = r.status >= 200 && r.status < 300 ? "answered" : r.status === 401 || r.status === 403 ? "refused" : "other";
        endpointResults.push({ path, status: r.status, type, outcome });
        const personal = outcome === "answered" && /json/i.test(type ?? "") ? PERSONAL_KEY.exec(r.body) : null;
        if (personal)
          drafts.push({
            key: path,
            ruleId: "surface.api-personal-data",
            title: `${path} returns personal-looking fields without signing in`,
            description: `A signed-out GET request returned JSON with a field named "${personal[1]}". It may be intentionally public (for example a contact address), or it may expose user data.`,
            severity: /password|token|secret|api_?key|ssn|iban|card/i.test(personal[1]!) ? "high" : "medium",
            confidence: "tentative",
            rationale: "The field name was observed; whether the data is private needs a human to check. Values are not stored.",
            location: `https://${host}${path}`,
            evidence: [{ source: `GET ${path} (no credentials)`, detail: `HTTP ${r.status}, ${type ?? "no content type"}; contains a "${personal[1]}" field (values not shown).` }],
            remediation: "Require a signed-in user for endpoints that return personal data, and return only the fields the caller needs.",
            references: [REF.api],
          });
      } catch {
        endpointResults.push({ path, status: null, type: null, outcome: "other" });
      }
      await pause();
    }
    const skipped = candidates.length - endpointResults.length;
    if (skipped > 0) notes.push(`${skipped} discovered endpoint(s) weren't checked (budget).`);
    const withParams = surface.endpoints.filter((e) => e.path.includes(":")).length;
    if (withParams) notes.push(`${withParams} endpoint(s) need an id or parameter; Sentinel doesn't invent values, so they weren't requested.`);

    if (timeLeft()) {
      progress("Checking error pages for internal details");
      const token = Math.random().toString(36).slice(2, 10);
      for (const path of [`/orbis-sentinel-${token}`, `/api/orbis-sentinel-${token}`]) {
        try {
          const r = await get(`https://${host}${path}`, { maxBytes: 128 * 1024 });
          const hit = STACK.find((s) => s.re.test(r.body));
          if (hit) {
            const m = hit.re.exec(r.body)!;
            drafts.push({
              key: hit.label,
              ruleId: "surface.error-disclosure",
              title: `Error pages reveal internal details (${hit.label})`,
              description: "Requesting a page that doesn't exist returned internal error details instead of a generic error page.",
              severity: hit.severity,
              confidence: "confirmed",
              rationale: hit.severity === "high" ? "Debug pages expose settings, file paths and sometimes secrets." : "Reveals file paths, library names and code structure that help plan attacks.",
              location: `https://${host}${path}`,
              evidence: [{ source: `GET ${path}`, detail: `HTTP ${r.status}; matched ${hit.label}: ${redact(m[0])}` }],
              remediation: "Turn off debug mode in production and return generic error pages; log details on the server only.",
              references: [REF.errors],
            });
            break;
          }
        } catch {
          /* no answer */
        }
        await pause();
      }
    }
  }

  return { surface, findings: drafts, pagesFetched: pages.map((p) => p.url), scriptsFetched, endpointResults, responses, notes, requests };
}

function redact(s: string) {
  return s.replace(/[A-Za-z0-9_\-]{24,}/g, (m) => maskSecret(m)).slice(0, 200);
}

export type { Evidence };
