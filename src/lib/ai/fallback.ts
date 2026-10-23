import "server-only";
import { ApiError } from "../http";
import { getProvider } from "./index";
import type { GenerateParams, ModelWithStatus, StreamEvent } from "./types";

export type FallbackStreamEvent = StreamEvent | { type: "fallback"; from: ModelWithStatus; to: ModelWithStatus; reason: string };

/** Errors worth trying another model for. Bad requests and missing keys are not. */
function retryable(err: unknown): err is ApiError {
  return err instanceof ApiError && (err.code === "upstream_error" || err.code === "timeout" || err.code === "rate_limited" || err.code === "provider_unavailable");
}

/** A fallback model is only tried with at least this long left; otherwise the first model's error is shown. */
export const MIN_FALLBACK_MS = 10_000;

/** Time a model call may take now: at most 50 s, and never past the request's deadline. */
export function modelBudget(deadline: number, now = Date.now()): number {
  return Math.max(1_000, Math.min(50_000, deadline - now));
}

/**
 * Stream from the chosen model, moving to the next model in `fallbacks` only
 * if it fails before sending any text. Callers build `fallbacks` with
 * fallbackChain(), so it is empty unless both the admin and the user allow it.
 */
export async function* streamWithFallback(
  primary: ModelWithStatus,
  fallbacks: ModelWithStatus[],
  params: Omit<GenerateParams, "model" | "signal">,
  signal: () => AbortSignal,
  opts: { canFallBack?: () => boolean } = {},
  lookup: typeof getProvider = getProvider,
): AsyncGenerator<FallbackStreamEvent> {
  const chain = [primary, ...fallbacks];
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i]!;
    let sentText = false;
    try {
      for await (const ev of lookup(model.provider).stream({ ...params, model, signal: signal() })) {
        if (ev.type === "delta") sentText = true;
        yield ev;
      }
      return;
    } catch (err) {
      const next = chain[i + 1];
      // Never after text was sent (that would duplicate the reply), never for errors another model won't fix,
      // and only when there's time left for another model to answer.
      if (sentText || !next || !retryable(err) || (opts.canFallBack && !opts.canFallBack())) throw err;
      yield { type: "fallback", from: model, to: next, reason: err.message };
    }
  }
}
