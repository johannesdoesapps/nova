/**
 * Data analysis tool: parses CSV/TSV text and computes exact per-column
 * statistics on the server, so the model explains real numbers instead of
 * guessing them. Pure and synchronous; bounded by row and column limits.
 */

export const MAX_ROWS = 20_000;
export const MAX_COLUMNS = 50;

export interface NumericSummary {
  kind: "numeric";
  name: string;
  count: number;
  missing: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  stdev: number;
}

export interface CategoricalSummary {
  kind: "categorical";
  name: string;
  count: number;
  missing: number;
  distinct: number;
  top: { value: string; count: number }[];
}

export type ColumnSummary = NumericSummary | CategoricalSummary;

export interface DatasetSummary {
  file: string;
  rows: number;
  columns: number;
  truncated: boolean;
  summaries: ColumnSummary[];
}

/** Minimal RFC 4180 parser: quoted fields, escaped quotes, CRLF. */
export function parseDelimited(text: string, delimiter: string, maxRows = MAX_ROWS + 1): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
      if (rows.length >= maxRows) return rows;
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

const NUMERIC = /^[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?([eE][-+]?\d+)?$/;
const toNumber = (s: string) => (NUMERIC.test(s) && /\d/.test(s) ? Number(s.replace(/,/g, "")) : NaN);
const round = (n: number) => Math.round(n * 1e4) / 1e4;

export function summarizeDataset(file: string, text: string): DatasetSummary | null {
  const delimiter = file.toLowerCase().endsWith(".tsv") || (!text.includes(",") && text.includes("\t")) ? "\t" : ",";
  const parsed = parseDelimited(text, delimiter);
  if (parsed.length < 2) return null;
  const header = parsed[0]!.slice(0, MAX_COLUMNS).map((h, i) => h.trim() || `column_${i + 1}`);
  const body = parsed.slice(1, MAX_ROWS + 1);
  const truncated = parsed.length > MAX_ROWS + 1 || parsed[0]!.length > MAX_COLUMNS;

  const summaries: ColumnSummary[] = header.map((name, c) => {
    const values = body.map((r) => (r[c] ?? "").trim());
    const present = values.filter((v) => v !== "" && !/^(na|n\/a|null|nan)$/i.test(v));
    const missing = values.length - present.length;
    const nums = present.map(toNumber);
    if (present.length > 0 && nums.every((n) => Number.isFinite(n))) {
      const sorted = [...nums].sort((a, b) => a - b);
      const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
      const mid = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
      const variance = nums.length > 1 ? nums.reduce((a, b) => a + (b - mean) ** 2, 0) / (nums.length - 1) : 0;
      return {
        kind: "numeric",
        name,
        count: nums.length,
        missing,
        min: sorted[0]!,
        max: sorted.at(-1)!,
        mean: round(mean),
        median: round(median),
        stdev: round(Math.sqrt(variance)),
      };
    }
    const freq = new Map<string, number>();
    for (const v of present) freq.set(v, (freq.get(v) ?? 0) + 1);
    const top = [...freq].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([value, count]) => ({ value: value.slice(0, 80), count }));
    return { kind: "categorical", name, count: present.length, missing, distinct: freq.size, top };
  });

  return { file, rows: body.length, columns: header.length, truncated, summaries };
}

/** Compact, model-readable rendering of a summary. */
export function formatSummary(s: DatasetSummary): string {
  const lines = [
    `Dataset ${s.file}: ${s.rows} rows × ${s.columns} columns${s.truncated ? ` (limited to the first ${MAX_ROWS} rows and ${MAX_COLUMNS} columns)` : ""}.`,
  ];
  for (const c of s.summaries) {
    if (c.kind === "numeric")
      lines.push(
        `- ${c.name} (numeric): n=${c.count}, missing=${c.missing}, min=${c.min}, max=${c.max}, mean=${c.mean}, median=${c.median}, sd=${c.stdev}`,
      );
    else
      lines.push(
        `- ${c.name} (text): n=${c.count}, missing=${c.missing}, distinct=${c.distinct}, most common: ${c.top.map((t) => `"${t.value}" (${t.count})`).join(", ")}`,
      );
  }
  return lines.join("\n");
}
