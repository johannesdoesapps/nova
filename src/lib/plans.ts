import { z } from "zod";
import type { Capability, ModelInfo } from "./ai/types";

/**
 * Plans and their economics. Free, Pro and Max, priced in USD. Usage is
 * paced Claude-style (a 5-hour window and a rolling weekly cap, in usage
 * units) and protected by a monthly AI budget per account that keeps the
 * target profit margin (see docs/PRICING.md for the numbers behind the
 * defaults). Administrators change everything below in Admin → Plans &
 * pricing; these are the defaults.
 */
export type PlanId = "free" | "pro" | "max";
export const PLAN_IDS = ["free", "pro", "max"] as const;
export type BillingInterval = "month" | "year";
/** Model access tiers: standard models on every plan, advanced from Pro, premium on Max. */
export type ModelTier = "standard" | "advanced" | "premium";
export const MODEL_TIERS = ["standard", "advanced", "premium"] as const;

const planSchema = z.object({
  label: z.string().min(1).max(40),
  /** Monthly price in USD (0 for Free). */
  priceUsd: z.number().min(0).max(10_000),
  /** Discount for paying yearly, in percent (Pro and Max). */
  annualDiscountPct: z.number().min(0).max(80).default(10),
  windowUnits: z.number().int().min(1).max(1_000_000),
  weeklyUnits: z.number().int().min(1).max(10_000_000),
  /** Model tiers this plan may use. */
  tiers: z.array(z.enum(MODEL_TIERS)).min(1),
  /** Longest reply per request, in tokens. */
  maxOutputTokens: z.number().int().min(256).max(64_000),
  /** How much conversation history is sent with each message, in characters. */
  historyChars: z.number().int().min(2_000).max(400_000),
  /** Web searches per budget period (only when search is set up). */
  webSearchesPerPeriod: z.number().int().min(0).max(100_000),
  /** Free only: fixed monthly AI budget in USD (paid plans derive theirs from the margin). */
  aiBudgetUsd: z.number().min(0).max(10_000).optional(),
});
export type Plan = z.infer<typeof planSchema> & { id: PlanId };

export const billingSettingsSchema = z.object({
  plans: z.object({ free: planSchema, pro: planSchema, max: planSchema }),
  /** Share of revenue that must remain as profit after all costs below and AI usage. */
  targetMargin: z.number().min(0).max(0.95).default(0.6),
  /** Payment processing per charge: percent (card + Stripe Billing) and fixed USD. */
  paymentFeePercent: z.number().min(0).max(20).default(3.6),
  paymentFeeFixedUsd: z.number().min(0).max(5).default(0.3),
  /** Attributable hosting and other costs per paying subscriber per month, USD. */
  overheadPerSubscriberUsd: z.number().min(0).max(1000).default(0.5),
  /** Free users' AI cost carried by each paying subscriber per month, USD. */
  freeSubsidyPerSubscriberUsd: z.number().min(0).max(1000).default(1),
  /** Held back from the AI budget for estimate error, international card fees and refunds, in percent. */
  safetyBufferPct: z.number().min(0).max(90).default(15),
  /** Cost of one web search, USD. */
  webSearchCostUsd: z.number().min(0).max(1).default(0.01),
  /** Share of the AI budget after which only the lowest-cost model may be used. */
  premiumBudgetShare: z.number().min(0.1).max(1).default(0.8),
  /** Usage units per message by model tier (admins can still override single models). */
  tierUnits: z.object({ standard: z.number().min(0).max(1000), advanced: z.number().min(0).max(1000), premium: z.number().min(0).max(1000) }),
  /** Tier overrides by model id (which plans include a model). */
  modelTiers: z.record(z.string().min(1).max(120), z.enum(MODEL_TIERS)).default({}),
});
export type BillingSettings = z.infer<typeof billingSettingsSchema>;

/**
 * Defaults, from docs/PRICING.md: official API prices (2026-10-19), a
 * conservative request mix, 60% margin, 3.6% + $0.30 per charge, $0.50
 * hosting and $1 free-user subsidy per subscriber, 15% safety buffer.
 * Pro $20 → $4.66/month AI budget; Max $100 → $29.41.
 */
