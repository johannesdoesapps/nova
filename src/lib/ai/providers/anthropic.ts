import Anthropic from "@anthropic-ai/sdk";
import { ApiError } from "../../http";
import type { AIProvider, ChatMessage, GenerateParams, GenerateResult, StreamEvent, Usage } from "../types";

/**
 * Per-model request settings. Effort trades answer depth against token spend
 * (thinking tokens are billed as output); chat rarely needs more than "low" on
 * Haiku. Server-side refusal fallback is only offered on Sonnet 5.5 here.
 */
const MODEL_OPTIONS: Record<string, { effort?: "low" | "medium" | "high"; fallback?: boolean }> = {
  "claude-haiku-5-5": { effort: "low" },
  "claude-sonnet-5-5": { effort: "medium", fallback: true },
};

/** Anthropic Messages API via the official SDK. */
export class AnthropicProvider implements AIProvider {
  id = "anthropic" as const;
  private client: Anthropic | null = null;
  private clientKey: string | undefined;

  constructor(private apiKey: () => string | undefined) {}

  isConfigured() {
    return Boolean(this.apiKey());
  }

  missingConfig() {
    return this.isConfigured() ? null : "Set ANTHROPIC_API_KEY to enable Claude models.";
  }

  private getClient(): Anthropic {
    const key = this.apiKey();
    if (!key) throw new ApiError("not_configured", this.missingConfig()!);
    if (!this.client || this.clientKey !== key) {
      // One retry keeps a transient 429/5xx from failing the turn without blowing the route's time budget.
      this.client = new Anthropic({ apiKey: key, maxRetries: 1 });
      this.clientKey = key;
    }
    return this.client;
  }

  private body(params: GenerateParams): Anthropic.Beta.Messages.MessageCreateParamsNonStreaming {
    const opts = MODEL_OPTIONS[params.model.providerModelId] ?? {};
    const { system, messages } = toAnthropicMessages(params.messages);
    // Temperature is omitted: current Claude models reject non-default sampling values.
    return {
      model: params.model.providerModelId,
      max_tokens: params.maxOutputTokens ?? 4096,
      ...(system ? { system } : {}),
      messages,
      // Caches the stable prefix (system prompt + earlier turns) so follow-ups cost less.
      cache_control: { type: "ephemeral" },
      ...(opts.effort ? { output_config: { effort: opts.effort } } : {}),
      ...(opts.fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    };
  }

  async generate(params: GenerateParams): Promise<GenerateResult> {
    try {
      const msg = await this.getClient().beta.messages.create(this.body(params), { signal: params.signal });
      return {
        text: replyText(msg),
        usage: toUsage(msg.usage),
        simulated: false,
        servedModel: msg.model,
      };
    } catch (err) {
      throw toApiError(err, params);
    }
  }

  async *stream(params: GenerateParams): AsyncGenerator<StreamEvent> {
    try {
      const stream = this.getClient().beta.messages.stream(this.body(params), { signal: params.signal });
      let wroteText = false;
      for await (const event of stream) {
        if (event.type === "message_start") {
          yield { type: "served", servedModel: event.message.model };
        } else if (event.type === "content_block_delta" && event.delta.type === "text_delta" && event.delta.text) {
          wroteText = true;
          yield { type: "delta", text: event.delta.text };
        }
      }
      const final = await stream.finalMessage();
      if (final.stop_reason === "refusal" && !wroteText) {
        yield { type: "delta", text: REFUSAL_TEXT };
      }
      yield { type: "usage", usage: toUsage(final.usage) };
    } catch (err) {
      throw toApiError(err, params);
    }
  }
}

const REFUSAL_TEXT = "I can't help with that request.";

function replyText(msg: Anthropic.Beta.Messages.BetaMessage): string {
  const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  return text || (msg.stop_reason === "refusal" ? REFUSAL_TEXT : "");
}

/** System messages become the top-level system prompt; the conversation must start with a user turn. */
export function toAnthropicMessages(input: ChatMessage[]): {
  system: string;
  messages: Anthropic.Beta.Messages.BetaMessageParam[];
} {
  const system = input
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const turns = input.filter((m) => m.role !== "system");
  const firstUser = turns.findIndex((m) => m.role === "user");
  const messages = (firstUser === -1 ? [] : turns.slice(firstUser)).map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));
  return { system, messages };
}

function toUsage(u: Anthropic.Beta.Messages.BetaUsage): Usage {
  return {
    inputTokens: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    outputTokens: u.output_tokens,
    estimated: false,
    cachedInputTokens: u.cache_read_input_tokens ?? null,
    cacheWriteInputTokens: u.cache_creation_input_tokens ?? null,
  };
}

function toApiError(err: unknown, params: GenerateParams): Error {
  if (err instanceof ApiError) return err;
  const name = params.model.displayName;
  if (err instanceof Anthropic.APIUserAbortError || err instanceof Anthropic.APIConnectionTimeoutError) {
    return new ApiError("timeout", `${name} did not respond in time.`);
  }
  if (err instanceof Anthropic.RateLimitError) return new ApiError("rate_limited", `${name} is busy right now. Try again shortly.`);
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new ApiError("not_configured", `${name} rejected the API key. Check ANTHROPIC_API_KEY.`);
  }
  if (err instanceof Anthropic.APIError) {
    return new ApiError("upstream_error", `${name} returned ${err.status ?? "an error"}: ${err.message.slice(0, 300)}`);
  }
  return new ApiError("upstream_error", "Could not reach Anthropic.");
}
