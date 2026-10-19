import "server-only";
import { getProvider, withTimeout } from "../ai";
import { estimateCost, estimateTokens } from "../ai/cost";
import type { ChatMessage, GenerateResult, ModelWithStatus, Usage } from "../ai/types";
import type { AuthContext } from "../auth";
import { ApiError } from "../http";
import { recordRunLater } from "../usage";

/**
 * Provider fallbacks with a small per-provider circuit breaker. In-memory and
 * per server instance, like the rate limiter (see README "Known limitations").
 */
const FAILURE_WINDOW_MS = 60_000;
const OPEN_FOR_MS = 30_000;
const FAILURES_TO_OPEN = 3;
const breakers = new Map<string, { failures: number[]; openUntil: number }>();

export function circuitOpen(provider: string, now = Date.now()): boolean {
  return (breakers.get(provider)?.openUntil ?? 0) > now;
}

export function noteFailure(provider: string, now = Date.now()) {
  const b = breakers.get(provider) ?? { failures: [], openUntil: 0 };
  b.failures = [...b.failures.filter((t) => now - t < FAILURE_WINDOW_MS), now];
  if (b.failures.length >= FAILURES_TO_OPEN) b.openUntil = now + OPEN_FOR_MS;
  breakers.set(provider, b);
}

export function noteSuccess(provider: string) {
  breakers.delete(provider);
}

/** Errors worth trying another model for. Bad requests are not: they would fail everywhere. */
export function isRetryable(err: unknown): boolean {
  if (!(err instanceof ApiError)) return true;
  return ["rate_limited", "timeout", "upstream_error", "not_configured"].includes(err.code);
}

export interface Attempt {
  modelId: string;
  ok: boolean;
  error: string | null;
  latencyMs: number;
  skipped?: string;
}

export interface CallOutcome {
  model: ModelWithStatus;
  result: GenerateResult;
  usage: Usage;
  latencyMs: number;
  cost: number | null;
}

/** Call one model with timing, usage estimation and usage tracking. */
export async function callModel(
  auth: AuthContext,
  model: ModelWithStatus,
  messages: ChatMessage[],
  opts: { maxOutputTokens: number; temperature?: number; timeoutMs?: number; signal?: AbortSignal; purpose: string; category?: string | null; fallbackFrom?: string | null; prompt: string },
): Promise<CallOutcome> {
  const started = performance.now();
  try {
    const result = await getProvider(model.provider).generate({
      model,
      messages,
      maxOutputTokens: opts.maxOutputTokens,
      temperature: opts.temperature,
      signal: withTimeout(opts.timeoutMs ?? 45_000, opts.signal),
    });
    const latencyMs = Math.round(performance.now() - started);
    const usage =
      result.usage.inputTokens === null || result.usage.outputTokens === null
        ? { inputTokens: estimateTokens(messages), outputTokens: estimateTokens(result.text), estimated: true }
        : result.usage;
    noteSuccess(model.provider);
    recordRunLater(auth, { model, prompt: opts.prompt, response: result.text, latencyMs, usage, status: "success", purpose: opts.purpose, category: opts.category, servedModel: result.servedModel ?? null, fallbackFrom: opts.fallbackFrom ?? null });
    return { model, result, usage, latencyMs, cost: estimateCost(model, usage) };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - started);
    if (isRetryable(err)) noteFailure(model.provider);
    recordRunLater(auth, { model, prompt: opts.prompt, response: "", latencyMs, usage: { inputTokens: null, outputTokens: null, estimated: true }, status: "error", purpose: opts.purpose, category: opts.category, fallbackFrom: opts.fallbackFrom ?? null });
    throw err;
  }
}

/** Try each model in order until one succeeds. Every attempt is reported back to the caller. */
export async function generateWithFallback(
  auth: AuthContext,
  chain: ModelWithStatus[],
  messages: ChatMessage[],
  opts: Omit<Parameters<typeof callModel>[3], "fallbackFrom">,
): Promise<{ outcome: CallOutcome | null; attempts: Attempt[] }> {
  const attempts: Attempt[] = [];
  let previous: string | null = null;
  for (const model of chain) {
    if (circuitOpen(model.provider)) {
      attempts.push({ modelId: model.id, ok: false, error: null, latencyMs: 0, skipped: `${model.provider} circuit open after repeated failures` });
      continue;
    }
    try {
      const outcome = await callModel(auth, model, messages, { ...opts, fallbackFrom: previous });
      attempts.push({ modelId: model.id, ok: true, error: null, latencyMs: outcome.latencyMs });
      return { outcome, attempts };
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "The model call failed.";
      attempts.push({ modelId: model.id, ok: false, error: message, latencyMs: 0 });
      if (!isRetryable(err)) break;
      previous = model.id;
    }
  }
  return { outcome: null, attempts };
}
