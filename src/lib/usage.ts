import "server-only";
import { entitlementFor } from "./entitlements";
import type { AuthContext } from "./auth";
import { getAllModels, getModels } from "./ai";
import { getPlatformSettings } from "./ai/settings";
import { budgetPeriod, checkModelAccess, checkSiteCap, economyModel, estimateRequestUsd, fallbackPrices, nextRenewal } from "./budget";
import { estimateCost } from "./ai/cost";
import type { ModelInfo, Usage } from "./ai/types";
import { serverEnv } from "./env";
import { ApiError, clientIp } from "./http";
import { LARGE_MODEL_UNITS, PLANS, WEEK_MS, WINDOW_MS, modelUnits, planEconomics, unitsLeft, type BillingSettings, type PlanId, type UsageState } from "./plans";
import { limiter } from "./rate-limit";
import { reportError } from "./observability";

/**
 * Usage accounting. Policy (see docs/USAGE.md):
 * - Each model call costs usage units by the model that actually answered:
 *   1 for low-cost models, 15 for larger ones, or the admin's per-model setting.
 * - Before a request runs, its units are reserved atomically in the database
 *   (usage_reserve): a per-user lock means concurrent requests can't both slip
 *   under the limit, and a request id can only be reserved once, so duplicate
 *   submissions aren't charged twice.
 * - The charge is the recorded run (model_runs.units). Failed requests that
 *   produced no output are refunded (0 units); partial replies are charged.
 * - Who has which allowance is decided by entitlementFor() in entitlements.ts.
 */
export interface UsageTicket {
  requestId: string;
  /** Units reserved for this request (0 when no allowance applies). */
  units: number;
  entitlement: string | null;
  /** Worst-case cost held against the budget while the request runs (USD). */
  estCostUsd: number;
}

const tickets = new WeakMap<object, UsageTicket>();
const NO_LIMIT = 1_000_000_000;

/** The reservation made for this request, if any (used to link runs to their request). */
export function ticketFor(auth: AuthContext): UsageTicket | null {
  return tickets.get(auth) ?? null;
}

function unitsFor(models: ModelInfo[] | undefined, cost: number, overrides: Record<string, number>, tierUnits: BillingSettings["tierUnits"]): number {
  return models?.length ? models.reduce((s, m) => s + modelUnits(m, overrides[m.id], tierUnits), 0) : cost;
}

/** Who to suggest upgrading to when a limit is reached. */
function nextPlan(plan: PlanId): PlanId | null {
  return plan === "free" ? "pro" : plan === "pro" ? "max" : null;
}

/**
 * Enforce per-minute rate limits, then — for signed-in users — the plan's
 * model access, and reserve the request against both the 5-hour/weekly
 * allowance and the monthly AI budget in one atomic step (usage_reserve_v2),
 * using the request's estimated worst-case cost. Guests get a daily cap.
 * `cost` is the number of model calls; when `models` is given each call is
 * weighted by its model. `requestId` (from the browser) makes resubmissions
 * idempotent. `inputTokens` and `maxOutputTokens` refine the cost estimate.
 */
