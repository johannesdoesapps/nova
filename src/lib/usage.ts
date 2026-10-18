import "server-only";
import type { AuthContext } from "./auth";
import { estimateCost } from "./ai/cost";
import type { ModelInfo, Usage } from "./ai/types";
import { serverEnv } from "./env";
import { ApiError, clientIp } from "./http";
import { limiter } from "./rate-limit";
import { reportError } from "./observability";

/**
 * Enforce per-minute rate limits and a daily request quota before any paid
 * call. `cost` lets expensive operations (e.g. a 3-model battle) count as more.
 */
export async function enforceLimits(req: Request, auth: AuthContext, cost = 1): Promise<void> {
  const env = serverEnv();
  const who = auth.mode === "authenticated" ? `u:${auth.user.id}` : `ip:${clientIp(req)}`;

  const minute = limiter("minute", env.ratePerMinute, 60_000).check(who, cost);
  if (!minute.ok) {
    throw new ApiError("rate_limited", "Too many requests. Please wait a moment and try again.", {
      retryAfterSeconds: Math.ceil((minute.resetAt - Date.now()) / 1000),
    });
  }

  if (auth.mode === "authenticated") {
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    const { count, error } = await auth.supabase
      .from("model_runs")
      .select("id", { count: "exact", head: true })
      .gte("created_at", since.toISOString());
    if (!error && (count ?? 0) + cost > env.dailyRequestLimit) {
      throw new ApiError("quota_exceeded", `Daily limit of ${env.dailyRequestLimit} model runs reached. It resets at 00:00 UTC.`);
    }
  } else {
    const day = limiter("day", env.dailyRequestLimit, 86_400_000).check(who, cost);
    if (!day.ok) throw new ApiError("quota_exceeded", `Daily guest limit of ${env.dailyRequestLimit} requests reached.`);
  }
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
