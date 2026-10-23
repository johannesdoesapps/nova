import { z } from "zod";
import type { Capability, ModelInfo } from "./ai/types";
import { maxCodeRunCostUsd, workspaceMinuteCostUsd } from "./code/pricing";

/**
 * Plans and their economics. Free, Pro and Max, priced in USD. Usage is
 * paced Claude-style (a 5-hour window, a weekly limit that resets at a fixed
 * time for each account, and on Max a separate weekly limit for premium
 * models, all in usage units sized by what each request really costs) and
 * protected by a monthly AI budget per account that keeps the
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
  /** A separate weekly limit for premium-tier models, in units (0 = none; like Claude's weekly limit for its top models). */
  topWeeklyUnits: z.number().int().min(0).max(10_000_000).default(0),
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
  /** Share of the AI budget that advanced and premium models may use, in percent (the rest is for standard models). */
  premiumBudgetPct: z.number().min(0).max(100).default(0),
  /** User messages per day (UTC); 0 = no daily cap. */
  dailyMessages: z.number().int().min(0).max(100_000).default(0),
  /** Input + output tokens per budget period; 0 = no token cap (the money budget still applies). */
  monthlyTokens: z.number().int().min(0).max(10_000_000_000).default(0),
  /** Most of the monthly AI budget one day may use, in percent (0 = no daily money cap). */
  dailyBudgetPct: z.number().min(0).max(100).default(0),
  /** Code runs (the Run button) per budget period; 0 = none. */
  codeRunsPerPeriod: z.number().int().min(0).max(1_000_000).default(0),
  /** Code workspace computer time per budget period, in minutes; 0 = none. */
  workspaceMinutesPerPeriod: z.number().int().min(0).max(1_000_000).default(0),
  /** Code workspace projects a user may keep. */
  codeProjects: z.number().int().min(0).max(10_000).default(3),
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
  /** Taxes collected for authorities that are included in the prices, in percent (0 = prices exclude tax; Stripe Tax adds it). */
  taxIncludedPct: z.number().min(0).max(50).default(0),
  /** Expected refunds and chargebacks, in percent of revenue. */
  refundRatePct: z.number().min(0).max(50).default(2),
  /** Fixed monthly overhead (salaries, tools, base hosting), shown separately from contribution margin, USD. */
  fixedOverheadMonthlyUsd: z.number().min(0).max(10_000_000).default(0),
  /** Most one request may cost before it runs (its worst-case estimate), USD; 0 = no per-request cap. */
  maxRequestCostUsd: z.number().min(0).max(100).default(1),
  /** Site-wide emergency limit on AI spend per calendar month, USD; 0 = none. New requests stop when reached. */
  siteMonthlyCapUsd: z.number().min(0).max(10_000_000).default(0),
  /** Longest a code run may take, in seconds. Sets the most a run can cost, which each plan's margin counts. */
  codeRunSeconds: z.number().int().min(5).max(120).default(30),
  /** Site-wide code runs per calendar month (everyone together); 0 = no limit. */
  codeRunsSiteMonthly: z.number().int().min(0).max(100_000_000).default(4000),
  /** Code workspace time is started and counted in blocks of this many minutes. */
  workspaceBlockMinutes: z.number().int().min(5).max(40).default(10),
  /** Site-wide code workspace minutes per calendar month (everyone together); 0 = no limit. */
  workspaceSiteMonthlyMinutes: z.number().int().min(0).max(100_000_000).default(3000),
  /** Code workspace computers running at once, site-wide (Vercel Hobby allows 10 sandboxes at a time); 0 = no limit. */
  workspaceSiteConcurrent: z.number().int().min(0).max(10_000).default(6),
  /** Emergency stop: no new AI requests for anyone except administrators. */
  aiPaused: z.boolean().default(false),
  /** Cost switch: premium-tier models (the most expensive) refused for everyone except administrators. */
  premiumPaused: z.boolean().default(false),
  /** Days a paid plan keeps working after a renewal payment fails, while Stripe retries the card; 0 = none. */
  paymentGraceDays: z.number().int().min(0).max(30).default(3),
  /** Planning assumptions for the usage calculator (replaced by real averages once there's usage). */
  scenario: z
    .object({
      inputTokens: z.number().int().min(1).max(2_000_000).default(2000),
      outputTokens: z.number().int().min(1).max(200_000).default(800),
      /** Model calls per user message (agents, Council, retries and fallbacks add calls). */
      callsPerMessage: z.number().min(1).max(20).default(1.05),
      /** Share of input served from the prompt cache, in percent. */
      cachedInputPct: z.number().min(0).max(100).default(0),
    })
    .default({ inputTokens: 2000, outputTokens: 800, callsPerMessage: 1.05, cachedInputPct: 0 }),
  /**
   * Extra usage: a pack of units people on paid plans can buy to keep going after a limit. Off (0) until an
   * administrator sets both the units and the price, and payments are set up.
   */
  creditPackUnits: z.number().int().min(0).max(1_000_000).default(0),
  creditPackPriceUsd: z.number().min(0).max(1000).default(0),
  /** Usage units for a typical message by model tier (admins can still override single models); real messages are sized by what they cost. */
  tierUnits: z.object({ standard: z.number().min(0).max(1000), advanced: z.number().min(0).max(1000), premium: z.number().min(0).max(1000) }),
  /** Tier overrides by model id (which plans include a model). */
  modelTiers: z.record(z.string().min(1).max(120), z.enum(MODEL_TIERS)).default({}),
});
export type BillingSettings = z.infer<typeof billingSettingsSchema>;