export async function enforceLimits(
  req: Request,
  auth: AuthContext,
  cost = 1,
  models?: ModelInfo[],
  opts: { requestId?: string | null; purpose?: string; inputTokens?: number; maxOutputTokens?: number } = {},
): Promise<UsageTicket> {
  const env = serverEnv();
  const who = auth.mode === "authenticated" ? `u:${auth.user.id}` : `ip:${clientIp(req)}`;
  const requestId = opts.requestId ?? crypto.randomUUID();

  const minute = limiter("minute", env.ratePerMinute, 60_000).check(who, cost);
  if (!minute.ok) {
    throw new ApiError("rate_limited", "Too many requests. Please wait a moment and try again.", {
      retryAfterSeconds: Math.ceil((minute.resetAt - Date.now()) / 1000),
    });
  }

  if (auth.mode !== "authenticated") {
    const day = limiter("day", env.dailyRequestLimit, 86_400_000).check(who, cost);
    if (!day.ok) throw new ApiError("quota_exceeded", `Daily guest limit of ${env.dailyRequestLimit} requests reached.`);
    return { requestId, units: 0, entitlement: null, estCostUsd: 0 };
  }

  const [entitlement, settings] = await Promise.all([entitlementFor(auth), getPlatformSettings()]);
  if (!entitlement) return { requestId, units: 0, entitlement: null, estCostUsd: 0 };
  const billing = entitlement.billing;
  const units = unitsFor(models, cost, settings.modelUnits, billing.tierUnits);
  const unlimited = entitlement.kind === "unlimited";
  const [available, all] = await Promise.all([getModels(settings), getAllModels(settings)]);

  // Plan access and the site-wide cap first, with a clear explanation.
  checkModelAccess(entitlement, models, available);
  if (!unlimited) await checkSiteCap(all);

  // Worst-case cost of this request, held against the budget while it runs.
  const economy = economyModel(entitlement, available);
  const priced = models?.length ? models : economy ? Array.from({ length: cost }, () => economy) : [];
  const estCostUsd = estimateRequestUsd(priced, opts.inputTokens ?? 3000, opts.maxOutputTokens ?? entitlement.limits.maxOutputTokens, all);
  const budgetUsd = unlimited ? null : planEconomics(billing, entitlement.plan, entitlement.interval).aiBudgetUsd;
  const period = budgetPeriod(entitlement);
  const fb = fallbackPrices(all);

  // Accounts without an allowance still reserve, with no limit, so duplicate submissions are refused for everyone.
  const { data, error } = await auth.supabase.rpc("usage_reserve_v2", {
    p_request_id: requestId,
    p_units: units,
    p_window_limit: unlimited ? NO_LIMIT : entitlement.limits.windowUnits,
    p_week_limit: unlimited ? NO_LIMIT : entitlement.limits.weeklyUnits,
    p_est_cost_usd: Math.round(estCostUsd * 1_000_000) / 1_000_000,
    p_budget_usd: budgetUsd,
    p_period_start: new Date(period.start).toISOString(),
    p_premium: !!models?.some((m) => m.id !== economy?.id),
    p_premium_share: billing.premiumBudgetShare,
    p_fallback_in: fb.input,
    p_fallback_out: fb.output,
    p_purpose: opts.purpose ?? null,
    p_model: models?.map((m) => m.id).join(",") ?? null,
    // Calls without a model list are short checks; don't hold their units for long.
    p_ttl_seconds: models?.length ? 180 : 45,
  });
  if (error) {
    // The allowance can't be checked (database unavailable): log it and let the request through rather than block everyone.
    reportError(error, { where: "usage_reserve_v2" });
    return { requestId, units: 0, entitlement: entitlement.label, estCostUsd: 0 };
  }
  const r = data as {
    ok: boolean;
    reason?: "duplicate" | "limit" | "budget";
    scope?: "window" | "week" | "exhausted" | "insufficient" | "economy";
    used?: number;
    limit?: number;
    resets_at?: string;
  };
  if (!r.ok && r.reason === "duplicate") {
    throw new ApiError("conflict", "This message was already sent. NOVA won't run or charge it twice.");
  }
  if (!r.ok) {
    if (unlimited) {
      reportError(new Error(`usage_reserve_v2 refused an unlimited account: ${r.reason}`), { where: "usage_reserve" });
      return { requestId, units: 0, entitlement: entitlement.label, estCostUsd: 0 };
    }
    const plan = entitlement.limits;
    const upgrade = nextPlan(entitlement.plan);
    const upgradeHint = upgrade ? ` ${billing.plans[upgrade].label} gives you more.` : "";
    if (r.reason === "budget") {
      const renews = nextRenewal(period.end);
      const details = { scope: "budget", budget: true, state: r.scope, resetsAt: new Date(period.end).toISOString(), plan: entitlement.plan, upgradeTo: upgrade, allowedModelId: economy?.id ?? null };
      if (r.scope === "exhausted") throw new ApiError("quota_exceeded", `You've used this month's AI budget on your ${plan.label} plan. It renews on ${renews}.${upgradeHint}`, details);
      if (r.scope === "economy") {
        throw new ApiError("quota_exceeded", `Most of this month's AI budget is used, so only the lowest-cost model${economy ? ` (${economy.displayName})` : ""} is available until ${renews}. Choose Auto to keep going.${upgradeHint}`, details);
      }
      throw new ApiError("quota_exceeded", `This request could cost more than what's left of this month's AI budget. Choose Auto (the lowest-cost model) or a shorter request.${upgradeHint}`, details);
    }
    const left = Math.max(0, Number(r.limit ?? 0) - Number(r.used ?? 0));
    const scope = r.scope === "week" ? "weekly" : "5-hour";
    const name = models?.length === 1 ? models[0]!.displayName : "This request";
    const message =
      left > 0 && units > left
        ? `${name} uses ${units} units per message, but only ${left} of your ${plan.label} plan's ${scope} allowance ${left === 1 ? "is" : "are"} left. Auto or a lighter model uses 1.${upgradeHint}`
        : `You've reached your ${plan.label} plan's ${scope} limit.${upgradeHint}`;
    throw new ApiError("quota_exceeded", message, {
      scope: r.scope,
      resetsAt: r.resets_at ? new Date(r.resets_at).toISOString() : null,
      plan: entitlement.plan,
      upgradeTo: upgrade,
      unitsNeeded: units,
      unitsLeft: left,
    });
  }
  const ticket = { requestId, units, entitlement: entitlement.label, estCostUsd };
  tickets.set(auth, ticket);
  return ticket;
}

