import type { SourceFile } from "../code-rules";

/**
 * Small, dependency-free helpers for reading source text: language detection, test/config classification and
 * a comment stripper that keeps line numbers and string contents intact (so rules can match code, not comments,
 * and still report the right line). No parser: everything built on these is a heuristic and says so.
 */

export type Lang = "ts" | "js" | "py" | "other";

export const langOf = (path: string): Lang => (/\.(ts|tsx|mts|cts)$/.test(path) ? "ts" : /\.(js|jsx|mjs|cjs)$/.test(path) ? "js" : /\.py$/.test(path) ? "py" : "other");
export const isCode = (path: string) => langOf(path) !== "other" && !/\.d\.ts$/.test(path);
export const isTestPath = (path: string) =>
  /\.(test|spec|e2e)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.py$/.test(path) ||
  // A folder named "test" inside a Next.js app/pages tree is a route (e.g. app/api/x/test/route.ts), not tests.
  (/(^|\/)(__tests__|tests?|spec|e2e|cypress|playwright)\//.test(path) && !/(^|\/)(app|pages)\/.*(^|\/)(route|page|layout)\.[cm]?[jt]sx?$/.test(path));
export const isConfigPath = (path: string) => /(^|\/)[^/]*\.config\.[cm]?[jt]s$|(^|\/)(\.eslintrc|\.prettierrc|babel\.config|jest\.setup|vitest\.setup|setupTests)[^/]*$/.test(path);
export const isGeneratedPath = (path: string) => /(^|\/)(generated|__generated__|\.generated)\/|\.generated\.[jt]sx?$|(^|\/)(next-env\.d\.ts)$/.test(path);

export const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
export const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** Normalise "a/./b/../c" → "a/c". Returns null when the path climbs above the root. */
export function joinPath(dir: string, rel: string): string | null {
  const out: string[] = dir ? dir.split("/") : [];
  for (const part of rel.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

/**
 * Replace comments with spaces (newlines kept) so line numbers stay correct. Understands '…', "…", `…`
 * (including ${…} nesting one level deep) and, for Python, # comments and triple-quoted strings. Regex
 * literals aren't recognised: a "//" inside one can blank the rest of that line, which only ever hides code
 * from the rules (fewer findings, never false ones).
 */
export function stripComments(code: string, lang: Lang): string {
  const out = code.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  const n = code.length;
  if (lang === "py") {
    while (i < n) {
      const c = code[i]!;
      if (c === "#") {
        const e = code.indexOf("\n", i);
        blank(i, e < 0 ? n : e);
        i = e < 0 ? n : e;
      } else if ((c === '"' || c === "'") && code.startsWith(c.repeat(3), i)) {
        const e = code.indexOf(c.repeat(3), i + 3);
        i = e < 0 ? n : e + 3;
      } else if (c === '"' || c === "'") {
        i = skipString(code, i, c);
      } else i++;
    }
    return out.join("");
  }
  while (i < n) {
    const c = code[i]!;
    if (c === "/" && code[i + 1] === "/") {
      const e = code.indexOf("\n", i);
      blank(i, e < 0 ? n : e);
      i = e < 0 ? n : e;
    } else if (c === "/" && code[i + 1] === "*") {
      const e = code.indexOf("*/", i + 2);
      blank(i, e < 0 ? n : e + 2);
      i = e < 0 ? n : e + 2;
    } else if (c === '"' || c === "'" || c === "`") {
      i = skipString(code, i, c);
    } else i++;
  }
  return out.join("");
}

/**
 * Comments removed and string contents blanked (quotes kept), except module specifiers after from/import/
 * require( — so code samples held in strings don't look like code. Line numbers and offsets are unchanged.
 */
export function codeOnly(code: string, lang: Lang): string {
  const src = stripComments(code, lang);
  const out = src.split("");
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const triple = lang === "py" && (c === '"' || c === "'") && src.startsWith(c.repeat(3), i);
    if (triple || c === '"' || c === "'" || (c === "`" && lang !== "py")) {
      const end = triple ? (src.indexOf(c.repeat(3), i + 3) < 0 ? src.length : src.indexOf(c.repeat(3), i + 3) + 3) : skipString(src, i, c);
      const before = src.slice(Math.max(0, i - 12), i);
      const keep = !triple && c !== "`" && /(\bfrom|\bimport|require\(|import\()\s*$/.test(before);
      if (!keep) for (let k = i + (triple ? 3 : 1); k < end - (triple ? 3 : 1); k++) if (out[k] !== "\n") out[k] = " ";
      i = end;
    } else i++;
  }
  return out.join("");
}

function skipString(code: string, start: number, q: string): number {
  let i = start + 1;
  let depth = 0;
  while (i < code.length) {
    const c = code[i]!;
    if (c === "\\") i += 2;
    else if (q === "`" && c === "$" && code[i + 1] === "{") {
      depth++;
      i += 2;
    } else if (q === "`" && depth > 0 && c === "}") {
      depth--;
      i++;
    } else if (c === q && depth === 0) return i + 1;
    else if (c === "\n" && q !== "`") return i + 1;
    else i++;
  }
  return i;
}

/** 1-based line number of a character offset. */
export function lineAt(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** Precomputed line starts for many lookups in one file. */
export function lineIndex(text: string): (index: number) => number {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (index) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

export const lineText = (text: string, line: number) => (text.split("\n")[line - 1] ?? "").trim().slice(0, 240);

/** Index of the brace that closes the one at `open` (code with comments already stripped). -1 if unbalanced. */
export function matchBrace(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i]!;
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(code, i, c) - 1;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

export type { SourceFile };
