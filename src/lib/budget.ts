import "server-only";
import { cheapestModel } from "./ai/router";
import type { ModelInfo, ModelWithStatus } from "./ai/types";
import type { AuthContext } from "./auth";
import type { Entitlement } from "./entitlements";
import { serverEnv } from "./env";
import { ApiError } from "./http";
import { reportError } from "./observability";
import { modelTier, planEconomics, planForTier, type BillingSettings, type ModelTier } from "./plans";
import { serviceSupabase } from "./supabase/admin";

/**
 * Money rules for AI requests, on the server:
 * - Model access by plan: standard models on every plan, advanced from Pro,
 *   premium on Max (configurable). A model outside the plan is refused with
 *   the plan that includes it and the models the user can use instead.
 * - A monthly AI budget per account that keeps the target margin (see
 *   planEconomics in plans.ts). The check itself runs atomically in
 *   usage_reserve_v2, with this request's estimated cost and requests in
 *   flight: below the premium share any allowed model, then only the
 *   lowest-cost model, and nothing once the budget is used. It resets with the
 *   billing period (calendar month on Free).
 * - Optionally a site-wide monthly cap (NOVA_MONTHLY_AI_BUDGET_USD).
 * Administrators have no budget.
 */

const DAY = 86_400_000;

export function budgetLimitUsd(entitlement: Entitlement | null): number | null {
  if (!entitlement || entitlement.kind === "unlimited") return null;
  return planEconomics(entitlement.billing, entitlement.plan, entitlement.interval).aiBudgetUsd;
}

/** The current budget period: the paid billing period, else the calendar month (UTC). */
export function budgetPeriod(entitlement: Pick<Entitlement, "plan" | "periodStart" | "interval"> | null, now = Date.now()): { start: number; end: number } {
  if (entitlement && entitlement.plan !== "free" && entitlement.periodStart && entitlement.periodStart <= now) {
    // Budgets are monthly, also on annual plans: step through the paid period in months, on the original billing day.
    const anchor = entitlement.periodStart;
    let k = 0;
    while (addMonths(anchor, k + 1) <= now) k++;
    return { start: addMonths(anchor, k), end: addMonths(anchor, k + 1) };
  }
  const d = new Date(now);
  return { start: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), end: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) };
}

/** `n` months after `t`, on the same day of the month (or the month's last day, like Stripe). */
function addMonths(t: number, n: number): number {
  const d = new Date(t);
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d.getUTCDate(), lastDay), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
}

/** Most expensive verified prices (per 1M tokens): used for runs and models without a verified price. */
export function fallbackPrices(models: ModelInfo[]): { input: number; output: number } {
  const priced = models.filter((m) => m.inputPrice !== null && m.outputPrice !== null);
  return { input: Math.max(0, ...priced.map((m) => m.inputPrice!)), output: Math.max(0, ...priced.map((m) => m.outputPrice!)) };
}

/** Worst-case cost of one request before sending it: its input plus the longest reply the plan allows. */
export function estimateRequestUsd(models: ModelInfo[], inputTokens: number, maxOutputTokens: number, all: ModelInfo[]): number {
  const fb = fallbackPrices(all);
  return models.reduce((sum, m) => sum + (inputTokens * (m.inputPrice ?? fb.input) + maxOutputTokens * (m.outputPrice ?? fb.output)) / 1_000_000, 0);
}

export function budgetState(spentUsd: number, limitUsd: number | null, premiumShare = 0.8): "ok" | "economy" | "exhausted" {
  if (limitUsd === null) return "ok";
  if (spentUsd >= limitUsd) return "exhausted";
  if (spentUsd >= limitUsd * premiumShare) return "economy";
  return "ok";
}

type RunCost = { estimated_cost: number | string | null; input_tokens: number | null; output_tokens: number | null };

/** Cost of runs, counting unpriced runs at the most expensive verified price. */
export function costOfRuns(rows: RunCost[], models: ModelInfo[]): number {
  const fb = fallbackPrices(models);
  let total = 0;
  for (const r of rows) {
    if (r.estimated_cost !== null && r.estimated_cost !== undefined) total += Number(r.estimated_cost);
    else total += ((r.input_tokens ?? 2000) * fb.input + (r.output_tokens ?? 1000) * fb.output) / 1_000_000;
  }
  return total;
}

