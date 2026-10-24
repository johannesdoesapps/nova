import Anthropic from "@anthropic-ai/sdk";
import { ApiError } from "../../http";
import { reportError } from "../../observability";
import { billingStop, billingStopError, providerErrorMessage } from "./errors";
import type { AIProvider, ChatMessage, GenerateParams, GenerateResult, StreamEvent, ToolMessage, ToolTurnParams, ToolTurnResult, Usage, WebCitation, WebResearchParams, WebResearchResult } from "../types";

/**
 * Per-model request settings. Effort trades answer depth against token spend
 * (thinking tokens are billed as output); chat rarely needs more than "low" on
 * Haiku. Server-side refusal fallback is only offered on Sonnet 5.5 here.
 */
const MODEL_OPTIONS: Record<string, { effort?: "low" | "medium" | "high"; fallback?: boolean }> = {
  "claude-haiku-5-5": { effort: "low" },
  "claude-sonnet-5-5": { effort: "medium", fallback: true },
};

/**
 * Tool turns (the coding agent) run within the plan's output limit, which
 * thinking tokens also count against, so thinking is kept out of the way:
 * off on Haiku, between tool calls only on Sonnet (its way of turning
 * thinking off), and low effort on Opus, where thinking can't be turned off.
 */
const TOOL_TURN_OPTIONS: Record<string, { thinking?: { type: string }; effort?: "low" | "medium" }> = {
  "claude-haiku-5-5": { thinking: { type: "disabled" } },
  "claude-sonnet-5-5": { thinking: { type: "between_tools" } },
  "claude-opus-5-5": { effort: "low" },
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
      // Caches the prefix (system prompt + earlier turns) only for long prompts: a cache write costs 1.25× input and
      // short prompts are rarely re-read in time, so caching them costs more than it saves.
      ...(shouldCache(params.messages) ? { cache_control: { type: "ephemeral" as const } } : {}),
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
      yield { type: "stop", reason: final.stop_reason === "max_tokens" ? "length" : final.stop_reason === "end_turn" ? "end" : "other" };
    } catch (err) {
      throw toApiError(err, params);
    }
  }

  async webResearch(params: WebResearchParams): Promise<WebResearchResult> {
    try {
      return await anthropicWebResearch(this.getClient(), params);
    } catch (err) {
      throw toApiError(err, params);
    }
  }

  /**
   * One turn with native tool use. Thinking blocks aren't kept between turns:
   * the agent trims long histories, which would invalidate replayed blocks,
   * so each turn starts from the visible conversation.
   */
  async toolTurn(params: ToolTurnParams): Promise<ToolTurnResult> {
    const opts = TOOL_TURN_OPTIONS[params.model.providerModelId] ?? {};
    const messages = toAnthropicToolMessages(params.messages);
    const body = {
      model: params.model.providerModelId,
      max_tokens: params.maxOutputTokens,
      system: params.system,
      messages,
      tools: params.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Beta.Messages.BetaTool.InputSchema })),
      tool_choice: { type: "auto" as const },
      ...(shouldCache([{ role: "system", content: params.system }, ...params.messages.map((m) => ({ role: m.role, content: toolMessageText(m) }))])
        ? { cache_control: { type: "ephemeral" as const } }
        : {}),
      ...(opts.thinking ? { thinking: opts.thinking } : {}),
      ...(opts.effort ? { output_config: { effort: opts.effort } } : {}),
    } as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
    try {
      const msg = await this.getClient().beta.messages.create(body, { signal: params.signal });
      const text = msg.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("")
        .trim();
      const calls = msg.content.flatMap((b) =>
        b.type === "tool_use" ? [{ id: b.id, name: b.name, args: b.input && typeof b.input === "object" && !Array.isArray(b.input) ? (b.input as Record<string, unknown>) : null }] : [],
      );
      const stop = msg.stop_reason === "tool_use" || msg.stop_reason === "end_turn" || msg.stop_reason === "max_tokens" || msg.stop_reason === "refusal" ? msg.stop_reason : "other";
      return { text, calls, usage: toUsage(msg.usage), servedModel: msg.model, stop };
    } catch (err) {
      throw toApiError(err, params);
    }
  }
}

