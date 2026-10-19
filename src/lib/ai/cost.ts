import type { ChatMessage, ModelInfo, Usage } from "./types";

/** Rough heuristic: ~4 characters per token for English text. Labelled as an estimate in the UI. */
export function estimateTokens(input: string | ChatMessage[]): number {
  const text = typeof input === "string" ? input : input.map((m) => m.content).join("\n");
  return Math.ceil(text.length / 4);
}

/**
 * Cost of a model call in USD, from the provider-reported token counts:
 * uncached input at the input price (or the cache-write price for tokens
 * written to the prompt cache), cached input at the cached price, output at
 * the output price, all at the long-context rates when the prompt is above
 * the provider's threshold. Returns null when the model has no verified price,
 * so the UI shows "n/a" instead of inventing a number.
 *
 *   cost = (uncached × input + writes × cacheWrite + cached × cachedInput + output × outputPrice) / 1,000,000
 */
export function estimateCost(
  model: Pick<ModelInfo, "inputPrice" | "outputPrice"> & Partial<Pick<ModelInfo, "cachedInputPrice" | "cacheWritePrice" | "cacheWritesUnreported" | "longContext">>,
  usage: Pick<Usage, "inputTokens" | "outputTokens"> & Partial<Pick<Usage, "cachedInputTokens" | "cacheWriteInputTokens">>,
): number | null {
  if (model.inputPrice === null || model.outputPrice === null) return null;
  if (usage.inputTokens === null || usage.outputTokens === null) return null;
  const long = model.longContext && usage.inputTokens > model.longContext.aboveInputTokens ? model.longContext : null;
  const input = long ? long.inputPrice : model.inputPrice;
  const output = long ? long.outputPrice : model.outputPrice;
  const cachedPrice = (long ? long.cachedInputPrice : model.cachedInputPrice) ?? input;
  const writePrice = (long ? long.cacheWritePrice : model.cacheWritePrice) ?? input;
  const cached = Math.min(usage.inputTokens, Math.max(0, usage.cachedInputTokens ?? 0));
  const rest = usage.inputTokens - cached;
  // Reported cache writes are priced as such; when the provider doesn't report them, all uncached input may be a write.
  const writes = model.cacheWritesUnreported ? rest : Math.min(rest, Math.max(0, usage.cacheWriteInputTokens ?? 0));
  const cost = ((rest - writes) * input + writes * writePrice + cached * cachedPrice + usage.outputTokens * output) / 1_000_000;
  return Math.round(cost * 1e8) / 1e8;
}
