import { describe, expect, it } from "vitest";
import { PLANS, WEEK_MS, WINDOW_MS, checkUsage, computeUsage, modelUnits } from "@/lib/plans";

const H = 60 * 60 * 1000;
const now = Date.UTC(2026, 9, 20, 12);
const runs = (...hoursAgo: number[]) => hoursAgo.sort((a, b) => b - a).map((h) => ({ at: now - h * H, units: 1 }));

describe("5-hour windows", () => {
  it("opens a window at the first message and resets five hours later", () => {
    const u = computeUsage(runs(3, 2, 1), now, PLANS.free);
    expect(u.window).toEqual({ used: 3, limit: 15, resetsAt: now - 3 * H + WINDOW_MS });
  });

  it("starts fresh once the window has closed, but still counts the week", () => {
    const u = computeUsage(runs(8, 7, 6), now, PLANS.free);
    expect(u.window.used).toBe(0);
    expect(u.window.resetsAt).toBeNull();
    expect(u.week.used).toBe(3);
  });

  it("chains windows: a message after a window closes opens the next one", () => {
    const u = computeUsage(runs(9, 3.5, 3, 1), now, PLANS.free);
    expect(u.window.used).toBe(3);
    expect(u.window.resetsAt).toBe(now - 3.5 * H + WINDOW_MS);
  });

  it("drops runs older than a week from the weekly total", () => {
    const u = computeUsage([{ at: now - WEEK_MS - H, units: 50 }, { at: now - H, units: 2 }], now, PLANS.free);
    expect(u.week.used).toBe(2);
  });

  it("blocks when the window or the week is used up, with the reset time", () => {
    const full = computeUsage(Array.from({ length: 15 }, (_, i) => ({ at: now - H + i, units: 1 })), now, PLANS.free);
    expect(checkUsage(full, 1, now)).toEqual({ ok: false, scope: "window", resetsAt: now - H + WINDOW_MS });
    const pro = computeUsage(Array.from({ length: 15 }, (_, i) => ({ at: now - H + i, units: 1 })), now, PLANS.pro);
    expect(checkUsage(pro, 1, now)).toEqual({ ok: true });
    const week = { ...pro, week: { used: 1000, limit: 1000, resetsAt: now + H } };
    expect(checkUsage(week, 1, now)).toEqual({ ok: false, scope: "week", resetsAt: now + H });
  });

  it("charges larger models more of the allowance", () => {
    expect(modelUnits(["chat", "low-cost"])).toBe(1);
    expect(modelUnits(["chat", "reasoning"])).toBeGreaterThan(1);
  });
});
