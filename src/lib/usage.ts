import "server-only";
import { isAdmin } from "./admin";
import type { AuthContext } from "./auth";
import { getAllModels } from "./ai";
import { getPlatformSettings } from "./ai/settings";
import { estimateCost } from "./ai/cost";
import type { ModelInfo, Usage } from "./ai/types";
import { serverEnv } from "./env";
import { ApiError, clientIp } from "./http";
import { LARGE_MODEL_UNITS, PLANS, WEEK_MS, checkUsage, computeUsage, modelUnits, unitsLeft, type PlanId, type UsageState } from "./plans";
import { limiter } from "./rate-limit";
import { reportError } from "./observability";

/**
 * Enforce per-minute rate limits, then the plan's 5-hour and weekly
 * allowance (signed-in users) or a daily cap (guests). `cost` is the number of
 * model calls; when `models` is given each call is weighted by its model.
 */
export async function enforceLimits(req: Request, auth: AuthContext, cost = 1, models?: ModelInfo[]): Promise<void> {
  const env = serverEnv();
  const who = auth.mode === "authenticated" ? `u:${auth.user.id}` : `ip:${clientIp(req)}`;

  const minute = limiter("minute", env.ratePerMinute, 60_000).check(who, cost);
  if (!minute.ok) {
    throw new ApiError("rate_limited", "Too many requests. Please wait a moment and try again.", {
      retryAfterSeconds: Math.ceil((minute.resetAt - Date.now()) / 1000),
    });
  }

  if (auth.mode === "authenticated") {
    const [state, settings] = await Promise.all([planUsage(auth), getPlatformSettings()]);
    if (!state) return;
    const units = models?.length ? models.reduce((s, m) => s + modelUnits(m.capabilities, settings.modelUnits[m.id]), 0) : cost;
    const check = checkUsage(state, units, Date.now());
    if (!check.ok) {
      const plan = PLANS[state.plan];
      throw new ApiError(
        "quota_exceeded",
        check.scope === "window"
          ? `You've reached your ${plan.label} plan's 5-hour limit.`
          : `You've reached your ${plan.label} plan's weekly limit.`,
        { scope: check.scope, resetsAt: new Date(check.resetsAt).toISOString(), plan: state.plan },
      );
    }
  } else {
    const day = limiter("day", env.dailyRequestLimit, 86_400_000).check(who, cost);
    if (!day.ok) throw new ApiError("quota_exceeded", `Daily guest limit of ${env.dailyRequestLimit} requests reached.`);
  }
}

/** The user's plan: Pro only while a subscription is active; everyone else is Free. */
export async function userPlan(auth: AuthContext & { mode: "authenticated" }): Promise<PlanId> {
  const { data } = await auth.supabase.from("subscriptions").select("plan, status").eq("user_id", auth.user.id).maybeSingle();
  const row = data as { plan: PlanId; status: string } | null;
  return row && row.plan === "pro" && ["active", "trialing"].includes(row.status) ? "pro" : "free";
}

/**
 * Current 5-hour window and weekly usage, from the user's successful model runs.
 * Null if it can't be read, and for administrators, who run the site and have no allowance.
 */
export async function planUsage(auth: AuthContext): Promise<UsageState | null> {
  if (auth.mode !== "authenticated" || (await isAdmin(auth))) return null;
  const now = Date.now();
  const settings = await getPlatformSettings();
  const [plan, runs, models] = await Promise.all([
    userPlan(auth),
    auth.supabase
      .from("model_runs")
      .select("model_id, created_at")
      .eq("status", "success")
      .gte("created_at", new Date(now - WEEK_MS).toISOString())
      .order("created_at", { ascending: true })
      .limit(5000),
    getAllModels(settings),
  ]);
  if (runs.error || !runs.data) return null;
  const caps = new Map(models.map((m) => [m.id, m.capabilities]));
  const unitRuns = (runs.data as { model_id: string; created_at: string }[]).map((r) => ({
    at: Date.parse(r.created_at),
    units: caps.has(r.model_id) ? modelUnits(caps.get(r.model_id), settings.modelUnits[r.model_id]) : 1,
  }));
  return computeUsage(unitRuns, now, PLANS[plan]);
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
}

/** Persist a model run for usage tracking. Failures are logged, never fatal. */
export async function recordRun(auth: AuthContext, run: RunRecord): Promise<void> {
  if (auth.mode !== "authenticated") return;
  const { error } = await auth.supabase.from("model_runs").insert({
    user_id: auth.user.id,
    conversation_id: run.conversationId ?? null,
    model_id: run.model.id,
    prompt: run.prompt.slice(0, 4000),
    response: run.response.slice(0, 8000),
    latency_ms: Math.round(run.latencyMs),
    input_tokens: run.usage.inputTokens,
    output_tokens: run.usage.outputTokens,
    estimated_cost: estimateCost(run.model, run.usage),
    status: run.status,
    purpose: run.purpose ?? null,
    category: run.category ?? null,
    served_model: run.servedModel ?? null,
    fallback_from: run.fallbackFrom ?? null,
  });
  if (error) reportError(error, { where: "recordRun" });
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
