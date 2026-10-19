export type ProviderId = "anthropic" | "openai" | "google" | "xai" | "deepseek" | "huggingface" | "demo";

export type Capability =
  | "chat"
  | "reasoning"
  | "coding"
  | "writing"
  | "long-context"
  | "fast"
  | "low-cost"
  | "vision";

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** Normalised registry entry. Prices are USD per 1M tokens, or null if unverified. */
export interface ModelInfo {
  id: string;
  provider: ProviderId;
  providerModelId: string;
  displayName: string;
  description: string;
  capabilities: Capability[];
  contextWindow: number | null;
  inputPrice: number | null;
  outputPrice: number | null;
  isEnabled: boolean;
  lastVerifiedAt: string | null;
  /** Where the price was copied from (provider pricing page or contract). */
  priceSourceUrl?: string | null;
  /** Plan tier: standard (every plan), advanced (Pro and Max), premium (Max). Derived when unset. */
  tier?: "standard" | "advanced" | "premium";
  /** Price of input tokens read from the provider's prompt cache (USD per 1M); null/unset = input price. */
  cachedInputPrice?: number | null;
  /** Price of input tokens written to the prompt cache (USD per 1M); unset = input price. */
  cacheWritePrice?: number | null;
  /**
   * The provider charges cache writes but doesn't report them separately, so
   * uncached input is counted at the cache-write price (an upper bound).
   */
  cacheWritesUnreported?: boolean;
  /** Higher prices for prompts above a size, when the provider has them. */
  longContext?: { aboveInputTokens: number; inputPrice: number; outputPrice: number; cachedInputPrice?: number | null; cacheWritePrice?: number | null } | null;
}

/** ModelInfo plus runtime availability (does this deployment have credentials?). */
export interface ModelWithStatus extends ModelInfo {
  available: boolean;
  unavailableReason?: string;
  /** The administrator's default model for new chats. */
  isDefault?: boolean;
  /** The plan that includes this model, and whether the caller's plan doesn't (set by /api/models). */
  requiredPlan?: "free" | "pro" | "max";
  locked?: boolean;
}

export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
  /** True when tokens were estimated locally rather than reported by the provider. */
  estimated: boolean;
  /** Input tokens served from the provider's prompt cache (included in inputTokens), when reported. */
  cachedInputTokens?: number | null;
  /** Input tokens written to the prompt cache (included in inputTokens), when reported. */
  cacheWriteInputTokens?: number | null;
}

export interface GenerateParams {
  model: ModelInfo;
  messages: ChatMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface GenerateResult {
  text: string;
  usage: Usage;
  /** True when the output came from demo mode, not a real model. */
  simulated: boolean;
  /** Model/version string the provider reports it actually used (e.g. a dated snapshot). */
  servedModel?: string | null;
}

export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "usage"; usage: Usage }
  | { type: "served"; servedModel: string };

export interface AIProvider {
  id: ProviderId;
  isConfigured(): boolean;
  missingConfig(): string | null;
  generate(params: GenerateParams): Promise<GenerateResult>;
  stream(params: GenerateParams): AsyncGenerator<StreamEvent, void, unknown>;
}
