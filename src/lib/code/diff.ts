/**
 * A line diff for showing proposed changes: Myers' algorithm on lines,
 * returned as hunks with a few lines of context. Pure, so the editor can run
 * it in the browser.
 */

export type DiffLine = { kind: "same" | "add" | "del"; text: string; oldNo: number | null; newNo: number | null };
export interface Hunk {
  lines: DiffLine[];
}

const splitLines = (s: string) => (s === "" ? [] : s.replace(/\n$/, "").split("\n"));

/** Every line of both versions in order, marked unchanged, added or removed. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const n = a.length;
  const m = b.length;
  const max = n + m;
  // Very large changes: show as remove-all/add-all rather than spend time on the search.
  if (max > 20_000) return [...a.map((t, i) => ({ kind: "del" as const, text: t, oldNo: i + 1, newNo: null })), ...b.map((t, i) => ({ kind: "add" as const, text: t, oldNo: null, newNo: i + 1 }))];
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[max + k - 1]! < v[max + k + 1]!) ? v[max + k + 1]! : v[max + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[max + k] = x;
      if (x >= n && y >= m) break outer;
    }
  }
  const out: DiffLine[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vv = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && vv[max + k - 1]! < vv[max + k + 1]!) ? k + 1 : k - 1;
    const prevX = vv[max + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push({ kind: "same", text: a[x - 1]!, oldNo: x, newNo: y });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) out.push({ kind: "add", text: b[y - 1]!, oldNo: null, newNo: y });
      else out.push({ kind: "del", text: a[x - 1]!, oldNo: x, newNo: null });
    }
    x = prevX;
    y = prevY;
  }
  return out.reverse();
}

/** Changed lines with `context` unchanged lines around them, grouped into hunks. */
export function diffHunks(before: string, after: string, context = 3): Hunk[] {
  const lines = diffLines(before, after);
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.kind !== "same") for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep[j] = true;
  });
  const hunks: Hunk[] = [];
  let cur: DiffLine[] | null = null;
  lines.forEach((l, i) => {
    if (keep[i]) (cur ??= []).push(l);
    else if (cur) {
      hunks.push({ lines: cur });
      cur = null;
    }
  });
  if (cur) hunks.push({ lines: cur });
  return hunks;
}

export function diffStats(before: string, after: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of diffLines(before, after)) {
    if (l.kind === "add") added++;
    else if (l.kind === "del") removed++;
  }
  return { added, removed };
}

/** A unified diff ("--- a/path", "+++ b/path", "@@" hunks), as git prints it. null content: the file doesn't exist on that side. */
export function unifiedDiff(path: string, before: string | null, after: string | null, context = 3): string {
  const head = `--- ${before === null ? "/dev/null" : `a/${path}`}\n+++ ${after === null ? "/dev/null" : `b/${path}`}`;
  const body = diffHunks(before ?? "", after ?? "", context).map((h) => {
    const first = h.lines[0]!;
    const oldStart = h.lines.find((l) => l.oldNo !== null)?.oldNo ?? Math.max(0, (first.newNo ?? 1) - 1);
    const newStart = h.lines.find((l) => l.newNo !== null)?.newNo ?? Math.max(0, (first.oldNo ?? 1) - 1);
    const oldLen = h.lines.filter((l) => l.kind !== "add").length;
    const newLen = h.lines.filter((l) => l.kind !== "del").length;
    return [`@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`, ...h.lines.map((l) => `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.text}`)].join("\n");
  });
  return [head, ...body].join("\n");
}
