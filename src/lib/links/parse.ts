import { htmlToText } from "@/lib/connectors/http";

/**
 * Reading links pasted into chat: which URLs a message contains, and the readable text of a fetched page. Pure, so
 * it's tested without the network; the fetching itself is in `read.ts`.
 */

export const MAX_LINKS = 3;
/** Characters of page text given to the model per link. */
export const MAX_PAGE_CHARS = 20_000;

/** http(s) links in a message, in order, without trailing punctuation, at most MAX_LINKS. */
export function extractLinks(message: string): string[] {
  const out: string[] = [];
  for (const m of message.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    let raw = m[0].replace(/[.,;:!?]+$/, "");
    // A closing bracket that isn't part of the link: "(see https://x.com/a)".
    while (/[)\]}]$/.test(raw) && count(raw, raw.at(-1)!) > count(raw, OPEN[raw.at(-1)!]!)) raw = raw.slice(0, -1);
    try {
      const u = new URL(raw);
      u.hash = "";
      const href = u.toString();
      if (!out.includes(href)) out.push(href);
    } catch {
      /* not a URL */
    }
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}
const OPEN: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
const count = (s: string, ch: string) => s.split(ch).length - 1;

const decodeEntities = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_, n: string) => safeChar(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => safeChar(parseInt(n, 16)))
    .replace(/&(mdash|ndash|hellip|rsquo|lsquo|rdquo|ldquo|copy);/g, (_, n: string) => ({ mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©" })[n] ?? "");
const safeChar = (n: number) => (n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "");

export type PageKind = "html" | "text" | "unsupported";

export function kindOf(contentType: string | null): PageKind {
  const t = (contentType ?? "").toLowerCase();
  if (!t || t.includes("html") || t.includes("xhtml")) return "html";
  if (t.startsWith("text/") || t.includes("json") || t.includes("xml") || t.includes("markdown")) return "text";
  return "unsupported";
}

/** Title and readable text of a fetched page. */
export function readablePage(body: string, contentType: string | null): { title: string | null; text: string } {
  if (kindOf(contentType) === "text") return { title: null, text: clipText(body.trim()) };
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1];
  const description = /<meta[^>]+(?:name|property)=["'](?:og:)?description["'][^>]*content=["']([^"']*)["']/i.exec(body)?.[1];
  // Prefer the page's main content when it marks it; drop navigation, footers, forms and inline SVGs either way.
  const main = /<(main|article)[\s>][\s\S]*<\/\1>/i.exec(body)?.[0];
  const cleaned = (main && main.length > 500 ? main : body).replace(/<(nav|footer|form|svg|noscript|template)[\s\S]*?<\/\1>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
  let text = decodeEntities(htmlToText(cleaned));
  if (description && !text.includes(description.slice(0, 40))) text = `${decodeEntities(description)}\n\n${text}`;
  return { title: title ? decodeEntities(htmlToText(title)).slice(0, 200) || null : null, text: clipText(text) };
}

const clipText = (s: string) => (s.length > MAX_PAGE_CHARS ? `${s.slice(0, MAX_PAGE_CHARS)}\n[… the rest of the page was cut off]` : s);

/** A plain-English reason a link couldn't be read, from the HTTP status. */
export function statusReason(status: number): string {
  if (status === 401 || status === 403) return "the site refused access (it may need a sign-in, or it blocks automated readers)";
  if (status === 404 || status === 410) return "the page wasn't found (404)";
  if (status === 429) return "the site is limiting requests right now";
  if (status >= 500) return `the site had an error (${status})`;
  return `the site answered with status ${status}`;
}