export interface BudgetStatus {
  limitUsd: number | null;
  spentUsd: number;
  periodStart: number;
  resetsAt: number;
  state: "ok" | "economy" | "exhausted";
}

/** The account's budget this period, for display (enforcement is atomic in the database). */
export async function budgetStatus(auth: AuthContext, entitlement: Entitlement | null, models: ModelInfo[], now = Date.now()): Promise<BudgetStatus | null> {
  if (auth.mode !== "authenticated") return null;
  const limitUsd = budgetLimitUsd(entitlement);
  const { start, end } = budgetPeriod(entitlement, now);
  if (limitUsd === null) return { limitUsd, spentUsd: 0, periodStart: start, resetsAt: end, state: "ok" };
  const { data, error } = await auth.supabase
    .from("model_runs")
    .select("estimated_cost, input_tokens, output_tokens")
    .gte("created_at", new Date(start).toISOString())
    .gt("units", 0)
    .limit(20_000);
  if (error) {
    reportError(error, { where: "budgetStatus" });
    return null;
  }
  const spentUsd = costOfRuns((data ?? []) as RunCost[], models);
  return { limitUsd, spentUsd, periodStart: start, resetsAt: end, state: budgetState(spentUsd, limitUsd, entitlement?.billing.premiumBudgetShare) };
}

/**
 * Refuse models the plan doesn't include, naming the plan that does and the
 * models this plan can use instead. Never switches the model silently.
 */
export function checkModelAccess(entitlement: Entitlement | null, requested: ModelInfo[] | undefined, available: ModelWithStatus[]): void {
  if (!entitlement || entitlement.kind === "unlimited" || !requested?.length) return;
  const allowed = new Set<ModelTier>(entitlement.limits.tiers);
  const blocked = requested.filter((m) => !allowed.has(modelTier(m)));
  if (!blocked.length) return;
  const m = blocked[0]!;
  const tier = modelTier(m);
  const needed = planForTier(entitlement.billing, tier);
  const alternatives = available.filter((x) => x.available && x.provider !== "demo" && allowed.has(modelTier(x)));
  const sameProvider = alternatives.filter((x) => x.provider === m.provider).map((x) => x.displayName);
  const label = entitlement.billing.plans[needed].label;
  throw new ApiError(
    "plan_required",
    `${m.displayName} is included in the ${label} plan. Your ${entitlement.limits.label} plan includes ${(sameProvider.length ? sameProvider : alternatives.map((x) => x.displayName)).slice(0, 3).join(", ") || "Auto"} — choose one of those or Auto, or upgrade to ${label}.`,
    { requiredPlan: needed, modelId: m.id, alternatives: alternatives.map((x) => x.id) },
  );
}

let siteSpendCache: { at: number; month: number; usd: number } | null = null;

/** Refuse new AI requests once the whole site's monthly spend reaches NOVA_MONTHLY_AI_BUDGET_USD (service role; cached a minute). */
export async function checkSiteCap(all: ModelInfo[], now = Date.now()): Promise<void> {
  const cap = serverEnv().monthlyAiBudgetUsd;
  if (cap === null) return;
  const d = new Date(now);
  const month = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  let usd = siteSpendCache && siteSpendCache.month === month && now - siteSpendCache.at < 60_000 ? siteSpendCache.usd : null;
  if (usd === null) {
    const admin = serviceSupabase();
    if (!admin) return;
    const { data, error } = await admin.from("model_runs").select("estimated_cost, input_tokens, output_tokens").gte("created_at", new Date(month).toISOString()).gt("units", 0).limit(500_000);
    if (error) {
      reportError(error, { where: "checkSiteCap" });
      return;
    }
    usd = costOfRuns((data ?? []) as RunCost[], all);
    siteSpendCache = { at: now, month, usd };
  }
  if (usd >= cap) throw new ApiError("quota_exceeded", "NOVA has reached its AI usage limit for this month. Please try again next month.", { scope: "site", budget: true });
}

/** The lowest-cost model the plan may use (what economy mode allows). */
export function economyModel(entitlement: Entitlement | null, available: ModelWithStatus[]): ModelWithStatus | null {
  if (!entitlement || entitlement.kind === "unlimited") return cheapestModel(available);
  const allowed = new Set<ModelTier>(entitlement.limits.tiers);
  return cheapestModel(available.filter((m) => allowed.has(modelTier(m))));
}

export const nextRenewal = (t: number) => new Date(t).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });

export type { BillingSettings };
export { DAY };
