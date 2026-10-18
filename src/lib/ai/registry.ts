import { z } from "zod";
import type { ModelInfo, ModelWithStatus, ProviderId } from "./types";

/**
 * Default model registry.
 *
 * Prices are deliberately `null`: provider pricing changes often and NOVARA
 * must not show invented numbers. Set verified prices (USD per 1M tokens)
 * through the NOVARA_MODELS env var or the `model_registry` table, and they
 * will flow into cost estimates automatically.
 *
 * Context windows come from each vendor's published model card and should be
 * re-checked before relying on them (lastVerifiedAt is null until you do).
 */
export const DEFAULT_MODELS: ModelInfo[] = [
  {
    id: "openai:gpt-5-mini",
    provider: "openai",
    providerModelId: "gpt-5-mini",
    displayName: "GPT-5 mini",
    description: "Fast, lower-cost OpenAI model for everyday questions and summaries.",
    capabilities: ["chat", "fast", "low-cost", "coding", "long-context"],
    contextWindow: 400_000,
    inputPrice: null,
    outputPrice: null,
    isEnabled: true,
    lastVerifiedAt: null,
  },
  {
    id: "openai:gpt-5",
    provider: "openai",
    providerModelId: "gpt-5",
    displayName: "GPT-5",
    description: "OpenAI's more capable reasoning model for complex analysis and coding.",
    capabilities: ["chat", "reasoning", "coding", "long-context"],
    contextWindow: 400_000,
    inputPrice: null,
    outputPrice: null,
    isEnabled: true,
    lastVerifiedAt: null,
  },
  {
    id: "hf:gpt-oss-120b",
    provider: "huggingface",
    providerModelId: "openai/gpt-oss-120b",
    displayName: "gpt-oss-120b",
    description: "Open-weight reasoning model served through Hugging Face Inference Providers.",
    capabilities: ["chat", "reasoning", "coding"],
    contextWindow: 131_072,
    inputPrice: null,
    outputPrice: null,
    isEnabled: true,
    lastVerifiedAt: null,
  },
  {
    id: "hf:llama-3.3-70b",
    provider: "huggingface",
    providerModelId: "meta-llama/Llama-3.3-70B-Instruct",
    displayName: "Llama 3.3 70B Instruct",
    description: "Meta's open instruction-tuned model via Hugging Face Inference Providers.",
    capabilities: ["chat"],
    contextWindow: 131_072,
    inputPrice: null,
    outputPrice: null,
    isEnabled: true,
    lastVerifiedAt: null,
  },
  {
    id: "demo:alpha",
    provider: "demo",
    providerModelId: "demo-alpha",
    displayName: "Demo model A (simulated)",
    description: "Local template output for trying the interface without API keys. Not a real model.",
    capabilities: ["chat", "fast", "low-cost"],
    contextWindow: null,
    inputPrice: 0,
    outputPrice: 0,
    isEnabled: true,
    lastVerifiedAt: null,
  },
  {
    id: "demo:beta",
    provider: "demo",
    providerModelId: "demo-beta",
    displayName: "Demo model B (simulated)",
    description: "A second simulated model so Model Battle can be tried without keys.",
    capabilities: ["chat"],
    contextWindow: null,
    inputPrice: 0,
    outputPrice: 0,
    isEnabled: true,
    lastVerifiedAt: null,
  },
];

const capability = z.enum(["chat", "reasoning", "coding", "long-context", "fast", "low-cost", "vision"]);

export const modelInfoSchema = z.object({
  id: z.string().min(1).max(120),
  provider: z.enum(["openai", "huggingface", "demo"]),
  providerModelId: z.string().min(1).max(200),
  displayName: z.string().min(1).max(120),
  description: z.string().max(500).default(""),
  capabilities: z.array(capability).default(["chat"]),
  contextWindow: z.number().int().positive().nullable().default(null),
  inputPrice: z.number().nonnegative().nullable().default(null),
  outputPrice: z.number().nonnegative().nullable().default(null),
  isEnabled: z.boolean().default(true),
  lastVerifiedAt: z.string().nullable().default(null),
  priceSourceUrl: z.url().nullable().default(null),
});

/** Parse NOVARA_MODELS; invalid config is reported and ignored rather than crashing the app. */
export function parseModelsOverride(json: string | undefined): ModelInfo[] | null {
  if (!json) return null;
  try {
    const parsed = z.array(modelInfoSchema).safeParse(JSON.parse(json));
    if (!parsed.success) {
      console.warn("[novara] NOVARA_MODELS is invalid and was ignored:", parsed.error.issues[0]?.message);
      return null;
    }
    return parsed.data;
  } catch {
    console.warn("[novara] NOVARA_MODELS is not valid JSON and was ignored.");
    return null;
  }
}

export function withStatus(
  models: ModelInfo[],
  configured: Record<ProviderId, boolean>,
): ModelWithStatus[] {
  const anyReal = configured.openai || configured.huggingface;
  return models
    .filter((m) => m.isEnabled)
    // Demo models are only offered when no real provider is configured.
    .filter((m) => m.provider !== "demo" || !anyReal)
    .map((m) => {
      const available = configured[m.provider];
      return {
        ...m,
        available,
        unavailableReason: available
          ? undefined
          : m.provider === "openai"
            ? "Set OPENAI_API_KEY to enable"
            : "Set HUGGINGFACE_API_KEY to enable",
      };
    });
}
