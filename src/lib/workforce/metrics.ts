import { AGENTS } from "./agents";
import type { CheckResult, Step, Task } from "./types";

/**
 * Evaluation metrics computed only from stored task and step records.
 * Costs are estimates from token counts and registry prices.
 */
export interface Metrics {
  totals: Record<string, number>;
  rates: { completion: number | null; verified: number | null; checkPass: number | null; humanIntervention: number | null; cancellation: number | null; retryPerTask: number | null };
  durations: { avgTaskMs: number | null; samples: number };
  cost: { totalUsd: number; perCompletedUsd: number | null; unpricedCalls: number; tokens: number; sandboxMinutes: number; note: string };
  findings: { review: Record<string, number>; security: Record<string, number> };
  agents: { id: string; name: string; runs: number; succeeded: number; failed: number; avgMs: number | null; tokens: number }[];
  benchmarks: { suite: string; versions: string; runs: number; verified: number; avgMs: number | null; avgCostUsd: number | null }[];
  definitions: Record<string, string>;
}

const ratio = (a: number, b: number) => (b ? a / b : null);

export function computeMetrics(tasks: Task[], steps: Step[], humanDecisions: Set<string>): Metrics {
  const finished = tasks.filter((t) => ["completed", "failed", "cancelled", "needs_attention"].includes(t.status) && t.finished_at !== undefined);
  const reachedVerify = tasks.filter((t) => t.verification);
  const verified = tasks.filter((t) => t.verification?.verdict === "verified");
  const completed = tasks.filter((t) => t.status === "completed");
  const checkResults = steps.filter((s) => /^test-\d+$/.test(s.key) && s.status === "succeeded").flatMap((s) => ((s.output as { results?: CheckResult[] } | null)?.results ?? []).filter((r) => r.required));
  const durations = finished.filter((t) => t.started_at && t.finished_at).map((t) => new Date(t.finished_at!).getTime() - new Date(t.started_at!).getTime());
  const count = (statuses: string[]) => tasks.filter((t) => statuses.includes(t.status)).length;
  const reviewF: Record<string, number> = {};
  const secF: Record<string, number> = {};
  for (const s of steps) {
    if (s.key === "review" && s.status === "succeeded") for (const f of ((s.output as { findings?: { severity: string }[] } | null)?.findings ?? [])) reviewF[f.severity] = (reviewF[f.severity] ?? 0) + 1;
    if (s.key === "security" && s.status === "succeeded") for (const f of ((s.output as { findings?: { severity: string }[] } | null)?.findings ?? [])) secF[f.severity] = (secF[f.severity] ?? 0) + 1;
  }
  const totalCost = tasks.reduce((n, t) => n + Number(t.spent_usd), 0);
  const bench = new Map<string, Task[]>();
  for (const t of tasks.filter((x) => x.benchmark)) {
    const k = `${t.benchmark}|${JSON.stringify(t.versions)}`;
    (bench.get(k) ?? bench.set(k, []).get(k)!).push(t);
  }
  return {
    totals: {
      tasks: tasks.length,
      active: count(["analyzing", "running", "verifying"]),
      queued: count(["created"]),
      awaitingApproval: count(["awaiting_approval", "planned"]),
      needsAttention: count(["needs_attention", "blocked"]),
      completed: completed.length,
      verified: verified.length,
      failed: count(["failed"]),
      cancelled: count(["cancelled"]),
      paused: count(["paused"]),
      timeouts: steps.filter((s) => /Timed out/.test(s.error ?? "")).length,
    },
    rates: {
      completion: ratio(completed.length, finished.length),
      verified: ratio(verified.length, reachedVerify.length),
      checkPass: ratio(checkResults.filter((r) => r.passed).length, checkResults.length),
      humanIntervention: ratio(finished.filter((t) => humanDecisions.has(t.id)).length, finished.length),
      cancellation: ratio(count(["cancelled"]), finished.length),
      retryPerTask: ratio(steps.reduce((n, s) => n + Math.max(0, s.attempt - 1), 0), tasks.length),
    },
    durations: { avgTaskMs: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null, samples: durations.length },
    cost: {
      totalUsd: totalCost,
      perCompletedUsd: completed.length ? totalCost / completed.length : null,
      unpricedCalls: tasks.reduce((n, t) => n + t.spent_unpriced_calls, 0),
      tokens: tasks.reduce((n, t) => n + t.tokens_used, 0),
      sandboxMinutes: tasks.reduce((n, t) => n + Number(t.sandbox_ms), 0) / 60_000,
      note: "Estimated from token counts and registry prices; calls on models without a known price are counted separately. Sandbox time is wall-clock duration reported when each workspace stops.",
    },
    findings: { review: reviewF, security: secF },
    agents: AGENTS.filter((a) => a.status === "active").map((a) => {
      const mine = steps.filter((s) => s.agent === a.id);
      const done = mine.filter((s) => s.started_at && s.finished_at);
      return {
        id: a.id,
        name: a.name,
        runs: mine.filter((s) => s.attempt > 0).length,
        succeeded: mine.filter((s) => s.status === "succeeded").length,
        failed: mine.filter((s) => s.status === "failed").length,
        avgMs: done.length ? done.reduce((n, s) => n + (new Date(s.finished_at!).getTime() - new Date(s.started_at!).getTime()), 0) / done.length : null,
        tokens: mine.reduce((n, s) => n + s.tokens, 0),
      };
    }),
    benchmarks: [...bench.entries()].map(([k, ts]) => {
      const done = ts.filter((t) => t.started_at && t.finished_at);
      return {
        suite: k.split("|")[0]!,
        versions: Object.entries(JSON.parse(k.slice(k.indexOf("|") + 1)) as Record<string, string>).map(([a, v]) => `${a}@${v}`).join(", "),
        runs: ts.length,
        verified: ts.filter((t) => t.verification?.verdict === "verified").length,
        avgMs: done.length ? done.reduce((n, t) => n + (new Date(t.finished_at!).getTime() - new Date(t.started_at!).getTime()), 0) / done.length : null,
        avgCostUsd: ts.length ? ts.reduce((n, t) => n + Number(t.spent_usd), 0) / ts.length : null,
      };
    }),
    definitions: {
      completion: "Completed ÷ finished (completed, failed, cancelled or needing attention).",
      verified: "Verified ÷ tasks that reached verification. Verified means every required check passed in a real run, the reviewer approved, all acceptance criteria were judged met and no blocking security finding.",
      checkPass: "Passed ÷ executed required checks across all post-change test rounds.",
      humanIntervention: "Finished tasks where a person decided an approval or requested rework ÷ finished tasks.",
      retryPerTask: "Extra step attempts ÷ tasks.",
    },
  };
}

/** Repeatable benchmark tasks with objective, checkable criteria. */
export const BENCHMARKS: Record<string, { title: string; objective: string; criteria: string[] }[]> = {
  "starter-v1": [
    {
      title: "Add clamp() utility with tests",
      objective: "Add an exported function `clamp(value: number, min: number, max: number): number` to src/lib/utils.ts that limits value to the [min, max] range (and returns min when value is NaN). Add a Vitest test file tests/clamp.test.ts covering below-min, above-max, in-range and NaN.",
      criteria: ["clamp is exported from src/lib/utils.ts", "tests/clamp.test.ts exists and covers below-min, above-max, in-range and NaN", "All required checks pass"],
    },
    {
      title: "Add formatDuration() helper with tests",
      objective: "Add an exported function `formatDuration(ms: number): string` to src/lib/utils.ts returning human-readable durations like \"850 ms\", \"12.3 s\" and \"4 min 05 s\". Add tests in tests/format-duration.test.ts.",
      criteria: ["formatDuration is exported from src/lib/utils.ts", "Tests cover the ms, seconds and minutes formats", "All required checks pass"],
    },
  ],
};
