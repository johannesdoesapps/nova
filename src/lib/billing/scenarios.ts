import { estimateCost } from "../ai/cost";
import type { ModelInfo } from "../ai/types";
import { modelTier, planEconomics, planOf, type BillingInterval, type BillingSettings, type PlanId } from "../plans";

/**
 * Usage scenarios: what a user message costs on each model and what a plan's
 * budget buys, from the configured planning assumptions (billing.scenario)
 * and verified per-token prices. A user message can trigger several model
 * calls (agents, Council, retries), so costs are per message × calls per
 * message. Months are 30 days. These are estimates for planning; recorded
 * usage replaces them after launch (Admin → Finance shows real averages).
 */

export type Scenario = BillingSettings["scenario"];
export const MESSAGES_PER_DAY = [10, 50, 100, 300] as const;
export const DAYS_PER_MONTH = 30;

type Priced = Pick<ModelInfo, "id" | "displayName" | "provider" | "capabilities" | "inputPrice" | "outputPrice" | "cachedInputPrice" | "cacheWritePrice" | "cacheWritesUnreported" | "longContext" | "tier">;

/** Cost of one user message on a model (null without a verified price). */
export function messageCostUsd(model: Priced, s: Scenario): number | null {
  const cached = Math.round((s.inputTokens * s.cachedInputPct) / 100);
  const call = estimateCost(model, { inputTokens: s.inputTokens, outputTokens: s.outputTokens, cachedInputTokens: cached });
  return call === null ? null : call * s.callsPerMessage;
}

export interface ModelCostRow {
  id: string;
  name: string;
  provider: string;
  tier: string;
  perMessageUsd: number;
  per100Usd: number;
  per1000Usd: number;
  per3000Usd: number;
  /** By messages per day: daily and monthly (30-day) cost. */
  byVolume: { perDay: number; dailyUsd: number; monthlyUsd: number }[];
}

export function modelCostTable(models: Priced[], s: Scenario, volumes: readonly number[] = MESSAGES_PER_DAY): ModelCostRow[] {
  return models
    .map((m) => ({ m, c: messageCostUsd(m, s) }))
    .filter((x): x is { m: Priced; c: number } => x.c !== null)
    .sort((a, b) => a.c - b.c)
    .map(({ m, c }) => ({
      id: m.id,
      name: m.displayName,
      provider: m.provider,
      tier: modelTier(m),
      perMessageUsd: c,
      per100Usd: c * 100,
      per1000Usd: c * 1000,
      per3000Usd: c * 3000,
      byVolume: volumes.map((perDay) => ({ perDay, dailyUsd: c * perDay, monthlyUsd: c * perDay * DAYS_PER_MONTH })),
    }));
}

export interface PlanCapacity {
  plan: PlanId;
  interval: BillingInterval;
  aiBudgetUsd: number;
  premiumBudgetUsd: number;
  /** Messages a month the budget buys on each model the plan includes, and per day. */
  models: { id: string; name: string; tier: string; perMonth: number; perDay: number }[];
  /** A mix: `premiumShare` of messages on the plan's most expensive model, the rest on its cheapest. */
  mixed: { premiumShare: number; perMonth: number; perDay: number } | null;
}

