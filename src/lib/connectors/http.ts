import "server-only";

/**
 * Calls to connected services: a timeout on every call, a few retries for
 * rate limits and temporary failures (honouring Retry-After), and errors
 * sorted into what the user can act on. Provider error text is never passed
 * on (it can contain account details); only a status-based message is.
 */

export type ConnectorErrorKind = "auth" | "permission" | "not_found" | "rate_limited" | "unavailable" | "bad_request" | "not_configured";

export class ConnectorError extends Error {
  constructor(
    readonly kind: ConnectorErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export type Fetch = typeof fetch;

export interface CallOptions {
  method?: string;
  token?: string | null;
  headers?: Record<string, string>;
  json?: unknown;
  form?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  retries?: number;
  signal?: AbortSignal;
  /** The service's name, for messages. */
  service: string;
  /** Services that answer an invalid token with 403 (Figma): treat 403 as "reconnect needed". */
  forbiddenMeansAuth?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function errorFor(status: number, service: string): ConnectorError {
  if (status === 401) return new ConnectorError("auth", `${service} didn't accept the saved sign-in. Reconnect ${service} on the Connectors page.`, status);
  if (status === 403) return new ConnectorError("permission", `${service} refused: the connection doesn't have permission for that.`, status);
  if (status === 404) return new ConnectorError("not_found", `${service} couldn't find that (or it isn't shared with Orbis).`, status);
  if (status === 429) return new ConnectorError("rate_limited", `${service} is limiting requests right now. Try again in a minute.`, status);
  if (status >= 500) return new ConnectorError("unavailable", `${service} isn't responding right now (${status}).`, status);
  return new ConnectorError("bad_request", `${service} rejected the request (${status}).`, status);
}

async function once(url: string, o: CallOptions, f: Fetch): Promise<Response> {
  const headers: Record<string, string> = { accept: "application/json", "user-agent": "Orbis/1.0 (+https://tryorbis.app)", ...o.headers };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  let body: string | undefined = o.body;
  if (o.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(o.json);
  } else if (o.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(o.form).toString();
  }
  const timeout = AbortSignal.timeout(o.timeoutMs ?? 15_000);
  return f(url, { method: o.method ?? (body ? "POST" : "GET"), headers, body, signal: o.signal ? AbortSignal.any([o.signal, timeout]) : timeout, redirect: "follow" });
}

/** A request with retries; returns the Response when it's OK, else throws a ConnectorError. */
export async function call(url: string, o: CallOptions, f: Fetch = fetch): Promise<Response> {
  const retries = o.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await once(url, o, f);
    } catch (err) {
      if (o.signal?.aborted) throw new ConnectorError("unavailable", "Cancelled.");
      if (attempt < retries) {
        await sleep(400 * 2 ** attempt);
        continue;
      }
      throw new ConnectorError("unavailable", `${o.service} couldn't be reached${(err as Error).name === "TimeoutError" ? " in time" : ""}.`);
    }
    if (res.ok) return res;
    const retryable = res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;
    if (retryable && attempt < retries) {
      const after = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 5) * 1000 : 500 * 2 ** attempt);
      continue;
    }
    throw errorFor(res.status === 403 && o.forbiddenMeansAuth ? 401 : res.status, o.service);
  }
}

export async function callJson<T>(url: string, o: CallOptions, f: Fetch = fetch): Promise<T> {
  const res = await call(url, o, f);
  try {
    return (await res.json()) as T;
  } catch {
    throw new ConnectorError("unavailable", `${o.service} sent a response Orbis couldn't read.`);
  }
}

/** HTML longer than this is cut before parsing: the text is clipped far shorter anyway. */
export const MAX_HTML_CHARS = 400_000;

/**
 * The HTML with every <tag …>…</tag> element of the given names replaced by a space, in one pass. (A
 * backreference regex like /<(nav|form)[\s\S]*?<\/\1>/ rescans to the end for each unclosed tag: quadratic on
 * hostile pages.) An element with no closing tag is left as it is.
 */
export function stripElements(html: string, tags: string[]): string {
  const lower = html.toLowerCase();
  const open = new RegExp(`<(${tags.join("|")})[\\s>/]`, "g");
  const unclosed = new Set<string>(); // no closing tag left for these, so later ones can't close either
  let out = "";
  let at = 0;
  for (let m = open.exec(lower); m; m = open.exec(lower)) {
    if (unclosed.has(m[1]!)) continue;
    const end = lower.indexOf(`</${m[1]}`, m.index + 1);
    if (end < 0) {
      unclosed.add(m[1]!);
      continue;
    }
    const close = lower.indexOf(">", end);
    out += `${html.slice(at, m.index)} `;
    at = close < 0 ? html.length : close + 1;
    open.lastIndex = at;
  }
  return out + html.slice(at);
}

/** The HTML without <!-- comments -->, in one pass; an unclosed comment runs to the end, as in a browser. */
export function stripComments(html: string): string {
  let out = "";
  let at = 0;
  for (let i = html.indexOf("<!--"); i >= 0; i = html.indexOf("<!--", at)) {
    const end = html.indexOf("-->", i + 4);
    out += `${html.slice(at, i)} `;
    if (end < 0) return out;
    at = end + 3;
  }
  return out + html.slice(at);
}

/** The text inside the first <title>, found without backtracking. */
export function titleOf(html: string): string | null {
  const lower = html.toLowerCase();
  const start = lower.search(/<title[\s>]/);
  if (start < 0) return null;
  const open = lower.indexOf(">", start);
  const end = lower.indexOf("</title", open);
  return open < 0 || end < 0 ? null : html.slice(open + 1, end);
}

/** The outermost <main> or <article> element, found without backtracking; null when there's none. */
export function mainElement(html: string): string | null {
  const lower = html.toLowerCase();
  for (const tag of ["main", "article"]) {
    const start = lower.search(new RegExp(`<${tag}[\\s>]`));
    if (start < 0) continue;
    const end = lower.lastIndexOf(`</${tag}>`);
    if (end > start) return html.slice(start, end + tag.length + 3);
  }
  return null;
}

/** Plain text from HTML (for email bodies and similar), without scripts or styles. */
export function htmlToText(html: string): string {
  return stripElements(html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html, ["script", "style", "head"])
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^<>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