/**
 * Defaults, from docs/PRICING.md: official API prices (2026-10-19), a
 * conservative request mix, 60% margin, 3.6% + $0.30 per charge, $0.50
 * hosting and $1 free-user subsidy per subscriber, 15% safety buffer.
 * Code runs and Code workspace minutes: each plan's monthly allowance at
 * its most expensive is set aside before the AI budget. Pro $20 → $3.59/month
 * AI budget; Max $100 → $24.07.
 */
export const DEFAULT_BILLING: BillingSettings = {
  plans: {
    free: {
      label: "Free",
      priceUsd: 0,
      annualDiscountPct: 0,
      windowUnits: 10,
      weeklyUnits: 30,
      topWeeklyUnits: 0,
      tiers: ["standard"],
      maxOutputTokens: 1200,
      historyChars: 12_000,
      webSearchesPerPeriod: 0,
      aiBudgetUsd: 0.1,
      premiumBudgetPct: 0,
      dailyMessages: 10,
      monthlyTokens: 400_000,
      dailyBudgetPct: 0,
      codeRunsPerPeriod: 20,
      workspaceMinutesPerPeriod: 20,
      codeProjects: 3,
    },
    pro: {
      label: "Pro",
      priceUsd: 20,
      annualDiscountPct: 10,
      windowUnits: 200,
      weeklyUnits: 1100,
      topWeeklyUnits: 0,
      tiers: ["standard", "advanced"],
      maxOutputTokens: 2400,
      historyChars: 24_000,
      webSearchesPerPeriod: 50,
      premiumBudgetPct: 60,
      dailyMessages: 0,
      monthlyTokens: 15_000_000,
      dailyBudgetPct: 34,
      codeRunsPerPeriod: 300,
      workspaceMinutesPerPeriod: 200,
      codeProjects: 25,
    },
    max: {
      label: "Max",
      priceUsd: 100,
      annualDiscountPct: 10,
      windowUnits: 2000,
      weeklyUnits: 10_000,
      topWeeklyUnits: 5000,
      tiers: ["standard", "advanced", "premium"],
      maxOutputTokens: 4800,
      historyChars: 80_000,
      webSearchesPerPeriod: 500,
      premiumBudgetPct: 85,
      dailyMessages: 0,
      monthlyTokens: 60_000_000,
      dailyBudgetPct: 34,
      codeRunsPerPeriod: 1500,
      workspaceMinutesPerPeriod: 1000,
      codeProjects: 100,
    },
  },
  targetMargin: 0.6,
  paymentFeePercent: 3.6,
  paymentFeeFixedUsd: 0.3,
  overheadPerSubscriberUsd: 0.5,
  freeSubsidyPerSubscriberUsd: 1,
  safetyBufferPct: 15,
  webSearchCostUsd: 0.01,
  taxIncludedPct: 0,
  refundRatePct: 2,
  fixedOverheadMonthlyUsd: 0,
  maxRequestCostUsd: 1,
  siteMonthlyCapUsd: 0,
  codeRunSeconds: 30,
  codeRunsSiteMonthly: 4000,
  workspaceBlockMinutes: 10,
  workspaceSiteMonthlyMinutes: 3000,
  workspaceSiteConcurrent: 6,
  aiPaused: false,
  premiumPaused: false,
  paymentGraceDays: 3,
  scenario: { inputTokens: 2000, outputTokens: 800, callsPerMessage: 1.05, cachedInputPct: 0 },
  tierUnits: { standard: 1, advanced: 20, premium: 40 },
  modelTiers: {},
  creditPackUnits: 0,
  creditPackPriceUsd: 0,
};

