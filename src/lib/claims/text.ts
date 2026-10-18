/** Small, dependency-free text utilities shared by Claim DNA and Model Intelligence. */

const STOPWORDS = new Set(
  (
    "a an and are as at be been being but by can could did do does for from had has have he her his how i if in into is it its " +
    "may might more most no not of on or our she should so some such than that the their them then there these they this those " +
    "to too very was we were what when where which while who whom why will with would you your also about after again all any " +
    "because before between both during each few further here just like only other over own same through under until up upon " +
    "according said says per via among within without however although though whether yet one two"
  ).split(" "),
);

const NEGATIONS = /\b(not|no|never|none|neither|nor|cannot|can't|won't|isn't|aren't|wasn't|weren't|doesn't|don't|didn't|hasn't|haven't|hadn't|without|fails? to|lack(?:s|ed)?|unlikely)\b/i;

/** Very light stemming: enough to match "increases"/"increased"/"increasing". */
export function stem(w: string): string {
  if (w.length <= 4) return w;
  return w
    .replace(/(ies)$/, "y")
    .replace(/(ing|edly|ed|es|s)$/, "")
    .replace(/(ation|ment|ness)$/, "");
}

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9'-]*|\d+(?:\.\d+)?/g) ?? [])
    .map((t) => t.replace(/'s$/, ""))
    .filter((t) => !STOPWORDS.has(t) && t.length > 1)
    .map(stem);
}

export function keyTerms(text: string): string[] {
  return [...new Set(tokenize(text).filter((t) => !/^\d/.test(t)))];
}

export function isNegated(text: string): boolean {
  return NEGATIONS.test(text);
}

export function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Case/whitespace/quote-insensitive substring search. Returns the index in `haystack` or -1. */
export function findQuote(haystack: string, needle: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  const n = normalizeWs(norm(needle));
  if (n.length < 8) return -1;
  const h = norm(haystack);
  // Map normalised positions back to original by scanning with a whitespace-tolerant regex.
  const pattern = n.split(" ").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  const m = new RegExp(pattern).exec(h);
  return m ? m.index : -1;
}

export interface NumberMention {
  value: number;
  unit: string; // "%", "$", "year", "" …
  raw: string;
}

/** Numbers with a coarse unit, used to spot numeric mismatches between claim and source. */
export function numbers(text: string): NumberMention[] {
  const out: NumberMention[] = [];
  const re = /(\$|€|£)?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(%|percent|per cent|million|billion|trillion|thousand|k\b|m\b|bn\b)?/gi;
  for (const m of text.matchAll(re)) {
    const raw = m[0].trim();
    let value = Number(m[2]!.replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    const suffix = (m[3] ?? "").toLowerCase();
    let unit = m[1] ? "$" : "";
    if (suffix === "%" || suffix.startsWith("per")) unit = "%";
    else if (suffix === "million" || suffix === "m") value *= 1e6;
    else if (suffix === "billion" || suffix === "bn") value *= 1e9;
    else if (suffix === "trillion") value *= 1e12;
    else if (suffix === "thousand" || suffix === "k") value *= 1e3;
    if (!unit && !suffix && value >= 1800 && value <= 2100 && Number.isInteger(value)) unit = "year";
    out.push({ value, unit, raw });
  }
  return out;
}

/** Sentence splitter that keeps character offsets and protects common abbreviations and decimals. */
export function sentences(text: string): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  const protectedText = text
    .replace(/\b(e\.g|i\.e|etc|vs|approx|Dr|Mr|Mrs|Ms|Prof|Inc|Ltd|Co|St|No|Fig|U\.S|U\.K|a\.m|p\.m)\./g, (m) => m.replace(/\./g, "\u0000"))
    .replace(/(\d)\.(\d)/g, "$1\u0000$2");
  const re = /[^.!?\n]+(?:[.!?]+(?=\s|$)|\n|$)/g;
  for (const m of protectedText.matchAll(re)) {
    const raw = m[0];
    const lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const start = m.index! + lead;
    out.push({ text: text.slice(start, start + trimmed.length), start, end: start + trimmed.length });
  }
  return out;
}

/** Fast, stable 53-bit string hash (cyrb53) as hex. For change detection only — not security. */
export function hash(input: unknown): string {
  const str = typeof input === "string" ? input : stableStringify(input);
  let h1 = 0xdeadbeef ^ 0;
  let h2 = 0x41c6ce57 ^ 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}
