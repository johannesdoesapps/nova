/**
 * Attack-surface mapping for a website Sentinel is authorised to assess. Pure functions over pages and
 * scripts that were fetched with ordinary GET requests: links, forms and their fields, scripts (first or
 * third party, with or without integrity), API endpoints the front end calls, redirect-style parameters,
 * source maps and technology hints. Nothing here sends requests; the crawler in ./sentinel does that.
 *
 * Everything in the inventory is an observation from fetched content ("seen"), never a guess. What was
 * not fetched (budget reached, other hosts, pages behind sign-in) is recorded as not assessed.
 */

export interface FormField {
  name: string;
  type: string;
}

export interface FormInfo {
  page: string;
  action: string;
  method: "GET" | "POST" | "OTHER";
  fields: FormField[];
  hasPassword: boolean;
  hasFile: boolean;
  /** A hidden field named like an anti-forgery token. */
  hasCsrfField: boolean;
}

export interface ScriptInfo {
  src: string;
  firstParty: boolean;
  integrity: boolean;
}

export interface PageInfo {
  url: string;
  status: number;
  title: string | null;
  links: string[];
  forms: FormInfo[];
  scripts: ScriptInfo[];
  endpoints: string[];
  redirectParams: string[];
  tech: string[];
}

export interface Surface {
  host: string;
  pages: { url: string; status: number; title: string | null }[];
  forms: FormInfo[];
  scripts: ScriptInfo[];
  /** Same-site API paths referenced by pages or scripts, with where they were seen. */
  endpoints: { path: string; seenIn: string }[];
  redirectParams: { param: string; seenIn: string }[];
  tech: string[];
  sourceMaps: string[];
  /** Same-site pages found but not fetched (budget), other hosts linked, and areas a crawler can't reach. */
  notFetched: string[];
  externalHosts: string[];
}

const ATTR = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** Attributes of one tag's source, lower-cased names. */
export function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const inner = tag.replace(/^<\s*[a-zA-Z0-9-]+/, "").replace(/\/?>$/, "");
  for (const m of inner.matchAll(ATTR)) out[m[1]!.toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? "");
  return out;
}

function decode(s: string) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

const tags = (html: string, name: string) => html.match(new RegExp(`<${name}\\b[^>]*>`, "gi")) ?? [];

/** Resolve a reference against the page; null for non-http(s) schemes. */
export function resolve(ref: string, base: string): URL | null {
  if (!ref || /^(javascript|mailto|tel|data|blob):/i.test(ref.trim())) return null;
  try {
    const u = new URL(ref.trim(), base);
    return u.protocol === "https:" || u.protocol === "http:" ? u : null;
  } catch {
    return null;
  }
}

/** The authorised host and its www twin count as the same site. */
export function sameSite(hostname: string, host: string) {
  return hostname === host || hostname === `www.${host}` || `www.${hostname}` === host;
}

/** A canonical same-site URL for crawling: no fragment, sorted query, no tracking parameters. */
export function canonical(u: URL): string {
  const c = new URL(u.toString());
  c.hash = "";
  for (const k of [...c.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$)/i.test(k)) c.searchParams.delete(k);
  c.searchParams.sort();
  return c.toString();
}