/** Release this request's reservation without charging (the request failed before any model ran). */
export async function releaseUsage(auth: AuthContext): Promise<void> {
  const t = tickets.get(auth);
  if (!t || auth.mode !== "authenticated" || !t.units) return;
  const { error } = await auth.supabase.rpc("usage_finish", { p_request_id: t.requestId, p_state: "released" });
  if (error) reportError(error, { where: "usage_finish" });
}

/** The user's plan: Pro only while a subscription is active; everyone else is Free. */
export { userPlan } from "./entitlements";

/**
 * Current 5-hour window and weekly usage (charged runs plus requests in
 * flight). Null for guests, for accounts without an allowance (administrators)
 * and when it can't be read.
 */
export async function planUsage(auth: AuthContext): Promise<UsageState | null> {
  if (auth.mode !== "authenticated") return null;
  const entitlement = await entitlementFor(auth);
  if (!entitlement || entitlement.kind === "unlimited") return null;
  const { data, error } = await auth.supabase.rpc("usage_status");
  if (error) {
    reportError(error, { where: "usage_status" });
    return null;
  }
  const row = (Array.isArray(data) ? data[0] : data) as { window_used: number | string; window_start: string | null; week_used: number | string; week_oldest: string | null } | undefined;
  const plan = entitlement.limits;
  return {
    plan: plan.id,
    window: { used: Number(row?.window_used ?? 0), limit: plan.windowUnits, resetsAt: row?.window_start ? Date.parse(row.window_start) + WINDOW_MS : null },
    week: { used: Number(row?.week_used ?? 0), limit: plan.weeklyUnits, resetsAt: row?.week_oldest ? Date.parse(row.week_oldest) + WEEK_MS : null },
  };
}

/**
 * Whether Auto and agent defaults should keep to low-cost models: once 80% of
 * the allowance is used, or whenever fewer units are left than two messages to
 * a larger model need (always the case on Free), so one message can't use up
 * the whole allowance.
 */
export async function shouldSaveAllowance(auth: AuthContext): Promise<boolean> {
  const u = await planUsage(auth);
  if (!u) return false;
  return u.window.used >= u.window.limit * 0.8 || u.week.used >= u.week.limit * 0.8 || unitsLeft(u) < LARGE_MODEL_UNITS * 2;
}

export interface RunRecord {
  model: ModelInfo;
  prompt: string;
  response: string;
  latencyMs: number;
  usage: Usage;
  status: "success" | "error";
  conversationId?: string | null;
  /** Which feature made the call: chat, search, compare, trial, benchmark, claims, route… */
  purpose?: string;
  category?: string | null;
  servedModel?: string | null;
  /** Set when this call happened because an earlier model in a fallback chain failed. */
  fallbackFrom?: string | null;
  /** What the user selected (a model id, "auto" or "auto:<mode>"). */
  requestedModel?: string | null;
  /** Why this model was used, for diagnostics. */
  routingReason?: string | null;
  /** Server-side tools that ran for this call (e.g. time, web_search). */
  tools?: string[];
  /** A short error code or message for failed calls (no prompt content). */
  error?: string | null;
}

/**
 * Persist a model run and its charge, then settle the request's reservation.
 * Units come from the model that actually answered. A failed call that
 * produced no output is refunded (0 units). Failures to record are logged, never fatal.
 */
