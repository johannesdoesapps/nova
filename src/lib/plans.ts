import type { Capability } from "./ai/types";

/**
 * Usage plans, Claude-style: a 5-hour window that starts with your first
 * message and a rolling weekly cap. Limits are in usage units: a message to a
 * low-cost model is 1 unit, a message to a larger model counts as more, so no
 * plan can cost more to serve than it brings in.
 */
export type PlanId = "free" | "pro";

export interface Plan {
  id: PlanId;
  label: string;
  windowUnits: number;
  weeklyUnits: number;
}

export const PLANS: Record<PlanId, Plan> = {
  free: { id: "free", label: "Free", windowUnits: 15, weeklyUnits: 100 },
  pro: { id: "pro", label: "Pro", windowUnits: 150, weeklyUnits: 1000 },
};

export const WINDOW_MS = 5 * 60 * 60 * 1000;
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Larger models cost roughly 10–20× more per message, so they use more of the allowance. */
export const LARGE_MODEL_UNITS = 15;

/** Units per message for a model: the admin's override if set, else 1 for low-cost models and 15 otherwise. */
export function modelUnits(capabilities: readonly Capability[] | undefined, override?: number): number {
  if (override !== undefined) return override;
  return capabilities?.includes("low-cost") ? 1 : LARGE_MODEL_UNITS;
}

export interface UnitRun {
  /** Epoch milliseconds. */
  at: number;
  units: number;
}

export interface UsageState {
  plan: PlanId;
  window: { used: number; limit: number; resetsAt: number | null };
  week: { used: number; limit: number; resetsAt: number | null };
}

/**
 * A window opens with the first message after the previous one closed and
 * lasts five hours; the weekly cap counts everything in the last seven days.
 * `runs` must be sorted oldest first.
 */
export function computeUsage(runs: UnitRun[], now: number, plan: Plan): UsageState {
  const recent = runs.filter((r) => r.at > now - WEEK_MS && r.at <= now);
  let windowStart: number | null = null;
  for (const r of recent) {
    if (windowStart === null || r.at >= windowStart + WINDOW_MS) windowStart = r.at;
  }
  const active = windowStart !== null && now < windowStart + WINDOW_MS;
  const windowUsed = active ? recent.filter((r) => r.at >= windowStart!).reduce((s, r) => s + r.units, 0) : 0;
  const weekUsed = recent.reduce((s, r) => s + r.units, 0);
  return {
    plan: plan.id,
    window: { used: windowUsed, limit: plan.windowUnits, resetsAt: active ? windowStart! + WINDOW_MS : null },
    week: { used: weekUsed, limit: plan.weeklyUnits, resetsAt: recent.length ? recent[0]!.at + WEEK_MS : null },
  };
}

export type LimitCheck = { ok: true } | { ok: false; scope: "window" | "week"; resetsAt: number };

/** Can a request costing `units` run now? The weekly cap wins when both are hit. */
export function checkUsage(state: UsageState, units: number, now: number): LimitCheck {
  if (state.week.used + units > state.week.limit) {
    return { ok: false, scope: "week", resetsAt: state.week.resetsAt ?? now + WEEK_MS };
  }
  if (state.window.used + units > state.window.limit) {
    return { ok: false, scope: "window", resetsAt: state.window.resetsAt ?? now + WINDOW_MS };
  }
  return { ok: true };
}
