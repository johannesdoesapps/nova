import { z } from "zod";
import type { ModelInfo, ModelWithStatus, ProviderId } from "./types";

/**
 * Default model registry.
 *
 * Prices are `null` unless copied from the provider's pricing page (with the
 * date in lastVerifiedAt): pricing changes often and Orbis must not show
 * invented numbers. Set verified prices (USD per 1M tokens)
 * through the ORBIS_MODELS env var or the `model_registry` table, and they
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
    capabilities: ["chat", "fast", "low-cost", "coding", "writing", "long-context", "vision"],
    contextWindow: 1_000_000,
    inputPrice: 0.1,
    outputPrice: 0.5,
    cachedInputPrice: 0.01,
    cacheWritePrice: 0.125,
    // Prompts over 100,000 tokens are billed at higher rates.
    longContext: { aboveInputTokens: 100_000, inputPrice: 0.5, outputPrice: 2.5, cachedInputPrice: 0.05, cacheWritePrice: 0.625 },
    isEnabled: true,
    lastVerifiedAt: "2026-10-19",
    priceSourceUrl: "https://platform.claude.com/docs/en/about-claude/pricing",
  },
  {
    id: "anthropic:claude-sonnet-5-5",
    provider: "anthropic",
    providerModelId: "claude-sonnet-5-5",
    displayName: "Claude Sonnet 5.5",
    description: "More capable Claude model for harder questions, analysis, long-form writing and coding.",
    capabilities: ["chat", "reasoning", "coding", "writing", "long-context", "vision"],
    contextWindow: 1_000_000,
    inputPrice: 2,
    outputPrice: 10,
    cachedInputPrice: 0.1,
    cacheWritePrice: 2.5,
    isEnabled: true,
    lastVerifiedAt: "2026-10-19",
    priceSourceUrl: "https://platform.claude.com/docs/en/about-claude/pricing",
  },
  {
    // Premium: offered on the Max plan.
    id: "anthropic:claude-opus-5-5",
    provider: "anthropic",
    providerModelId: "claude-opus-5-5",
    displayName: "Claude Opus 5.5",
    description: "Anthropic's most capable generally available Claude model, for the hardest reasoning, research and coding.",
    capabilities: ["chat", "reasoning", "coding", "writing", "long-context", "vision"],
    tier: "premium",
    contextWindow: 1_000_000,
    inputPrice: 4,
    outputPrice: 20,
    cachedInputPrice: 0.2,
    cacheWritePrice: 5,
    isEnabled: true,
    lastVerifiedAt: "2026-10-19",
    priceSourceUrl: "https://platform.claude.com/docs/en/about-claude/pricing",
  },
  // OpenAI GPT-5.6 replaces GPT-5 / GPT-5 mini, which OpenAI shuts down on
  // Dec 11, 2026 (see RETIRED_MODELS). Prices (standard tier, incl. cached input and long-context rates) verified on OpenAI's pricing page, 2026-10-19.
  {
    id: "openai:gpt-5.6-luna",
    provider: "openai",
    providerModelId: "gpt-5.6-luna",
    displayName: "GPT-5.6 Luna",
    description: "OpenAI's low-cost GPT-5.6 model for everyday questions, summaries and quick drafts.",
    capabilities: ["chat", "fast", "low-cost", "coding", "writing", "long-context", "vision"],
    contextWindow: 1_050_000,
    inputPrice: 0.2,
    outputPrice: 1.2,
    cachedInputPrice: 0.02,
    cacheWritePrice: 0.25,
    cacheWritesUnreported: true,
    longContext: { aboveInputTokens: 272_000, inputPrice: 0.4, outputPrice: 1.8, cachedInputPrice: 0.04, cacheWritePrice: 0.5 },
    isEnabled: true,
    lastVerifiedAt: "2026-10-19",
    priceSourceUrl: "https://developers.openai.com/api/docs/pricing",
  },
  {
    id: "openai:gpt-5.6-terra",
    provider: "openai",
    providerModelId: "gpt-5.6-terra",
    displayName: "GPT-5.6 Terra",
    description: "OpenAI's balanced GPT-5.6 reasoning model for analysis, writing and coding.",
    capabilities: ["chat", "reasoning", "coding", "writing", "long-context", "vision"],
    contextWindow: 1_050_000,
    inputPrice: 2,
    outputPrice: 12,
    cachedInputPrice: 0.2,
    cacheWritePrice: 2.5,
    cacheWritesUnreported: true,
    longContext: { aboveInputTokens: 272_000, inputPrice: 4, outputPrice: 18, cachedInputPrice: 0.4, cacheWritePrice: 5 },
    isEnabled: true,
    lastVerifiedAt: "2026-10-19",
    priceSourceUrl: "https://developers.openai.com/api/docs/pricing",
  },
  {
    // Premium: offered on the Max plan.
    id: "openai:gpt-5.6-sol",
    provider: "openai",
    providerModelId: "gpt-5.6-sol",
    displayName: "GPT-5.6 Sol",
    description: "OpenAI's most capable GPT-5.6 model, for the hardest reasoning, research and coding.",
    capabilities: ["chat", "reasoning", "coding", "writing", "long-context", "vision"],
    tier: "premium",
    contextWindow: 1_050_000,
    inputPrice: 4,
    outputPrice: 20,
    cachedInputPrice: 0.4,
    cacheWritePrice: 5,
    cacheWritesUnreported: true,
    longContext: { aboveInputTokens: 272_000, inputPrice: 8, outputPrice: 30, cachedInputPrice: 0.8, cacheWritePrice: 10 },
    isEnabled: true,
    lastVerifiedAt: "2026-10-19",
    priceSourceUrl: "https://developers.openai.com/api/docs/pricing",
  },
  {
    // Google's OpenAI-compatible Gemini endpoint. Admins can add other Gemini
    // models (listed by "Test connection" in Admin) without a code change.
    // Price: $0.75 / $3.75 through Dec 31, 2026, then $1.50 / $7.50 — update on Jan 1, 2027.
    id: "google:gemini-3.8-flash",
    provider: "google",
    providerModelId: "gemini-3.8-flash",
    displayName: "Gemini 3.8 Flash",
    description: "Google's fast Gemini model for everyday questions, summaries, drafts and code.",
    capabilities: ["chat", "fast", "low-cost", "coding", "writing", "vision"],
    contextWindow: null,
    inputPrice: 0.75,
    outputPrice: 3.75,
    isEnabled: true,
    lastVerifiedAt: "2026-10-19",
    priceSourceUrl: "https://ai.google.dev/gemini-api/docs/pricing",
  },
  {
    // Not on Google's free tier. Price: $2 / $10 through Nov 30, 2026, then $4 / $20 — update on Dec 1, 2026.
    id: "google:gemini-4-argon",
    provider: "google",
    providerModelId: "gemini-4-argon",
    displayName: "Gemini 4 Argon",
    description: "Google's flagship reasoning model for complex analysis, maths and software engineering.",
    capabilities: ["chat", "reasoning", "coding", "writing", "long-context"],
    contextWindow: null,
    inputPrice: 2,
    outputPrice: 10,
    isEnabled: true,
    lastVerifiedAt: "2026-10-19",
    priceSourceUrl: "https://ai.google.dev/gemini-api/docs/pricing",
  },
  {
    // xAI's OpenAI-compatible API (https://api.x.ai/v1). Prices are for prompts under
    // 200k tokens; longer prompts are billed at double the rate.
    id: "xai:grok-4.3",
    provider: "xai",
    providerModelId: "grok-4.3",
    displayName: "Grok 4.3",
    description: "xAI's economical Grok model with a 1M-token context for chat, writing and code.",
    capabilities: ["chat", "coding", "writing", "long-context"],
    contextWindow: 1_000_000,
    inputPrice: 1.25,
    outputPrice: 2.5,
    isEnabled: true,
    lastVerifiedAt: "2026-10-19",
    priceSourceUrl: "https://docs.x.ai/developers/models",
  },
  {
    id: "xai:grok-4.7",
    provider: "xai",
    providerModelId: "grok-4.7",
    displayName: "Grok 4.7",
    description: "xAI's most capable Grok model for reasoning, analysis and coding.",
    capabilities: ["chat", "reasoning", "coding", "writing", "long-context"],
    contextWindow: 500_000,
    inputPrice: 2,
    outputPrice: 6,
    isEnabled: true,
    lastVerifiedAt: "2026-10-19",
    priceSourceUrl: "https://docs.x.ai/developers/models",
  },
  {
    // DeepSeek's OpenAI-compatible API. Model IDs change between releases: use
    // Admin → Test connection to list the IDs your key supports, and add or
    // disable models there. Prices stay unset until verified on DeepSeek's page.
    id: "deepseek:deepseek-flash",
    provider: "deepseek",
    providerModelId: "deepseek-flash",
    displayName: "DeepSeek Flash",
    description: "DeepSeek's fast, economical model for everyday chat, writing and code, in Chinese and English.",
    capabilities: ["chat", "fast", "low-cost", "coding", "writing"],
    contextWindow: null,
    inputPrice: null,
    outputPrice: null,
    isEnabled: true,
    lastVerifiedAt: null,
  },
  {
    id: "deepseek:deepseek-v4-pro",
    provider: "deepseek",
    providerModelId: "deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro",
    description: "DeepSeek's more capable model for reasoning, analysis and harder coding tasks.",
    capabilities: ["chat", "reasoning", "coding", "writing"],
    contextWindow: null,
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

/**
 * Models the provider has shut down or announced for shutdown, mapped to their
 * replacement. Requests naming them (saved choices, agents, settings) use the
 * replacement; saved replies keep showing the original name.
 */
