import type { ChatMessage, ModelInfo, Usage } from "./types";

/** Rough heuristic: ~4 characters per token for English text. Labelled as an estimate in the UI. */
export function estimateTokens(input: string | ChatMessage[]): number {
  const text = typeof input === "string" ? input : input.map((m) => m.content).join("\n");
  return Math.ceil(text.length / 4);
}

/**
 * Estimated cost in USD. Returns null when the model has no verified price,
 * so the UI shows "n/a" instead of inventing a number.
 */
export function estimateCost(
  model: Pick<ModelInfo, "inputPrice" | "outputPrice">,
  usage: Pick<Usage, "inputTokens" | "outputTokens">,
): number | null {
  if (model.inputPrice === null || model.outputPrice === null) return null;
  if (usage.inputTokens === null || usage.outputTokens === null) return null;
  const cost = (usage.inputTokens * model.inputPrice + usage.outputTokens * model.outputPrice) / 1_000_000;
  return Math.round(cost * 1e8) / 1e8;
}