function mergeBilling(stored: unknown) {
  const s = (stored ?? {}) as Partial<BillingSettings> & { plans?: Partial<Record<PlanId, Partial<Plan>>> };
  return {
    ...DEFAULT_BILLING,
    ...s,
    tierUnits: { ...DEFAULT_BILLING.tierUnits, ...(s.tierUnits ?? {}) },
    scenario: { ...DEFAULT_BILLING.scenario, ...(s.scenario ?? {}) },
    modelTiers: { ...(s.modelTiers ?? {}) },
    plans: {
      free: { ...DEFAULT_BILLING.plans.free, ...(s.plans?.free ?? {}) },
      pro: { ...DEFAULT_BILLING.plans.pro, ...(s.plans?.pro ?? {}) },
      max: { ...DEFAULT_BILLING.plans.max, ...(s.plans?.max ?? {}) },
    },
  };
}

/** Stored admin changes merged over the defaults (invalid stored values fall back to defaults). */
export function resolveBilling(stored: unknown): BillingSettings {
  const parsed = billingSettingsSchema.safeParse(mergeBilling(stored));
  return parsed.success ? parsed.data : DEFAULT_BILLING;
}

/** Like resolveBilling, but reports what's invalid instead of falling back (for the admin editor). */
export function validateBilling(stored: unknown): { ok: true; billing: BillingSettings } | { ok: false; error: string } {
  const r = billingSettingsSchema.safeParse(mergeBilling(stored));
  if (!r.success) {
    const i = r.error.issues[0]!;
    return { ok: false, error: `Plans & pricing: ${i.path.join(".")} — ${i.message}` };
  }
  const b = r.data;
  if (!b.plans.free.tiers.includes("standard")) return { ok: false, error: "Plans & pricing: Free must include standard models." };
  for (const id of PLAN_IDS) {
    if (b.plans[id].weeklyUnits < b.plans[id].windowUnits) return { ok: false, error: `Plans & pricing: ${b.plans[id].label}'s weekly allowance must be at least its 5-hour allowance.` };
    if (b.plans[id].topWeeklyUnits > b.plans[id].weeklyUnits) return { ok: false, error: `Plans & pricing: ${b.plans[id].label}'s premium weekly limit can't be more than its weekly allowance.` };
  }
  if ((b.creditPackUnits > 0) !== (b.creditPackPriceUsd > 0)) return { ok: false, error: "Plans & pricing: set both the extra-usage pack's units and its price, or neither." };
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
  /** Business revenue per month, excluding taxes collected for authorities and expected refunds (annual plans spread over 12 months). */
  revenueUsd: number;
  /** Taxes included in the price that are passed on to authorities, per month. */
  taxUsd: number;
  /** Expected refunds and chargebacks, per month. */
  refundsUsd: number;
  /** Most the plan may cost per month (variable costs) and still keep the target contribution margin. */
  maxCostUsd: number;
  feesUsd: number;
  /** Attributable hosting and Free users' share, per subscriber per month. */
  overheadUsd: number;
  bufferUsd: number;
  /** What's left for AI usage per month. */
  aiBudgetUsd: number;
  /** Part of the AI budget that advanced and premium models may use. */
  premiumBudgetUsd: number;
  /** The plan's code runs at their most expensive (sandbox time), per month. */
  codeRunsUsd: number;
  /** The plan's code workspace minutes at their most expensive, per month. */
  workspaceUsd: number;
  /** Contribution if the whole AI budget and every code run are used: revenue − variable costs. */
  contributionUsd: number;
}

