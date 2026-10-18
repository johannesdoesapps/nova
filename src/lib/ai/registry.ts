import { z } from "zod";
import type { ModelInfo, ModelWithStatus, ProviderId } from "./types";

/**
 * Default model registry.
 *
 * Prices are `null` unless copied from the provider's pricing page (with the
 * date in lastVerifiedAt): pricing changes often and NOVA must not show
 * invented numbers. Set verified prices (USD per 1M tokens)
 * through the NOVA_MODELS env var or the `model_registry` table, and they
 * will flow into cost estimates automatically.
 *
 * Context windows come from each vendor's published model card and should be
 * re-checked before relying on them (lastVerifiedAt is null until you do).
 */
export const DEFAULT_MODELS: ModelInfo[] = [
  // The first available model is the default, so the low-cost Claude model leads.
  {
    id: "anthropic:claude-haiku-5-5",
    provider: "anthropic",
    providerModelId: "claude-haiku-5-5",
    displayName: "Claude Haiku 5.5",
    description: "Fast, low-cost Claude model for everyday chat, summaries and quick questions.",
    capabilities: ["chat", "fast", "low-cost", "coding", "long-context"],
    contextWindow: 1_000_000,
    inputPrice: 0.1,
    outputPrice: 0.5,
    isEnabled: true,
    lastVerifiedAt: "2026-10-06",
    priceSourceUrl: "https://www.anthropic.com/pricing",
  },
  {
    id: "anthropic:claude-sonnet-5-5",
    provider: "anthropic",
    providerModelId: "claude-sonnet-5-5",
    displayName: "Claude Sonnet 5.5",
    description: "More capable Claude model for harder questions, analysis and coding.",
    capabilities: ["chat", "reasoning", "coding", "long-context"],
    contextWindow: 1_000_000,
    inputPrice: 2,
    outputPrice: 10,
    isEnabled: true,
    lastVerifiedAt: "2026-10-06",
    priceSourceUrl: "https://www.anthropic.com/pricing",
  },
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
  provider: z.enum(["anthropic", "openai", "huggingface", "demo"]),
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

/** Parse NOVA_MODELS; invalid config is reported and ignored rather than crashing the app. */
export function parseModelsOverride(json: string | undefined): ModelInfo[] | null {
  if (!json) return null;
  try {
    const parsed = z.array(modelInfoSchema).safeParse(JSON.parse(json));
    if (!parsed.success) {
      console.warn("[nova] NOVA_MODELS is invalid and was ignored:", parsed.error.issues[0]?.message);
      return null;
    }
    return parsed.data;
  } catch {
    console.warn("[nova] NOVA_MODELS is not valid JSON and was ignored.");
    return null;
  }
}

const KEY_VARS: Record<ProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  huggingface: "HUGGINGFACE_API_KEY",
  demo: "",
};

export function withStatus(
  models: ModelInfo[],
  configured: Record<ProviderId, boolean>,
): ModelWithStatus[] {
  const anyReal = configured.anthropic || configured.openai || configured.huggingface;
  return models
    .filter((m) => m.isEnabled)
    // Demo models are only offered when no real provider is configured.
    .filter((m) => m.provider !== "demo" || !anyReal)
    .map((m) => {
      const available = configured[m.provider];
      return {
        ...m,
        available,
        unavailableReason: available ? undefined : `Set ${KEY_VARS[m.provider]} to enable`,
      };
    });
}
