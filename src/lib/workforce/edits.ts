import { protectedPath } from "./checks";
import type { Edit } from "./schemas";

const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

export interface EditPolicy {
  /** Paths the agent may touch (plan files, changed files…). Test files are always allowed. */
  allowed: Set<string>;
  existing: Set<string>;
  allowDependencyChanges: boolean;
}

/**
 * Compute the result of a set of edits without writing anything. Either every
 * edit applies cleanly or none do, and the problems are returned so the model
 * can correct itself.
 */
export function planEdits(edits: Edit[], current: Map<string, string | null>, policy: EditPolicy): { ok: true; files: Map<string, string> } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const next = new Map<string, string>();
  for (const e of edits) {
    const path = e.path.replace(/^\.\//, "");
    const prot = protectedPath(path, policy.allowDependencyChanges);
    if (prot) {
      errors.push(`${path}: writing ${prot} isn't permitted.`);
      continue;
    }
    if (!policy.allowed.has(path) && !TEST_FILE.test(path)) {
      errors.push(`${path}: not part of the approved plan. Only change the planned files (and test files).`);
      continue;
    }
    const base = next.get(path) ?? current.get(path) ?? null;
    if (e.action === "write") {
      if (base !== null && policy.existing.has(path)) {
        errors.push(`${path}: already exists — use "replace" edits for existing files instead of rewriting them.`);
        continue;
      }
      next.set(path, e.content);
      continue;
    }
    if (base === null) {
      errors.push(`${path}: file not found, so "replace" can't apply. Use "write" for new files.`);
      continue;
    }
    const count = base.split(e.search).length - 1;
    if (count === 0) errors.push(`${path}: the search text wasn't found. Copy it exactly from the current file, including whitespace.`);
    else if (count > 1) errors.push(`${path}: the search text appears ${count} times. Include more surrounding lines so it's unique.`);
    else next.set(path, base.replace(e.search, () => e.replace));
  }
  return errors.length ? { ok: false, errors } : { ok: true, files: next };
}

/** Lines added by a unified diff, by file. */
export function addedLines(diff: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let file: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      file = line.slice(4).replace(/^b\//, "").trim();
      if (file === "/dev/null") file = null;
      continue;
    }
    if (file && line.startsWith("+") && !line.startsWith("+++")) (out.get(file) ?? out.set(file, []).get(file)!).push(line.slice(1));
  }
  return out;
}

/** New-file line numbers of added lines, by file. */
export function addedLineNumbers(diff: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let file: string | null = null;
  let line = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++ ")) {
      file = l.slice(4).replace(/^b\//, "").trim();
      if (file === "/dev/null") file = null;
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) {
      line = Number(h[1]);
      continue;
    }
    if (!file || l.startsWith("--- ") || l.startsWith("diff ")) continue;
    if (l.startsWith("+")) {
      (out.get(file) ?? out.set(file, new Set()).get(file)!).add(line);
      line++;
    } else if (l.startsWith(" ")) line++;
  }
  return out;
}

/** Repository paths mentioned in tool output (e.g. "src/a.ts:12:5"). */
export function pathsInOutput(output: string, known: Set<string>): string[] {
  const found = new Set<string>();
  for (const m of output.matchAll(/([A-Za-z0-9_@./()[\]-]+\.(?:tsx?|jsx?|mjs|cjs|py|css|json))(?::\d+)?/g)) {
    const p = m[1]!.replace(/^\.\//, "").replace(/^\/vercel\/sandbox\//, "");
    if (known.has(p)) found.add(p);
  }
  return [...found];
}

/** Keywords from free text for code search. */
export function keywords(text: string, max = 8): string[] {
  const stop = new Set("this that with from into when then than have will should would could there their which while where what about after before other these those page pages file files code make makes added adding update updates change changes using user users nova test tests".split(" "));
  const ids = [...text.matchAll(/`([^`]{3,60})`/g)].map((m) => m[1]!);
  const words = (text.match(/[A-Za-z_][A-Za-z0-9_.-]{3,40}/g) ?? []).filter((w) => !stop.has(w.toLowerCase()));
  const freq = new Map<string, number>();
  for (const w of [...ids, ...words]) freq.set(w, (freq.get(w) ?? 0) + (ids.includes(w) ? 3 : /[A-Z_.]/.test(w.slice(1)) ? 2 : 1));
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w).slice(0, max);
}
