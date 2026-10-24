import { isEngineering } from "./categories";

/**
 * Regression memory for one repository: what came back after being fixed, what has been seen scan after scan,
 * which files keep collecting problems, which mistakes repeat across files, and how this scan compares with
 * the last one. Built from the stored findings (already access-controlled per user) — history guides where to
 * look; it never stands in for re-checking the current code. Only rule ids, file paths and titles are kept:
 * no code, no secrets.
 */

export interface StoredFindingRow {
  fingerprint: string;
  rule_id: string;
  title: string;
  location: string | null;
  status: string;
  occurrences: number;
  first_seen: string;
  last_run_id: string | null;
}

export interface MemorySummary {
  regressions: { title: string; location: string | null; rule: string }[];
  longStanding: { title: string; location: string | null; scans: number; since: string }[];
  fragile: { file: string; open: number; regressions: number; rules: string[] }[];
  patterns: { rule: string; files: number; open: number }[];
  previous: { at: string; counts: Counts } | null;
  counts: Counts;
  delta: Partial<Record<keyof Counts, number>>;
  resolvedThisScan: number;
  unavailable: string[];
}

export interface Counts {
  defects: number;
  dependencies: number;
  maintainability: number;
  security: number;
}

export function countFindings(ruleIds: string[]): Counts {
  const c: Counts = { defects: 0, dependencies: 0, maintainability: 0, security: 0 };
  for (const r of ruleIds) {
    if (r.startsWith("quality.")) c.defects++;
    else if (r.startsWith("compat.")) c.dependencies++;
    else if (r.startsWith("arch.")) c.maintainability++;
    else if (!isEngineering(r)) c.security++;
  }
  return c;
}

const fileOf = (loc: string | null) => (loc ? loc.replace(/:\d+$/, "") : null);
const OPEN = new Set(["open", "investigating", "fix_proposed"]);

export function buildMemory(input: { rows: StoredFindingRow[]; runId: string; reopened: string[]; resolvedThisScan: number; previous: { at: string; counts: Counts } | null }): MemorySummary {
  const current = input.rows.filter((r) => r.last_run_id === input.runId);
  const open = input.rows.filter((r) => OPEN.has(r.status));
  const reopened = new Set(input.reopened);
  const regressions = current.filter((r) => reopened.has(r.fingerprint)).map((r) => ({ title: r.title, location: r.location, rule: r.rule_id }));
  const longStanding = current
    .filter((r) => r.occurrences >= 3 && OPEN.has(r.status))
    .sort((a, b) => b.occurrences - a.occurrences)
    .slice(0, 10)
    .map((r) => ({ title: r.title, location: r.location, scans: r.occurrences, since: r.first_seen.slice(0, 10) }));

  const byFile = new Map<string, { open: number; regressions: number; rules: Set<string> }>();
  for (const r of open) {
    const f = fileOf(r.location);
    if (!f || !f.includes("/") || f.endsWith(".json")) continue;
    const cur = byFile.get(f) ?? { open: 0, regressions: 0, rules: new Set<string>() };
    cur.open++;
    cur.rules.add(r.rule_id);
    if (reopened.has(r.fingerprint)) cur.regressions++;
    byFile.set(f, cur);
  }
  const fragile = [...byFile.entries()]
    .filter(([, v]) => v.open >= 3 || v.regressions > 0)
    .sort((a, b) => b[1].regressions - a[1].regressions || b[1].open - a[1].open)
    .slice(0, 10)
    .map(([file, v]) => ({ file, open: v.open, regressions: v.regressions, rules: [...v.rules].slice(0, 5) }));

  const byRule = new Map<string, Set<string>>();
  for (const r of open) {
    const f = fileOf(r.location);
    if (f) (byRule.get(r.rule_id) ?? byRule.set(r.rule_id, new Set()).get(r.rule_id)!).add(f);
  }
  const patterns = [...byRule.entries()]
    .filter(([, files]) => files.size >= 3)
    .map(([rule, files]) => ({ rule, files: files.size, open: open.filter((r) => r.rule_id === rule).length }))
    .sort((a, b) => b.files - a.files)
    .slice(0, 8);

  const counts = countFindings(current.map((r) => r.rule_id));
  const delta: MemorySummary["delta"] = {};
  if (input.previous) for (const k of Object.keys(counts) as (keyof Counts)[]) delta[k] = counts[k] - (input.previous.counts[k] ?? 0);
  return {
    regressions,
    longStanding,
    fragile,
    patterns,
    previous: input.previous,
    counts,
    delta,
    resolvedThisScan: input.resolvedThisScan,
    unavailable: ["Flaky tests and test history: Orbis doesn't run your test suite during an audit (the coding agent runs tests when it fixes something, in its own sandbox)."],
  };
}
