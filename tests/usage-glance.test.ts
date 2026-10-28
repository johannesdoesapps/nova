/**
 * Plain-English usage: the one figure the sidebar shows, what a costly task usually uses (from past usage records),
 * the sentence shown before it starts, and what upgrading gives at a limit (in numbers).
 */
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_BILLING } from "@/lib/plans";
import { estimateRuns, headline, RUN_GAP_MS, runsFromRecords, weekPct } from "@/lib/usage-glance";
import { upgradeLine } from "@/lib/usage-upgrade";

vi.mock("server-only", () => ({}));

const allowance = (week: [number, number], win: [number, number], credits?: { balance: number; auto: boolean }) => ({
  week: { used: week[0], limit: week[1], resetsAt: 2_000 },
  window: { used: win[0], limit: win[1], resetsAt: 1_000 },
  credits,
});

describe("the sidebar's one figure", () => {
  it("shows the week unless the 5-hour session is closer to its limit", () => {
    expect(headline(allowance([300, 1100], [10, 200]))).toMatchObject({ pct: 27, scope: "week", resetsAt: 2_000, state: "ok" });
    expect(headline(allowance([300, 1100], [190, 200]))).toMatchObject({ pct: 95, scope: "window", resetsAt: 1_000, state: "low" });
  });
  it("rounds down, so 100% only shows when the limit is really reached", () => {
    expect(headline(allowance([1099.9, 1100], [0, 200])).pct).toBe(99);
    expect(headline(allowance([1100, 1100], [0, 200]))).toMatchObject({ pct: 100, state: "out" });
  });
  it("at the limit with extra usage on, says so instead of 'used up'", () => {
    expect(headline(allowance([1100, 1100], [0, 200], { balance: 50, auto: true }))).toMatchObject({ state: "low", onCredits: true });
    expect(headline(allowance([1100, 1100], [0, 200], { balance: 50, auto: false }))).toMatchObject({ state: "out", onCredits: false });
  });
  it("copes with nothing used and odd limits", () => {
    expect(headline(allowance([0, 1100], [0, 200]))).toMatchObject({ pct: 0, state: "ok" });
    expect(headline(allowance([5, 0], [0, 0])).pct).toBe(0);
  });
});

describe("what a task usually uses", () => {
  const t0 = Date.parse("2026-10-20T10:00:00Z");
  const min = 60_000;
  it("groups usage records into runs by quiet gaps", () => {
    const rows = [
      { at: t0, units: 20 },
      { at: t0 + 2 * min, units: 30 },
      { at: t0 + 10 * min, units: 10 }, // same run: gaps under 15 minutes
      { at: t0 + 60 * min, units: 40 }, // a new run
      { at: t0 + 61 * min, units: 0 },
      { at: t0 + 300 * min, units: 0 }, // a run that charged nothing (failed and refunded) isn't counted
    ];
    expect(runsFromRecords(rows)).toEqual([60, 40]);
    // Order doesn't matter (records come newest first).
    expect(runsFromRecords([...rows].reverse())).toEqual([60, 40]);
    expect(RUN_GAP_MS).toBe(15 * min);
  });
  it("gives the median and range, and nothing from a single run", () => {
    expect(estimateRuns([60], "you")).toBeNull();
    expect(estimateRuns([60, 40], "you")).toEqual({ typical: 50, low: 40, high: 60, runs: 2, source: "you" });
    expect(estimateRuns([10, 90, 30], "everyone")).toMatchObject({ typical: 30, low: 10, high: 90, runs: 3 });
  });
  it("turns units into a share of the week, at least 1% when anything is used", () => {
    expect(weekPct(55, 1100)).toBe(5);
    expect(weekPct(2, 1100)).toBe(1);
    expect(weekPct(0, 1100)).toBe(0);
    expect(weekPct(10, 0)).toBe(0);
  });
});

describe("what upgrading gives at a limit", () => {
  it("names the next plan, its price and how much more, for the limit that was reached", () => {
    expect(upgradeLine(DEFAULT_BILLING, "free", "week")).toBe(" Pro ($28/month) includes 36× this weekly allowance.");
    expect(upgradeLine(DEFAULT_BILLING, "pro", "window")).toBe(" Max ($153/month) includes 10× the allowance per 5-hour session.");
    expect(upgradeLine(DEFAULT_BILLING, "free", "budget")).toMatch(/^ Pro \(\$28\/month\) includes \d+× the monthly AI allowance\.$/);
    expect(upgradeLine(DEFAULT_BILLING, "free", "day")).toBe(" Pro ($28/month) has no daily message limit.");
    expect(upgradeLine(DEFAULT_BILLING, "pro", "tokens")).toBe(" Max ($153/month) includes 4× the monthly tokens.");
  });
  it("says nothing on the biggest plan, and stays vague when it can't compare", () => {
    expect(upgradeLine(DEFAULT_BILLING, "max", "week")).toBe("");
    expect(upgradeLine(DEFAULT_BILLING, "pro", "top_week")).toBe(" Max ($153/month) includes more.");
  });
  it("never shows AI budgets in dollars, only ratios", () => {
    for (const scope of ["budget", "daily"] as const) expect(upgradeLine(DEFAULT_BILLING, "pro", scope)).not.toMatch(/\$\d+(\.\d+)? (of|AI|budget)/);
  });
});
