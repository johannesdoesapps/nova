export type ProviderId = "openai" | "huggingface" | "demo";

export type Capability =
  | "chat"
  | "reasoning"
  | "coding"
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
}

/** ModelInfo plus runtime availability (does this deployment have credentials?). */
export interface ModelWithStatus extends ModelInfo {
  available: boolean;
  unavailableReason?: string;
}

export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
  /** True when tokens were estimated locally rather than reported by the provider. */
  estimated: boolean;
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
}

export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "usage"; usage: Usage };

export interface AIProvider {
  id: ProviderId;
  isConfigured(): boolean;
  missingConfig(): string | null;
  generate(params: GenerateParams): Promise<GenerateResult>;
  stream(params: GenerateParams): AsyncGenerator<StreamEvent, void, unknown>;
}