/**
 * The monthly AI budget that keeps the target contribution margin:
 *   revenue      = price ÷ (1 + tax included) × (1 − refunds)
 *   allowed cost = revenue × (1 − margin)
 *   AI budget    = (allowed cost − payment fees − hosting − Free users' share − code runs − workspace time) × (1 − safety buffer)
 * Fixed overhead is not a variable cost and is shown separately.
 */
export function planEconomics(billing: BillingSettings, id: PlanId, interval: BillingInterval = "month"): PlanEconomics {
  const plan = planOf(billing, id);
  const r = (n: number) => Math.round(n * 10_000) / 10_000;
  const codeRunsUsd = plan.codeRunsPerPeriod * maxCodeRunCostUsd(billing.codeRunSeconds);
  const workspaceUsd = plan.workspaceMinutesPerPeriod * workspaceMinuteCostUsd();
  if (plan.priceUsd === 0) {
    const ai = plan.aiBudgetUsd ?? 0;
    return { revenueUsd: 0, taxUsd: 0, refundsUsd: 0, maxCostUsd: 0, feesUsd: 0, overheadUsd: 0, bufferUsd: 0, aiBudgetUsd: ai, premiumBudgetUsd: r((ai * plan.premiumBudgetPct) / 100), codeRunsUsd: r(codeRunsUsd), workspaceUsd: r(workspaceUsd), contributionUsd: r(-ai - codeRunsUsd - workspaceUsd) };
  }
  const charge = chargeUsd(plan, interval);
  const perMonth = interval === "year" ? 1 / 12 : 1;
  const gross = charge * perMonth;
  const taxUsd = gross - gross / (1 + billing.taxIncludedPct / 100);
  const refundsUsd = (gross - taxUsd) * (billing.refundRatePct / 100);
  const revenueUsd = gross - taxUsd - refundsUsd;
  const maxCostUsd = revenueUsd * (1 - billing.targetMargin);
  // Stripe charges its fee on the full amount paid, tax included.
  const feesUsd = ((charge * billing.paymentFeePercent) / 100 + billing.paymentFeeFixedUsd) * perMonth;
  const overheadUsd = billing.overheadPerSubscriberUsd + billing.freeSubsidyPerSubscriberUsd;
  const beforeBuffer = Math.max(0, maxCostUsd - feesUsd - overheadUsd - codeRunsUsd - workspaceUsd);
  const bufferUsd = (beforeBuffer * billing.safetyBufferPct) / 100;
  const aiBudgetUsd = beforeBuffer - bufferUsd;
  return {
    revenueUsd: r(revenueUsd),
    taxUsd: r(taxUsd),
    refundsUsd: r(refundsUsd),
    maxCostUsd: r(maxCostUsd),
    feesUsd: r(feesUsd),
    overheadUsd: r(overheadUsd),
    bufferUsd: r(bufferUsd),
    aiBudgetUsd: r(aiBudgetUsd),
    premiumBudgetUsd: r((aiBudgetUsd * plan.premiumBudgetPct) / 100),
    codeRunsUsd: r(codeRunsUsd),
    workspaceUsd: r(workspaceUsd),
    contributionUsd: r(revenueUsd - feesUsd - overheadUsd - codeRunsUsd - workspaceUsd - aiBudgetUsd),
  };
}

/**
 * The monthly price needed for a given monthly AI budget at the target margin
 * (inverse of planEconomics). Pass the plan to set its code runs and workspace time aside too.
 */
