import { isAutoId } from "./platform";
import type { ModelWithStatus } from "./types";

export const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI (GPT)",
  google: "Google (Gemini)",
  xai: "xAI (Grok)",
  deepseek: "DeepSeek",
  zai: "Z.ai (GLM)",
  huggingface: "Hugging Face",
};

/**
 * Who would receive a message before it's sent: the chosen model's provider,
 * or — when Auto chooses — every provider among the models Auto may use (the
 * available ones the plan includes). "simulated" when only the demo answers.
 */
export function recipientsFor(models: Pick<ModelWithStatus, "id" | "provider" | "available" | "locked">[], modelId: string): { names: string[]; simulated: boolean; auto: boolean } {
  const auto = isAutoId(modelId);
  const pool = auto ? models.filter((m) => m.available && !m.locked) : models.filter((m) => m.id === modelId);
  const providers = [...new Set(pool.map((m) => m.provider))];
  return { names: providers.filter((p) => p !== "demo").map((p) => PROVIDER_NAMES[p] ?? p), simulated: providers.length > 0 && providers.every((p) => p === "demo"), auto };
}