const REDIRECT_PARAM = /^(next|redirect|redirect_?uri|redirect_?url|return|return_?to|returnurl|continue|dest|destination|url|goto|callback|back)$/i;
const CSRF_FIELD = /csrf|xsrf|authenticity_token|__requestverificationtoken|_token/i;
// API-looking same-site paths in markup or scripts: "/api/…", "/graphql", "/rest/…", "/v1/…".
const ENDPOINT = /["'`](\/(?:api|graphql|rest|v[1-9])(?:\/[A-Za-z0-9_\-.:{}$[\]]*)*)(?:\?[^"'`]*)?["'`]/g;

/** Same-site API paths referenced in a block of text (HTML or JavaScript). Template placeholders are normalised. */
export function endpointsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(ENDPOINT)) {
    const p = m[1]!.replace(/\$\{[^}]*\}|\{[^}]*\}|\[[^\]]*\]/g, ":param").replace(/\/+$/, "");
    if (p.length > 1 && p.length <= 160) out.add(p);
  }
  return [...out].slice(0, 200);
}

const TECH: [RegExp, string][] = [
  [/\/_next\/static\//, "Next.js"],
  [/__NUXT__|\/_nuxt\//, "Nuxt"],
  [/data-reactroot|react-dom/, "React"],
  [/ng-version=/, "Angular"],
  [/wp-content\/|wp-includes\//, "WordPress"],
  [/cdn\.shopify\.com/, "Shopify"],
  [/\/static\/js\/main\.[a-f0-9]+\.js/, "Create React App"],
  [/supabase\.co/, "Supabase"],
  [/js\.stripe\.com/, "Stripe.js"],
  [/googletagmanager\.com|google-analytics\.com/, "Google Analytics/Tag Manager"],
];

/** Map one fetched HTML page. */
export function parsePage(url: string, status: number, html: string, host: string): PageInfo {
  const base = (() => {
    const b = tags(html, "base")[0];
    const href = b ? attrs(b).href : undefined;
    return (href && resolve(href, url)?.toString()) || url;
  })();
  const links = new Set<string>();
  const redirectParams = new Set<string>();
  for (const t of [...tags(html, "a"), ...tags(html, "link"), ...tags(html, "iframe"), ...tags(html, "area")]) {
    const a = attrs(t);
    const ref = a.href ?? a.src;
    if (!ref) continue;
    if (/^<link/i.test(t) && !/alternate|next|prev|canonical/i.test(a.rel ?? "")) continue;
    const u = resolve(ref, base);
    if (!u) continue;
    links.add(u.toString());
    for (const k of u.searchParams.keys()) if (REDIRECT_PARAM.test(k)) redirectParams.add(k);
  }

  const forms: FormInfo[] = [];
  for (const m of html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/gi)) {
    const open = /^<form\b[^>]*>/i.exec(m[0])![0];
    const a = attrs(open);
    const action = resolve(a.action ?? "", base)?.toString() ?? url;
    const method = (a.method ?? "get").toUpperCase();
    const fields: FormField[] = [];
    for (const f of [...(m[1]!.match(/<(?:input|select|textarea)\b[^>]*>/gi) ?? [])]) {
      const fa = attrs(f);
      const type = /^<select/i.test(f) ? "select" : /^<textarea/i.test(f) ? "textarea" : (fa.type ?? "text").toLowerCase();
      if (type === "submit" || type === "button" || type === "image" || type === "reset") continue;
      fields.push({ name: (fa.name ?? fa.id ?? "").slice(0, 60), type });
    }
    forms.push({
      page: url,
      action,
      method: method === "GET" || method === "POST" ? method : "OTHER",
      fields: fields.slice(0, 40),
      hasPassword: fields.some((f) => f.type === "password"),
      hasFile: fields.some((f) => f.type === "file") || /multipart\/form-data/i.test(a.enctype ?? ""),
      hasCsrfField: fields.some((f) => f.type === "hidden" && CSRF_FIELD.test(f.name)),
    });
  }

  const scripts: ScriptInfo[] = [];
  for (const t of tags(html, "script")) {
    const a = attrs(t);
    if (!a.src) continue;
    const u = resolve(a.src, base);
    if (!u) continue;
    scripts.push({ src: u.toString(), firstParty: sameSite(u.hostname, host), integrity: Boolean(a.integrity) });
  }

  const tech = TECH.filter(([re]) => re.test(html)).map(([, name]) => name);
  const gen = tags(html, "meta")
    .map(attrs)
    .find((a) => (a.name ?? "").toLowerCase() === "generator")?.content;
  if (gen) tech.push(gen.slice(0, 60));
  const title = /<title[^>]*>([^<]{0,200})<\/title>/i.exec(html)?.[1]?.trim() || null;
  return { url, status, title, links: [...links], forms, scripts, endpoints: endpointsIn(html), redirectParams: [...redirectParams], tech };
}

/** The source map a script points to, if any. */
export function sourceMapRef(js: string, scriptUrl: string): string | null {
  const m = /\/\/[#@]\s*sourceMappingURL=([^\s'"]+)\s*$/m.exec(js.slice(-2000));
  if (!m || m[1]!.startsWith("data:")) return null;
  return resolve(m[1]!, scriptUrl)?.toString() ?? null;
}

/** Build the site's inventory from what was fetched. */
export function buildSurface(host: string, pages: PageInfo[], extra: { scriptEndpoints?: { path: string; seenIn: string }[]; sourceMaps?: string[]; queued?: string[] } = {}): Surface {
  const endpoints = new Map<string, string>();
  for (const p of pages) for (const e of p.endpoints) if (!endpoints.has(e)) endpoints.set(e, p.url);
  for (const e of extra.scriptEndpoints ?? []) if (!endpoints.has(e.path)) endpoints.set(e.path, e.seenIn);
  const scripts = new Map<string, ScriptInfo>();
  for (const p of pages) for (const s of p.scripts) scripts.set(s.src, s);
  const redirect = new Map<string, string>();
  for (const p of pages) for (const r of p.redirectParams) if (!redirect.has(r)) redirect.set(r, p.url);
  const external = new Set<string>();
  for (const p of pages)
    for (const l of p.links) {
      try {
        const h = new URL(l).hostname;
        if (!sameSite(h, host)) external.add(h);
      } catch {
        /* ignore */
      }
    }
  for (const s of scripts.values()) if (!s.firstParty) external.add(new URL(s.src).hostname);
  const forms = new Map<string, FormInfo>();
  for (const p of pages) for (const f of p.forms) forms.set(`${f.method} ${f.action} ${f.fields.map((x) => x.name).join(",")}`, f);
  return {
    host,
    pages: pages.map((p) => ({ url: p.url, status: p.status, title: p.title })),
    forms: [...forms.values()],
    scripts: [...scripts.values()],
    endpoints: [...endpoints].map(([path, seenIn]) => ({ path, seenIn })).sort((a, b) => a.path.localeCompare(b.path)),
    redirectParams: [...redirect].map(([param, seenIn]) => ({ param, seenIn })),
    tech: [...new Set(pages.flatMap((p) => p.tech))],
    sourceMaps: [...new Set(extra.sourceMaps ?? [])],
    notFetched: [...new Set(extra.queued ?? [])],
    externalHosts: [...external].sort(),
  };
}

/**
 * A copy small enough to keep with the run (security_runs.stats is capped at 20 KB): long lists are cut
 * and the cut is recorded so the report never implies more was seen or less was skipped.
 */
export function compactSurface(s: Surface, budgetBytes = 11_000): Surface & { trimmed: string[] } {
  const trimmed: string[] = [];
  const cut = <T>(list: T[], n: number, label: string) => {
    if (list.length > n) trimmed.push(`${label}: showing ${n} of ${list.length}`);
    return list.slice(0, n);
  };
  const shortUrl = (u: string) => {
    try {
      const x = new URL(u);
      return sameSite(x.hostname, s.host) ? `${x.pathname}${x.search}`.slice(0, 160) : u.slice(0, 160);
    } catch {
      return u.slice(0, 160);
    }
  };
  for (const n of [40, 25, 15, 8]) {
    trimmed.length = 0;
    const out = {
      ...s,
      pages: cut(s.pages, n, "Pages").map((p) => ({ ...p, url: shortUrl(p.url), title: p.title?.slice(0, 80) ?? null })),
      forms: cut(s.forms, Math.ceil(n / 2), "Forms").map((f) => ({ ...f, page: shortUrl(f.page), action: shortUrl(f.action), fields: f.fields.slice(0, 12) })),
      scripts: cut(s.scripts, n, "Scripts").map((x) => ({ ...x, src: shortUrl(x.src) })),
      endpoints: cut(s.endpoints, n * 2, "Endpoints").map((e) => ({ path: e.path, seenIn: shortUrl(e.seenIn) })),
      redirectParams: cut(s.redirectParams, 10, "Redirect parameters").map((r) => ({ ...r, seenIn: shortUrl(r.seenIn) })),
      sourceMaps: cut(s.sourceMaps, 10, "Source maps").map(shortUrl),
      notFetched: cut(s.notFetched, n, "Pages not fetched").map(shortUrl),
      externalHosts: cut(s.externalHosts, n, "External hosts"),
      trimmed: [] as string[],
    };
    out.trimmed = [...trimmed];
    if (JSON.stringify(out).length <= budgetBytes) return out;
  }
  return {
    ...s,
    pages: [],
    forms: [],
    scripts: [],
    endpoints: [],
    redirectParams: [],
    sourceMaps: [],
    notFetched: [],
    externalHosts: [],
    trimmed: ["The site map was too large to keep; see the findings instead."],
  };
}