export function priceForBudget(billing: BillingSettings, aiBudgetUsd: number, plan?: Pick<Plan, "codeRunsPerPeriod" | "workspaceMinutesPerPeriod">): number | null {
  // Inverse of planEconomics for a monthly plan: solve for the price P.
  const keep = (1 - billing.refundRatePct / 100) / (1 + billing.taxIncludedPct / 100);
  const denom = keep * (1 - billing.targetMargin) - billing.paymentFeePercent / 100;
  if (denom <= 0) return null;
  const beforeBuffer = aiBudgetUsd / (1 - billing.safetyBufferPct / 100);
  const codeUsd = (plan?.codeRunsPerPeriod ?? 0) * maxCodeRunCostUsd(billing.codeRunSeconds) + (plan?.workspaceMinutesPerPeriod ?? 0) * workspaceMinuteCostUsd();
  return Math.round(((beforeBuffer + billing.paymentFeeFixedUsd + billing.overheadPerSubscriberUsd + billing.freeSubsidyPerSubscriberUsd + codeUsd) / denom) * 100) / 100;
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

/** Most and least a single request is charged, as a multiple of a typical message's units. */
export const SIZE_MIN = 0.1;
export const SIZE_MAX = 20;

/**
 * Units for one model call, sized like Claude's limits: a typical message (the
 * planning scenario: about 1,500 words of context and a 600-word reply) costs
 * the model's base units; longer messages, files and conversations cost more,
 * short ones less, in proportion to what the call really costs. Clamped to
 * 0.1×–20× the base, rounded to 0.01. Models without a verified price keep the base.
 */
export function sizedUnits(
  model: Pick<ModelInfo, "inputPrice" | "outputPrice"> & Partial<Pick<ModelInfo, "cachedInputPrice" | "cacheWritePrice" | "cacheWritesUnreported" | "longContext">>,
  base: number,
  usage: { inputTokens: number | null; outputTokens: number | null; cachedInputTokens?: number | null; cacheWriteInputTokens?: number | null },
  scenario: Pick<BillingSettings["scenario"], "inputTokens" | "outputTokens"> = DEFAULT_BILLING.scenario,
): number {
  if (base <= 0) return 0;
  const price = (inTok: number, outTok: number, cached = 0, writes = 0) =>
    model.inputPrice === null || model.outputPrice === null
      ? null
      : ((inTok - cached - writes) * model.inputPrice + cached * (model.cachedInputPrice ?? model.inputPrice) + writes * (model.cacheWritePrice ?? model.inputPrice) + outTok * model.outputPrice) / 1_000_000;
  const typical = price(scenario.inputTokens, scenario.outputTokens);
  if (!typical || usage.inputTokens === null || usage.outputTokens === null) return base;
  const cached = Math.min(usage.inputTokens, Math.max(0, usage.cachedInputTokens ?? 0));
  const writes = model.cacheWritesUnreported ? 0 : Math.min(usage.inputTokens - cached, Math.max(0, usage.cacheWriteInputTokens ?? 0));
  const actual = price(usage.inputTokens, usage.outputTokens, cached, writes)!;
  const units = base * Math.min(SIZE_MAX, Math.max(SIZE_MIN, actual / typical));
  return Math.max(0.01, Math.round(units * 100) / 100);
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
  /** The separate weekly limit for premium models, when the plan has one. */
  top?: { used: number; limit: number; resetsAt: number | null } | null;
  /** Extra usage bought separately, and whether it's used automatically when a limit is reached. */
  credits?: { balance: number; auto: boolean } | null;
}

/** Start of the weekly period containing `now`: whole weeks after the account's anchor (when it was created). */
export function weekStart(anchor: number, now: number): number {
  return anchor + Math.floor(Math.max(0, now - anchor) / WEEK_MS) * WEEK_MS;
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
export function computeUsage(runs: UnitRun[], now: number, plan: Pick<Plan, "id" | "windowUnits" | "weeklyUnits">, anchor?: number): UsageState {
  const recent = runs.filter((r) => r.at > now - WEEK_MS && r.at <= now);
  let windowStart: number | null = null;
  for (const r of recent) {
    if (windowStart === null || r.at >= windowStart + WINDOW_MS) windowStart = r.at;
  }
  const active = windowStart !== null && now < windowStart + WINDOW_MS;
  const windowUsed = active ? recent.filter((r) => r.at >= windowStart!).reduce((s, r) => s + r.units, 0) : 0;
  // With the account's anchor, the week is fixed (as usage_compute_v2 counts it); without one, the last 7 days.
  const kStart = anchor !== undefined ? weekStart(anchor, now) : null;
  const inWeek = kStart === null ? recent : recent.filter((r) => r.at >= kStart);
  const weekUsed = inWeek.reduce((s, r) => s + r.units, 0);
  return {
    plan: plan.id,
    window: { used: windowUsed, limit: plan.windowUnits, resetsAt: active ? windowStart! + WINDOW_MS : null },
    week: { used: weekUsed, limit: plan.weeklyUnits, resetsAt: kStart !== null ? kStart + WEEK_MS : recent.length ? recent[0]!.at + WEEK_MS : null },
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
