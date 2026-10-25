import { AMOUNT_FIELDS, CURRENCIES, DATE_FIELDS, FIELDS, type DerivedRule, type Extraction, type ExtractedField, type Field } from "./types";

/**
 * Reading an invoice: each field is looked up next to a label. Labels the user read values next to in their
 * demonstration are tried first, then Mimic's general labels. Nothing is guessed: a value that can't be read is
 * reported missing, an ambiguous date is flagged, and every value keeps the line it came from as evidence.
 */

const GENERIC_LABELS: Record<Field, string[]> = {
  supplier: ["supplier", "vendor", "from", "bill from", "billed by", "issued by", "seller"],
  invoiceNumber: ["invoice number", "invoice no.", "invoice no", "invoice nr", "invoice #", "invoice id", "inv no", "inv. no.", "inv #", "number", "reference"],
  invoiceDate: ["invoice date", "date of issue", "issue date", "issued on", "date"],
  dueDate: ["due date", "payment due", "pay by", "due by", "due"],
  net: ["subtotal", "sub-total", "net amount", "net total", "net", "amount before tax"],
  tax: ["vat", "tax", "gst", "sales tax", "mwst"],
  total: ["total due", "amount due", "balance due", "grand total", "total amount", "invoice total", "total"],
  currency: ["currency"],
};

/** Labels that look like a field's label but aren't (a tax ID is not a tax amount). */
const NOT_LABELS: Partial<Record<Field, RegExp>> = {
  tax: /^(vat|tax|gst|mwst)\s*(id|no|number|reg|registration)\b/i,
  invoiceNumber: /^(number of|reference to)\b/i,
  invoiceDate: /^(date of (delivery|service|supply))\b/i,
};

/** A learned "label" meaning the value is the document's first line (a letterhead), as in the demonstration. */
export const TOP_OF_DOCUMENT = "(top of document)";

export const normLabel = (s: string) =>
  s
    .toLowerCase()
    .replace(/[:\-–—]+\s*$/u, "")
    .replace(/\s+/g, " ")
    .trim();

export const normText = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Supplier names compared case- and punctuation-insensitively ("ACME AG" = "Acme, AG"). */
export const normSupplier = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

// ---------------------------------------------------------------- amounts, dates, currency

const AMOUNT_RE = /-?\d{1,3}(?:[.,'  ]\d{3})*(?:[.,]\d{2})(?!\d)|-?\d+(?:[.,]\d{2})(?!\d)/g;

/** "1,234.56", "1.234,56", "1'234.56", "1 234,56" → 1234.56. Requires two decimals, so IDs and years aren't amounts. */
export function parseAmount(s: string): number | null {
  const m = s.match(AMOUNT_RE);
  if (!m) return null;
  const tok = m[m.length - 1]!.replace(/[\s ']/g, "");
  const neg = tok.startsWith("-");
  const digits = tok.replace(/^-/, "");
  const whole = digits.slice(0, -3).replace(/[.,]/g, "");
  const n = Number(`${whole}.${digits.slice(-2)}`);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const monthIndex = (w: string) => MONTHS.findIndex((m) => m.startsWith(w.toLowerCase().slice(0, 3)));
const iso = (y: number, m: number, d: number) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null;
};

/** A date in the common invoice formats. `ambiguous` when 03/04/2026 could be 3 April or 4 March. */
export function parseDate(s: string): { iso: string; ambiguous: boolean } | null {
  let m = s.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) {
    const v = iso(+m[1]!, +m[2]!, +m[3]!);
    return v ? { iso: v, ambiguous: false } : null;
  }
  m = s.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/); // 01.10.2026: day first (European dotted dates)
  if (m) {
    const v = iso(+m[3]!, +m[2]!, +m[1]!);
    return v ? { iso: v, ambiguous: false } : null;
  }
  m = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (m) {
    const a = +m[1]!,
      b = +m[2]!,
      y = +m[3]!;
    if (a > 12) return iso(y, b, a) ? { iso: iso(y, b, a)!, ambiguous: false } : null;
    if (b > 12) return iso(y, a, b) ? { iso: iso(y, a, b)!, ambiguous: false } : null;
    const v = iso(y, b, a); // day first unless the user's demonstration taught otherwise
    return v ? { iso: v, ambiguous: a !== b } : null;
  }
  m = s.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})\b/);
  if (m && monthIndex(m[2]!) >= 0) {
    const v = iso(+m[3]!, monthIndex(m[2]!) + 1, +m[1]!);
    return v ? { iso: v, ambiguous: false } : null;
  }
  m = s.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/);
  if (m && monthIndex(m[1]!) >= 0) {
    const v = iso(+m[3]!, monthIndex(m[1]!) + 1, +m[2]!);
    return v ? { iso: v, ambiguous: false } : null;
  }
  return null;
}

