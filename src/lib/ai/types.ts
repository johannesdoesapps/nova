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
  /** Allowance units one message to this model uses (set by /api/models). */
  units?: number;
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
  | { type: "served"; servedModel: string }
  /** Why the reply ended: "length" means it hit the output limit and was cut off. */
  | { type: "stop"; reason: "length" | "end" | "other" };

export interface AIProvider {
  id: ProviderId;
  isConfigured(): boolean;
  missingConfig(): string | null;
  generate(params: GenerateParams): Promise<GenerateResult>;
  stream(params: GenerateParams): AsyncGenerator<StreamEvent, void, unknown>;
  /** One model turn with native tool calling, where the provider's API has it. */
  toolTurn?(params: ToolTurnParams): Promise<ToolTurnResult>;
}

// ---------------------------------------------------------------- native tool calling

/** A tool the model may call: name, what it does, and a JSON Schema for its arguments. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed arguments; null when the model sent arguments that aren't a JSON object. */
  args: Record<string, unknown> | null;
}

export interface ToolResult {
  id: string;
  ok: boolean;
  text: string;
  /** Pictures that go with the result (e.g. screenshots), for models that take images. */
  images?: { mediaType: "image/jpeg" | "image/png"; data: string }[];
}

/**
 * A provider-neutral conversation with tool calls. A user turn carries the
 * results of the previous assistant turn's calls (all of them, in order),
 * then any text; an assistant turn carries its text and its calls.
 */
export type ToolMessage =
  | { role: "user"; text: string; results?: ToolResult[]; /** Pictures the user attached (models that take images only). */ images?: ToolResult["images"] }
  | { role: "assistant"; text: string; calls?: ToolCall[] };

export interface ToolTurnParams {
  model: ModelInfo;
  system: string;
  messages: ToolMessage[];
  tools: ToolSpec[];
  maxOutputTokens: number;
  signal?: AbortSignal;
}

export interface ToolTurnResult {
  text: string;
  calls: ToolCall[];
  usage: Usage;
  servedModel: string | null;
  /** Why the model stopped: it called tools, ended its turn, hit the output limit, or declined. */
  stop: "tool_use" | "end_turn" | "max_tokens" | "refusal" | "other";
}
