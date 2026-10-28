/**
 * Plain-English usage figures shared by the server and the browser: the one number to show for "how much have I
 * used" (the tighter of the 5-hour and weekly limits) and what a costly task usually uses (from real past runs).
 * Pure: no database, no fetch, nothing heavy (the sidebar loads it on every page).
 */

/** The allowance numbers this module needs (a subset of UsageState in components/studio/usage.tsx). */
export interface Allowance {
  window: { used: number; limit: number; resetsAt: number | null };
  week: { used: number; limit: number; resetsAt: number | null };
  credits?: { balance: number; auto: boolean } | null;
}

export interface Headline {
  /** Share of the tighter limit used, 0–100, rounded down (100 only when it's really reached). */
  pct: number;
  scope: "week" | "window";
  resetsAt: number | null;
  /** "low" from 80% used; "out" when used up (and no extra usage would carry on). */
  state: "ok" | "low" | "out";
  /** At the limit, but extra usage pays for messages automatically. */
  onCredits: boolean;
}

const share = (used: number, limit: number) => (limit > 0 ? Math.max(0, used) / limit : 0);

/** The single figure to show: whichever of the 5-hour session and the week is closer to its limit. */
export function headline(a: Allowance): Headline {
  const week = share(a.week.used, a.week.limit);
  const win = share(a.window.used, a.window.limit);
  // The week wins ties: it's the limit people plan around.
  const weekly = week >= win;
  const s = weekly ? week : win;
  const pct = Math.min(100, Math.floor(s * 100));
  const onCredits = pct >= 100 && !!a.credits?.auto && a.credits.balance > 0;
  return { pct, scope: weekly ? "week" : "window", resetsAt: weekly ? a.week.resetsAt : a.window.resetsAt, state: pct >= 100 && !onCredits ? "out" : pct >= 80 ? "low" : "ok", onCredits };
}

/** Units → share of the weekly allowance, in whole percent (at least 1 when anything is used). */
export function weekPct(units: number, weeklyUnits: number): number {
  if (!(weeklyUnits > 0) || !(units > 0)) return 0;
  return Math.max(1, Math.round((units / weeklyUnits) * 100));
}

/**
 * Costly tasks that get an estimate before they start, and the usage records (model_runs.purpose) each one makes.
 * (Council and Arena work theirs out from the models picked: lib/council/estimate.ts.)
 */
export const ESTIMATED_FEATURES = {
  code_agent: { label: "coding task", purposes: ["code_agent"] },
  bug_fix: { label: "bug fix", purposes: ["bug_fix"] },
  qa_testing: { label: "testing task", purposes: ["qa_testing"] },
  deep_research: { label: "research run", purposes: ["deep_research"] },
  code_review: { label: "code review", purposes: ["code_review"] },
} as const;
export type EstimatedFeature = keyof typeof ESTIMATED_FEATURES;
export const isEstimatedFeature = (f: string): f is EstimatedFeature => Object.hasOwn(ESTIMATED_FEATURES, f);

/** A quiet gap this long between two records of the same feature starts a new run. */
export const RUN_GAP_MS = 15 * 60_000;

/**
 * Units per run from usage records of one feature: records closer than RUN_GAP_MS belong to the same run. Records
 * don't carry a run id, so two runs started back to back count as one (the estimate errs high, never low).
 */
export function runsFromRecords(rows: { at: number; units: number }[], gapMs = RUN_GAP_MS): number[] {
  const sorted = [...rows].filter((r) => Number.isFinite(r.at)).sort((a, b) => a.at - b.at);
  const runs: number[] = [];
  let last = -Infinity;
  for (const r of sorted) {
    if (r.at - last > gapMs) runs.push(0);
    runs[runs.length - 1]! += Math.max(0, r.units || 0);
    last = r.at;
  }
  return runs.filter((u) => u > 0);
}

export interface RunEstimate {
  /** Typical (median) units per run, and the range seen. */
  typical: number;
  low: number;
  high: number;
  runs: number;
  source: "you" | "everyone";
}

/** The median and range of past runs; null with fewer than `min` runs (too few to say "usually"). */
export function estimateRuns(runs: number[], source: RunEstimate["source"], min = 2): RunEstimate | null {
  if (runs.length < min) return null;
  const s = [...runs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  const typical = s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  return { typical, low: s[0]!, high: s[s.length - 1]!, runs: s.length, source };
}