export const RETIRED_MODELS: Record<string, { displayName: string; replacement: string }> = {
  "openai:gpt-5-mini": { displayName: "GPT-5 mini", replacement: "openai:gpt-5.6-luna" },
  "openai:gpt-5": { displayName: "GPT-5", replacement: "openai:gpt-5.6-terra" },
};

export const CAPABILITIES = ["chat", "reasoning", "coding", "writing", "long-context", "fast", "low-cost", "vision"] as const;
const capability = z.enum(CAPABILITIES);

export const modelInfoSchema = z.object({
  id: z.string().min(1).max(120),
  provider: z.enum(["anthropic", "openai", "google", "xai", "deepseek", "huggingface", "demo"]),
  providerModelId: z.string().min(1).max(200),
  displayName: z.string().min(1).max(120),
  description: z.string().max(500).default(""),
  capabilities: z.array(capability).default(["chat"]),
  /** Plan tier: standard (all plans), advanced (Pro and Max), premium (Max). Defaults by capability. */
  tier: z.enum(["standard", "advanced", "premium"]).optional(),
  contextWindow: z.number().int().positive().nullable().default(null),
  inputPrice: z.number().nonnegative().nullable().default(null),
  outputPrice: z.number().nonnegative().nullable().default(null),
  cachedInputPrice: z.number().nonnegative().nullable().optional(),
  cacheWritePrice: z.number().nonnegative().nullable().optional(),
  cacheWritesUnreported: z.boolean().optional(),
  longContext: z
    .object({
      aboveInputTokens: z.number().int().positive(),
      inputPrice: z.number().nonnegative(),
      outputPrice: z.number().nonnegative(),
      cachedInputPrice: z.number().nonnegative().nullable().optional(),
      cacheWritePrice: z.number().nonnegative().nullable().optional(),
    })
    .nullable()
    .optional(),
  isEnabled: z.boolean().default(true),
  lastVerifiedAt: z.string().nullable().default(null),
  priceSourceUrl: z.url().nullable().default(null),
});

/** Parse ORBIS_MODELS; invalid config is reported and ignored rather than crashing the app. */
export function parseModelsOverride(json: string | undefined): ModelInfo[] | null {
  if (!json) return null;
  try {
    const parsed = z.array(modelInfoSchema).safeParse(JSON.parse(json));
    if (!parsed.success) {
      console.warn("[orbis] ORBIS_MODELS is invalid and was ignored:", parsed.error.issues[0]?.message);
      return null;
    }
    return parsed.data;
  } catch {
    console.warn("[orbis] ORBIS_MODELS is not valid JSON and was ignored.");
    return null;
  }
}

export const KEY_VARS: Record<ProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  xai: "XAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  huggingface: "HUGGINGFACE_API_KEY",
  demo: "",
};

export function withStatus(
  models: ModelInfo[],
  configured: Record<ProviderId, boolean>,
): ModelWithStatus[] {
  const anyReal = configured.anthropic || configured.openai || configured.google || configured.xai || configured.deepseek || configured.huggingface;
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