/** Models with web search's dynamic filtering (the 2026-02-09 tool); others use the basic version. */
const DYNAMIC_FILTERING = /^claude-(opus|sonnet|fable)-/;
/** A long search turn can pause; it's resumed at most this many times before giving up. */
const MAX_CONTINUATIONS = 2;

/**
 * Claude's built-in web search: Anthropic runs the searches, and the reply's text blocks carry citations
 * with the page and the exact text relied on. A paused turn (pause_turn) is resumed by sending the
 * assistant turn back unchanged, at most MAX_CONTINUATIONS times.
 */
export async function anthropicWebResearch(client: Anthropic, params: WebResearchParams): Promise<WebResearchResult> {
  const tool = DYNAMIC_FILTERING.test(params.model.providerModelId)
    ? { type: "web_search_20260209" as const, name: "web_search" as const, max_uses: params.maxSearches }
    : { type: "web_search_20250305" as const, name: "web_search" as const, max_uses: params.maxSearches };
  const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [{ role: "user", content: params.prompt }];
  const segments: WebResearchResult["segments"] = [];
  const results = new Map<string, WebResearchResult["results"][number]>();
  const queries: string[] = [];
  let searches = 0;
  let inTok = 0;
  let outTok = 0;
  let cached = 0;
  let written = 0;
  let served: string | undefined;
  let stop: WebResearchResult["stop"] = "other";
  for (let turn = 0; turn <= MAX_CONTINUATIONS; turn++) {
    const msg = await client.beta.messages.create(
      { model: params.model.providerModelId, max_tokens: params.maxOutputTokens, system: params.system, messages, tools: [tool] } as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming,
      { signal: params.signal },
    );
    served = msg.model;
    inTok += msg.usage.input_tokens + (msg.usage.cache_creation_input_tokens ?? 0) + (msg.usage.cache_read_input_tokens ?? 0);
    outTok += msg.usage.output_tokens;
    cached += msg.usage.cache_read_input_tokens ?? 0;
    written += msg.usage.cache_creation_input_tokens ?? 0;
    searches += msg.usage.server_tool_use?.web_search_requests ?? 0;
    for (const b of msg.content) {
      if (b.type === "text") {
        const citations: WebCitation[] = (b.citations ?? []).flatMap((c) => (c.type === "web_search_result_location" ? [{ url: c.url, title: c.title ?? null, quote: c.cited_text }] : []));
        segments.push({ text: b.text, citations });
      } else if (b.type === "server_tool_use" && b.name === "web_search") {
        const q = (b.input as { query?: unknown } | null)?.query;
        if (typeof q === "string") queries.push(q.slice(0, 300));
      } else if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
        for (const r of b.content) if (r.type === "web_search_result" && !results.has(r.url)) results.set(r.url, { url: r.url, title: r.title, pageAge: r.page_age ?? null });
      }
    }
    if (msg.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: msg.content as Anthropic.Beta.Messages.BetaContentBlockParam[] });
      stop = "paused";
      continue;
    }
    stop = msg.stop_reason === "end_turn" ? "end" : msg.stop_reason === "max_tokens" ? "length" : "other";
    break;
  }
  return {
    segments,
    results: [...results.values()],
    queries,
    searches,
    usage: { inputTokens: inTok, outputTokens: outTok, estimated: false, cachedInputTokens: cached, cacheWriteInputTokens: written },
    servedModel: served,
    stop,
  };
}

function toolMessageText(m: ToolMessage): string {
  if (m.role === "assistant") return m.text + JSON.stringify(m.calls ?? []);
  return (m.results ?? []).map((r) => r.text).join("\n") + m.text;
}