/** What a plan's monthly allowance buys: the AI budget (advanced/premium models also by their part of it), daily, token and unit caps. */
export function planCapacity(billing: BillingSettings, plan: PlanId, models: Priced[], interval: BillingInterval = "month", premiumShare = 0.2): PlanCapacity {
  const p = planOf(billing, plan);
  const e = planEconomics(billing, plan, interval);
  const rows = models
    .filter((m) => p.tiers.includes(modelTier(m)))
    .map((m) => ({ m, c: messageCostUsd(m, billing.scenario) }))
    .filter((x): x is { m: Priced; c: number } => x.c !== null && x.c > 0)
    .sort((a, b) => a.c - b.c);
  const cap = (m: Priced) => (modelTier(m) === "standard" ? e.aiBudgetUsd : Math.min(e.aiBudgetUsd, e.premiumBudgetUsd));
  const caps = messageCaps(billing, plan);
  const out = rows.map(({ m, c }) => {
    const perMonth = Math.floor(Math.min(cap(m) / c, caps.daily, caps.tokens, caps.units / Math.max(billing.tierUnits[modelTier(m)], 1e-9)));
    return { id: m.id, name: m.displayName, tier: modelTier(m), perMonth, perDay: Math.floor(perMonth / DAYS_PER_MONTH) };
  });
  let mixed: PlanCapacity["mixed"] = null;
  const lo = rows[0];
  const hi = rows.at(-1);
  if (lo && hi && hi !== lo && modelTier(hi.m) !== "standard") {
    // Messages until either the whole budget or the premium budget runs out.
    const perMsg = (1 - premiumShare) * lo.c + premiumShare * hi.c;
    const byTotal = e.aiBudgetUsd / perMsg;
    const byPremium = premiumShare > 0 ? e.premiumBudgetUsd / (premiumShare * hi.c) : Infinity;
    const unitsPerMsg = (1 - premiumShare) * billing.tierUnits[modelTier(lo.m)] + premiumShare * billing.tierUnits[modelTier(hi.m)];
    const perMonth = Math.floor(Math.min(byTotal, byPremium, caps.daily, caps.tokens, caps.units / Math.max(unitsPerMsg, 1e-9)));
    mixed = { premiumShare, perMonth, perDay: Math.floor(perMonth / DAYS_PER_MONTH) };
  }
  return { plan, interval, aiBudgetUsd: e.aiBudgetUsd, premiumBudgetUsd: e.premiumBudgetUsd, models: out, mixed };
}

/** Messages a month the plan's non-money caps allow: daily messages, tokens, and weekly units (spread over 30 days). */
export function messageCaps(billing: BillingSettings, plan: PlanId): { daily: number; tokens: number; units: number } {
  const p = planOf(billing, plan);
  const s = billing.scenario;
  return {
    daily: p.dailyMessages > 0 ? p.dailyMessages * DAYS_PER_MONTH : Infinity,
    tokens: p.monthlyTokens > 0 ? p.monthlyTokens / ((s.inputTokens + s.outputTokens) * s.callsPerMessage) : Infinity,
    units: (p.weeklyUnits * DAYS_PER_MONTH) / 7,
  };
}

export interface PlanScenario {
  plan: PlanId;
  perDay: number;
  model: string;
  tier: string;
  revenueUsd: number;
  /** AI cost if the user's usage weren't capped. */
  uncappedAiUsd: number;
  /** AI cost after the plan's budget stops usage. */
  aiCostUsd: number;
  feesUsd: number;
  otherVariableUsd: number;
  requiredProfitUsd: number;
  contributionUsd: number;
  /** Contribution margin in percent (null on Free). */
  marginPct: number | null;
  /** Whether the budget guard has to stop this user before the month ends. */
  capped: boolean;
  /** Messages the user gets before the guard stops them. */
  messagesAllowed: number;
}

/** A plan at a usage level on one model: revenue, costs and margin, with the budget guard applied. */
export function planScenario(billing: BillingSettings, plan: PlanId, model: Priced, perDay: number, interval: BillingInterval = "month"): PlanScenario | null {
  const c = messageCostUsd(model, billing.scenario);
  if (c === null) return null;
  const p = planOf(billing, plan);
  const e = planEconomics(billing, plan, interval);
  const tier = modelTier(model);
  const wanted = perDay * DAYS_PER_MONTH;
  const caps = messageCaps(billing, plan);
  const moneyCap = (tier === "standard" ? e.aiBudgetUsd : Math.min(e.aiBudgetUsd, e.premiumBudgetUsd)) / c;
  const allowed = Math.floor(Math.min(wanted, caps.daily, caps.tokens, caps.units / Math.max(billing.tierUnits[tier], 1e-9), moneyCap));
  const ai = allowed * c;
  const contribution = e.revenueUsd - e.feesUsd - (plan === "free" ? 0 : e.overheadUsd) - ai;
  return {
    plan,
    perDay,
    model: model.displayName,
    tier,
    revenueUsd: e.revenueUsd,
    uncappedAiUsd: wanted * c,
    aiCostUsd: ai,
    feesUsd: e.feesUsd,
    otherVariableUsd: plan === "free" ? 0 : e.overheadUsd,
    requiredProfitUsd: e.revenueUsd * billing.targetMargin,
    contributionUsd: contribution,
    marginPct: e.revenueUsd > 0 ? (contribution / e.revenueUsd) * 100 : null,
    capped: allowed < wanted,
    messagesAllowed: allowed,
  };
}
