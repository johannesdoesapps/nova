import "server-only";
import { ApiError } from "../http";
import { getProvider } from "./index";
import type { GenerateParams, ModelWithStatus, StreamEvent } from "./types";

export type FallbackStreamEvent = StreamEvent | { type: "fallback"; from: ModelWithStatus; to: ModelWithStatus; reason: string };

/** Errors worth trying another model for. Bad requests and missing keys are not. */
function retryable(err: unknown): err is ApiError {
  return err instanceof ApiError && (err.code === "upstream_error" || err.code === "timeout" || err.code === "rate_limited" || err.code === "provider_unavailable");
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
      if (sentText || !next || !retryable(err)) throw err;
      yield { type: "fallback", from: model, to: next, reason: err.message };
    }
  }
}