/**
 * The neutral tool conversation as Messages API turns: each assistant turn's
 * text and tool_use blocks, then a user turn with one tool_result per call
 * (failed ones flagged) followed by any text. It starts with a user turn.
 */
export function toAnthropicToolMessages(input: ToolMessage[]): Anthropic.Beta.Messages.BetaMessageParam[] {
  const firstUser = input.findIndex((m) => m.role === "user");
  const out: Anthropic.Beta.Messages.BetaMessageParam[] = [];
  for (const m of firstUser === -1 ? [] : input.slice(firstUser)) {
    if (m.role === "assistant") {
      const blocks: Anthropic.Beta.Messages.BetaContentBlockParam[] = [];
      if (m.text.trim()) blocks.push({ type: "text", text: m.text });
      for (const c of m.calls ?? []) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.args ?? {} });
      if (!blocks.length) blocks.push({ type: "text", text: "(no reply)" });
      out.push({ role: "assistant", content: blocks });
    } else {
      const blocks: Anthropic.Beta.Messages.BetaContentBlockParam[] = (m.results ?? []).map((r) => ({
        type: "tool_result" as const,
        tool_use_id: r.id,
        content: r.images?.length
          ? [{ type: "text" as const, text: r.text || "(empty)" }, ...r.images.map((i) => ({ type: "image" as const, source: { type: "base64" as const, media_type: i.mediaType, data: i.data } }))]
          : r.text || "(empty)",
        ...(r.ok ? {} : { is_error: true }),
      }));
      if (m.text.trim()) blocks.push({ type: "text", text: m.text });
      for (const i of m.images ?? []) blocks.push({ type: "image", source: { type: "base64", media_type: i.mediaType, data: i.data } });
      if (!blocks.length) blocks.push({ type: "text", text: "(continue)" });
      out.push({ role: "user", content: blocks });
    }
  }
  return out;
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

/** Long prompts only (about 4,000+ tokens), where follow-ups re-reading the cache save more than the write costs. */
export function shouldCache(messages: GenerateParams["messages"]): boolean {
  return messages.reduce((n, m) => n + m.content.length, 0) >= CACHE_MIN_CHARS;
}
const CACHE_MIN_CHARS = 16_000;

function toUsage(u: Anthropic.Beta.Messages.BetaUsage): Usage {
  return {
    inputTokens: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    outputTokens: u.output_tokens,
    estimated: false,
    cachedInputTokens: u.cache_read_input_tokens ?? null,
    cacheWriteInputTokens: u.cache_creation_input_tokens ?? null,
  };
}

function toApiError(err: unknown, params: Pick<GenerateParams, "model">): Error {
  if (err instanceof ApiError) return err;
  const name = params.model.displayName;
  if (err instanceof Anthropic.APIUserAbortError || err instanceof Anthropic.APIConnectionTimeoutError) {
    return new ApiError("timeout", `${name} did not respond in time.`);
  }
  if (err instanceof Anthropic.APIError) {
    const body = err.error as { error?: { type?: string; message?: string; details?: { error_code?: string } } } | undefined;
    const stop = billingStop(err.status ?? 0, body?.error?.details?.error_code, body?.error?.message ?? err.message);
    if (stop) {
      reportError(new Error(`${params.model.id} stopped by provider billing (${stop}): ${err.status}`), { where: "provider.billing" });
      return billingStopError("anthropic", name, stop);
    }
  }
  if (err instanceof Anthropic.RateLimitError) return new ApiError("rate_limited", `${name} is busy right now. Try again shortly.`);
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    reportError(err, { where: "provider.anthropic", status: err.status });
    return new ApiError("not_configured", providerErrorMessage(name, err.status ?? 401, ""));
  }
  if (err instanceof Anthropic.APIError) {
    reportError(err, { where: "provider.anthropic", status: err.status });
    return new ApiError(err.status && err.status < 500 ? "bad_request" : "upstream_error", providerErrorMessage(name, err.status ?? 500, err.message));
  }
  return new ApiError("upstream_error", "Could not reach Anthropic.");
}