export const DEFAULT_BILLING: BillingSettings = {
  plans: {
    free: { label: "Free", priceUsd: 0, annualDiscountPct: 0, windowUnits: 10, weeklyUnits: 30, tiers: ["standard"], maxOutputTokens: 1200, historyChars: 12_000, webSearchesPerPeriod: 0, aiBudgetUsd: 0.1 },
    pro: { label: "Pro", priceUsd: 20, annualDiscountPct: 10, windowUnits: 200, weeklyUnits: 1100, tiers: ["standard", "advanced"], maxOutputTokens: 2400, historyChars: 24_000, webSearchesPerPeriod: 100 },
    max: { label: "Max", priceUsd: 100, annualDiscountPct: 10, windowUnits: 600, weeklyUnits: 3200, tiers: ["standard", "advanced", "premium"], maxOutputTokens: 4800, historyChars: 80_000, webSearchesPerPeriod: 500 },
  },
  targetMargin: 0.6,
  paymentFeePercent: 3.6,
  paymentFeeFixedUsd: 0.3,
  overheadPerSubscriberUsd: 0.5,
  freeSubsidyPerSubscriberUsd: 1,
  safetyBufferPct: 15,
  webSearchCostUsd: 0.01,
  premiumBudgetShare: 0.8,
  tierUnits: { standard: 1, advanced: 20, premium: 40 },
  modelTiers: {},
};

/** Stored admin changes merged over the defaults (invalid stored values fall back to defaults). */
export function resolveBilling(stored: unknown): BillingSettings {
  const s = (stored ?? {}) as Partial<BillingSettings> & { plans?: Partial<Record<PlanId, Partial<Plan>>> };
  const merged = {
    ...DEFAULT_BILLING,
    ...s,
    tierUnits: { ...DEFAULT_BILLING.tierUnits, ...(s.tierUnits ?? {}) },
    modelTiers: { ...(s.modelTiers ?? {}) },
    plans: {
      free: { ...DEFAULT_BILLING.plans.free, ...(s.plans?.free ?? {}) },
      pro: { ...DEFAULT_BILLING.plans.pro, ...(s.plans?.pro ?? {}) },
      max: { ...DEFAULT_BILLING.plans.max, ...(s.plans?.max ?? {}) },
    },
  };
  const parsed = billingSettingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : DEFAULT_BILLING;
}

/** Like resolveBilling, but reports what's invalid instead of falling back (for the admin editor). */
export function validateBilling(stored: unknown): { ok: true; billing: BillingSettings } | { ok: false; error: string } {
  const s = (stored ?? {}) as Partial<BillingSettings> & { plans?: Partial<Record<PlanId, Partial<Plan>>> };
  const r = billingSettingsSchema.safeParse({
    ...DEFAULT_BILLING,
    ...s,
    tierUnits: { ...DEFAULT_BILLING.tierUnits, ...(s.tierUnits ?? {}) },
    modelTiers: { ...(s.modelTiers ?? {}) },
    plans: {
      free: { ...DEFAULT_BILLING.plans.free, ...(s.plans?.free ?? {}) },
      pro: { ...DEFAULT_BILLING.plans.pro, ...(s.plans?.pro ?? {}) },
      max: { ...DEFAULT_BILLING.plans.max, ...(s.plans?.max ?? {}) },
    },
  });
  if (!r.success) {
    const i = r.error.issues[0]!;
    return { ok: false, error: `Plans & pricing: ${i.path.join(".")} — ${i.message}` };
  }
  const b = r.data;
  if (!b.plans.free.tiers.includes("standard")) return { ok: false, error: "Plans & pricing: Free must include standard models." };
  for (const id of PLAN_IDS) {
    if (b.plans[id].weeklyUnits < b.plans[id].windowUnits) return { ok: false, error: `Plans & pricing: ${b.plans[id].label}'s weekly allowance must be at least its 5-hour allowance.` };
  }
  if (b.plans.pro.priceUsd <= 0 || b.plans.max.priceUsd <= 0) return { ok: false, error: "Plans & pricing: paid plans need a price above $0." };
  return { ok: true, billing: b };
}

export function planOf(billing: BillingSettings, id: PlanId): Plan {
  return { ...billing.plans[id], id };
}

/** The price charged per interval, in whole dollars for annual plans. */
export function chargeUsd(plan: Plan, interval: BillingInterval): number {
  if (interval === "month" || plan.priceUsd === 0) return plan.priceUsd;
  return Math.round(plan.priceUsd * 12 * (1 - plan.annualDiscountPct / 100));
}

export interface PlanEconomics {
  /** Revenue per month (annual plans spread over 12 months). */
  revenueUsd: number;
  /** Most the plan may cost per month and still keep the target margin. */
  maxCostUsd: number;
  feesUsd: number;
  overheadUsd: number;
  bufferUsd: number;
  /** What's left for AI usage per month. */
  aiBudgetUsd: number;
}

/**
 * The monthly AI budget that keeps the target margin:
 * (revenue × (1 − margin) − payment fees − overheads) × (1 − safety buffer).
 */