export async function recordRun(auth: AuthContext, run: RunRecord): Promise<void> {
  if (auth.mode !== "authenticated") return;
  const ticket = tickets.get(auth);
  const [entitlement, settings] = await Promise.all([entitlementFor(auth), getPlatformSettings()]);
  const refunded = run.status === "error" && !run.response;
  const units = refunded ? 0 : modelUnits(run.model, settings.modelUnits[run.model.id], entitlement?.billing.tierUnits);
  // Billable extras: each web search adds its cost to the run.
  const searches = run.tools?.filter((t) => t === "web_search").length ?? 0;
  const tokenCost = estimateCost(run.model, run.usage);
  const searchCost = searches * (entitlement?.billing.webSearchCostUsd ?? 0.01);
  const runCost = tokenCost === null ? null : tokenCost + searchCost;
  const { error } = await auth.supabase.from("model_runs").insert({
    user_id: auth.user.id,
    conversation_id: run.conversationId ?? null,
    model_id: run.model.id,
    prompt: run.prompt.slice(0, 4000),
    response: run.response.slice(0, 8000),
    latency_ms: Math.round(run.latencyMs),
    input_tokens: run.usage.inputTokens,
    output_tokens: run.usage.outputTokens,
    cached_input_tokens: run.usage.cachedInputTokens ?? null,
    estimated_cost: runCost,
    status: run.status,
    purpose: run.purpose ?? null,
    category: run.category ?? null,
    served_model: run.servedModel ?? null,
    fallback_from: run.fallbackFrom ?? null,
    request_id: ticket?.requestId ?? null,
    requested_model: run.requestedModel?.slice(0, 120) ?? null,
    routing_reason: run.routingReason?.slice(0, 500) ?? null,
    units,
    entitlement: entitlement?.label ?? null,
    error_code: run.error ? redactSecrets(run.error).slice(0, 300) : null,
    tools: run.tools?.length ? run.tools : null,
  });
  if (error) reportError(error, { where: "recordRun" });
  if (ticket?.units) {
    const fin = await auth.supabase.rpc("usage_finish", { p_request_id: ticket.requestId, p_state: "settled" });
    if (fin.error) reportError(fin.error, { where: "usage_finish" });
  }
}

/** Keep API keys and bearer tokens out of stored error text. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(sk|xai|gsk|hf|pk|rk)[-_][A-Za-z0-9_-]{10,}/g, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, "[redacted]");
}

export interface UsageSummary {
  runsToday: number;
  dailyLimit: number;
  estimatedCostToday: number | null;
  costIsPartial: boolean;
}

export async function usageSummary(auth: AuthContext): Promise<UsageSummary | null> {
  if (auth.mode !== "authenticated") return null;
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const { data, error } = await auth.supabase
    .from("model_runs")
    .select("estimated_cost")
    .gte("created_at", since.toISOString())
    .limit(5000);
  if (error || !data) return null;
  let total = 0;
  let unknown = 0;
  for (const r of data as { estimated_cost: number | string | null }[]) {
    if (r.estimated_cost === null) unknown++;
    else total += Number(r.estimated_cost);
  }
  return {
    runsToday: data.length,
    dailyLimit: serverEnv().dailyRequestLimit,
    estimatedCostToday: data.length === unknown ? null : total,
    costIsPartial: unknown > 0 && unknown < data.length,
  };
}

export interface PlanLimits {
  /** Longest reply per request, in tokens. */
  maxOutputTokens: number;
  /** Conversation history sent with each message, in characters. */
  historyChars: number;
  /** Model tiers the account may use (Auto and backups stay within them). */
  tiers: string[];
  /** Web searches left this budget period; null when unlimited. */
  webSearchesLeft: number | null;
}

/** The per-request limits of the caller's plan (guests get Free's). */
export async function planLimits(auth: AuthContext): Promise<PlanLimits> {
  const entitlement = await entitlementFor(auth);
  const plan = entitlement?.limits ?? PLANS.free;
  if (!entitlement || entitlement.kind === "unlimited" || auth.mode !== "authenticated") {
    return { maxOutputTokens: entitlement ? entitlement.billing.plans.max.maxOutputTokens : plan.maxOutputTokens, historyChars: entitlement ? entitlement.billing.plans.max.historyChars : plan.historyChars, tiers: entitlement ? ["standard", "advanced", "premium"] : plan.tiers, webSearchesLeft: entitlement ? null : 0 };
  }
  const { start } = budgetPeriod(entitlement);
  const { count } = await auth.supabase
    .from("model_runs")
    .select("id", { count: "exact", head: true })
    .gte("created_at", new Date(start).toISOString())
    .contains("tools", ["web_search"]);
  return { maxOutputTokens: plan.maxOutputTokens, historyChars: plan.historyChars, tiers: plan.tiers, webSearchesLeft: Math.max(0, plan.webSearchesPerPeriod - (count ?? 0)) };
}