const SYMBOLS: Record<string, string> = { "€": "EUR", "£": "GBP", $: "USD", "¥": "JPY" };

/** Currency codes and symbols mentioned on a line. */
export function currenciesIn(s: string): string[] {
  const out = new Set<string>();
  for (const m of s.matchAll(/\b([A-Z]{3})\b/g)) if (KNOWN_CODES.has(m[1]!)) out.add(m[1]!);
  for (const [sym, code] of Object.entries(SYMBOLS)) if (s.includes(sym)) out.add(code);
  return [...out];
}
/** ISO 4217 codes Mimic recognises: the usual ones, plus others it reads but flags as unexpected. */
const KNOWN_CODES = new Set<string>([...CURRENCIES, "CNY", "INR", "BRL", "MXN", "ZAR", "HKD", "SGD", "NZD", "TRY", "CZK", "HUF", "RUB", "AED", "SAR", "KRW", "THB"]);

// ---------------------------------------------------------------- finding values by label

interface Hit {
  value: string;
  line: string;
  label: string;
}

/** Each text after `label` at the start of a line (after ":" or spaces), or on the next line when the label stands alone. */
function* findByLabel(lines: string[], label: string, field: Field): Generator<Hit> {
  const want = normLabel(label);
  if (!want) return;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    const low = line.toLowerCase();
    if (!low.startsWith(want)) continue;
    const rest = line.slice(want.length);
    // The label must end at a word boundary: "net" doesn't match "network", "total" matches "Total:".
    if (/^[\p{L}\p{N}]/u.test(rest)) continue;
    if (NOT_LABELS[field]?.test(line)) continue;
    const value = rest.replace(/^[\s:#.\-–—]+/u, "").trim();
    if (value) yield { value, line, label: want };
    else {
      const next = lines.slice(i + 1).find((l) => l.trim());
      if (next) yield { value: next.trim(), line: `${line} ${next.trim()}`, label: want };
    }
  }
}

/** The first hit for any of `labels` that reads as a valid value for the field. */
function firstValue(lines: string[], labels: string[], f: Field, source: "learned_label" | "label"): ExtractedField | null {
  for (const label of labels) for (const hit of findByLabel(lines, label, f)) {
    const got = interpret(f, hit, source);
    if (got) return got;
  }
  return null;
}

const missing = (note?: string): ExtractedField => ({ value: null, raw: null, evidence: null, source: "missing", confidence: "low", ...(note ? { note } : {}) });

function interpret(field: Field, hit: Hit, source: "learned_label" | "label"): ExtractedField | null {
  const base = { raw: hit.value, evidence: hit.line.slice(0, 200), source };
  if ((AMOUNT_FIELDS as readonly string[]).includes(field)) {
    const n = parseAmount(hit.value);
    return n === null ? null : { ...base, value: n, confidence: source === "learned_label" ? "high" : "medium" };
  }
  if ((DATE_FIELDS as readonly string[]).includes(field)) {
    const d = parseDate(hit.value);
    if (!d) return null;
    return { ...base, value: d.iso, confidence: d.ambiguous ? "low" : source === "learned_label" ? "high" : "medium", ...(d.ambiguous ? { note: `"${hit.value}" could be day-first or month-first.` } : {}) };
  }
  if (field === "currency") {
    const c = currenciesIn(hit.value)[0];
    return c ? { ...base, value: c, confidence: "high" } : null;
  }
  const v = hit.value.replace(/\s{2,}/g, " ").slice(0, 120);
  if (field === "invoiceNumber" && !/\d/.test(v)) return null;
  return { ...base, value: v, confidence: source === "learned_label" ? "high" : "medium" };
}

/**
 * Read every field from an invoice's text. `hints` are the labels learned from the user's demonstration;
 * `derived` says how to work out a value the document doesn't contain (due date = invoice date + N days).
 */
export function extractInvoice(text: string, hints: Partial<Record<Field, string[]>> = {}, derived: Partial<Record<Field, DerivedRule>> = {}): Extraction {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const out = {} as Extraction;
  for (const f of FIELDS) {
    out[f] = firstValue(lines, hints[f] ?? [], f, "learned_label") ?? firstValue(lines, GENERIC_LABELS[f], f, "label") ?? missing();
  }

  // Supplier without a label: the first line of the document, if it isn't a heading like "INVOICE".
  if (out.supplier.value === null) {
    const first = lines.find((l) => l.trim() && !/^\s*(tax\s+)?invoice\b/i.test(l) && !/^\s*(bill|ship)\s+to\b/i.test(l));
    const taught = (hints.supplier ?? []).includes(TOP_OF_DOCUMENT);
    if (first)
      out.supplier = taught
        ? { value: first.trim().slice(0, 120), raw: first.trim(), evidence: first.trim(), source: "learned_label", confidence: "medium", note: "The letterhead, as in your demonstration." }
        : { value: first.trim().slice(0, 120), raw: first.trim(), evidence: first.trim(), source: "layout", confidence: "low", note: "Read from the top of the document, not from a label." };
  }

  // Currency without a "Currency:" line: the codes or symbols next to the amounts.
  if (out.currency.value === null) {
    const amountLines = (["total", "net", "tax"] as const).map((f) => out[f].evidence).filter((x): x is string => !!x);
    const found = new Set(amountLines.flatMap(currenciesIn));
    if (found.size === 1) {
      const c = [...found][0]!;
      out.currency = { value: c, raw: c, evidence: amountLines[0]!, source: "label", confidence: c === "USD" && amountLines.some((l) => l.includes("$")) && !/USD/i.test(amountLines.join(" ")) ? "medium" : "high", ...(c === "USD" && !/USD/i.test(amountLines.join(" ")) ? { note: "A $ sign was read as US dollars." } : {}) };
    } else if (found.size > 1) out.currency = missing(`Several currencies appear (${[...found].join(", ")}).`);
  }

  // Values the document doesn't contain, worked out the way the user's demonstration showed.
  for (const f of FIELDS) {
    const rule = derived[f];
    if (out[f].value !== null || !rule) continue;
    if (rule.kind === "days_after" && typeof out.invoiceDate.value === "string") {
      const d = new Date(`${out.invoiceDate.value}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + rule.days);
      out[f] = { value: d.toISOString().slice(0, 10), raw: null, evidence: null, source: "derived", confidence: "high", note: `Invoice date + ${rule.days} days, as you showed Mimic.` };
    } else if (rule.kind === "constant") out[f] = { value: rule.value, raw: null, evidence: null, source: "derived", confidence: "high", note: "The value you told Mimic to use." };
  }
  return out;
}

/** True when `value` occurs in the document (amounts and dates in any of their written forms). Used to reject AI answers that aren't in the source. */
export function appearsIn(text: string, field: Field, value: string | number): boolean {
  if ((AMOUNT_FIELDS as readonly string[]).includes(field)) {
    const want = Number(value);
    return [...text.matchAll(AMOUNT_RE)].some((m) => parseAmount(m[0]) === want);
  }
  if ((DATE_FIELDS as readonly string[]).includes(field)) return text.split(/\r?\n/).some((l) => parseDate(l)?.iso === value);
  if (field === "currency") return currenciesIn(text).includes(String(value));
  return normText(text).includes(normText(String(value)));
}

/** The label a value sits next to on its line, for learning ("Inv. No.: 4471" → "inv. no."). Null when the value isn't on any line. */
export function labelFor(text: string, value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const i = line.toLowerCase().indexOf(v.toLowerCase());
    if (i > 0) {
      const label = normLabel(line.slice(0, i));
      if (label && label.length <= 60) return label;
    }
  }
  return null;
}

/** Phrases that read as instructions to an AI or an operator rather than invoice content. They are treated as data and flagged. */
const INSTRUCTION_RE =
  /\b(ignore (all |any )?(previous|prior|above) (instructions|rules)|disregard (the|all|any) (rules|instructions)|you are (now )?(an?|the) (ai|assistant|agent)|system prompt|approve (this|the) (invoice|payment) automatically|do not (ask|notify) (the )?(user|owner)|transfer (the )?(funds|money|payment)|wire (the )?(funds|money)|send (the )?(payment|money|password|credentials)|change (the )?(bank|iban|account) (details|number)|new bank details)\b/i;

export function suspiciousContent(text: string): string | null {
  const m = text.match(INSTRUCTION_RE);
  return m ? m[0] : null;
}