export function planEconomics(billing: BillingSettings, id: PlanId, interval: BillingInterval = "month"): PlanEconomics {
  const plan = planOf(billing, id);
  if (plan.priceUsd === 0) {
    const ai = plan.aiBudgetUsd ?? 0;
    return { revenueUsd: 0, maxCostUsd: 0, feesUsd: 0, overheadUsd: 0, bufferUsd: 0, aiBudgetUsd: ai };
  }
  const charge = chargeUsd(plan, interval);
  const perMonth = interval === "year" ? 1 / 12 : 1;
  const revenueUsd = charge * perMonth;
  const maxCostUsd = revenueUsd * (1 - billing.targetMargin);
  const feesUsd = ((charge * billing.paymentFeePercent) / 100 + billing.paymentFeeFixedUsd) * perMonth;
  const overheadUsd = billing.overheadPerSubscriberUsd + billing.freeSubsidyPerSubscriberUsd;
  const beforeBuffer = Math.max(0, maxCostUsd - feesUsd - overheadUsd);
  const bufferUsd = (beforeBuffer * billing.safetyBufferPct) / 100;
  const r = (n: number) => Math.round(n * 10_000) / 10_000;
  return { revenueUsd: r(revenueUsd), maxCostUsd: r(maxCostUsd), feesUsd: r(feesUsd), overheadUsd: r(overheadUsd), bufferUsd: r(bufferUsd), aiBudgetUsd: r(beforeBuffer - bufferUsd) };
}

/**
 * An average request in the default usage mix (docs/PRICING.md), retries
 * included: 5,000 input and 960 output tokens. Used for capacity estimates.
 */
export const TYPICAL_REQUEST = { inputTokens: 5000, outputTokens: 960 } as const;

/** Estimated cost of a typical request on a model, in USD (null without a verified price). */
export function typicalRequestUsd(m: Pick<ModelInfo, "inputPrice" | "outputPrice">): number | null {
  if (m.inputPrice === null || m.outputPrice === null) return null;
  return (TYPICAL_REQUEST.inputTokens * m.inputPrice + TYPICAL_REQUEST.outputTokens * m.outputPrice) / 1_000_000;
}

/** The monthly price needed for a given monthly AI budget at the target margin (inverse of planEconomics). */
export function priceForBudget(billing: BillingSettings, aiBudgetUsd: number): number | null {
  const denom = 1 - billing.targetMargin - billing.paymentFeePercent / 100;
  if (denom <= 0) return null;
  const beforeBuffer = aiBudgetUsd / (1 - billing.safetyBufferPct / 100);
  return Math.round(((beforeBuffer + billing.paymentFeeFixedUsd + billing.overheadPerSubscriberUsd + billing.freeSubsidyPerSubscriberUsd) / denom) * 100) / 100;
}

/** A model's tier: set in the registry, else premium never by default, advanced unless tagged low-cost. */
export function modelTier(m: Pick<ModelInfo, "capabilities"> & { tier?: ModelTier }): ModelTier {
  return m.tier ?? (m.capabilities.includes("low-cost") ? "standard" : "advanced");
}

/** The cheapest plan that includes a tier. */
export function planForTier(billing: BillingSettings, tier: ModelTier): PlanId {
  return PLAN_IDS.find((id) => billing.plans[id].tiers.includes(tier)) ?? "max";
}

export const WINDOW_MS = 5 * 60 * 60 * 1000;
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Units per message for an advanced model by default (about 20× a standard model's cost). */
export const LARGE_MODEL_UNITS = DEFAULT_BILLING.tierUnits.advanced;

/**
 * Units per message for a model: the admin's per-model override if set, else
 * by tier (standard 1, advanced 20, premium 40 by default) — roughly the
 * ratio of their average cost per message.
 */
export function modelUnits(
  model: readonly Capability[] | (Pick<ModelInfo, "capabilities"> & { tier?: ModelTier }) | undefined,
  override?: number,
  tierUnits: BillingSettings["tierUnits"] = DEFAULT_BILLING.tierUnits,
): number {
  if (override !== undefined) return override;
  const m = Array.isArray(model) ? { capabilities: [...model] } : ((model as Pick<ModelInfo, "capabilities"> & { tier?: ModelTier }) ?? { capabilities: [] });
  return tierUnits[modelTier(m)];
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

/** Units left before either the 5-hour window or the weekly cap is reached. */
export function unitsLeft(u: UsageState): number {
  return Math.max(0, Math.min(u.window.limit - u.window.used, u.week.limit - u.week.used));
}

/**
 * A window opens with the first message after the previous one closed and
 * lasts five hours; the weekly cap counts everything in the last seven days.
 * `runs` must be sorted oldest first.
 */
export function computeUsage(runs: UnitRun[], now: number, plan: Pick<Plan, "id" | "windowUnits" | "weeklyUnits">): UsageState {
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

/** Defaults as plans, for code and tests that don't need admin overrides. */
export const PLANS: Record<PlanId, Plan> = {
  free: planOf(DEFAULT_BILLING, "free"),
  pro: planOf(DEFAULT_BILLING, "pro"),
  max: planOf(DEFAULT_BILLING, "max"),
};
