import { ApiError } from "../../http";
import { reportError } from "../../observability";
import { providerErrorMessage } from "./errors";
import type { AIProvider, GenerateParams, GenerateResult, ProviderId, StreamEvent, ToolMessage, ToolTurnParams, ToolTurnResult, Usage } from "../types";

/**
 * A provider for any OpenAI-compatible Chat Completions endpoint. Used for
 * OpenAI itself and for Hugging Face Inference Providers
 * (https://router.huggingface.co/v1), which exposes the same schema.
 */
export class OpenAICompatibleProvider implements AIProvider {
  constructor(
    public id: ProviderId,
    private opts: { baseUrl: string; apiKey: () => string | undefined; envVar: string },
  ) {}

  isConfigured() {
    return Boolean(this.opts.apiKey());
  }

  missingConfig() {
    return this.isConfigured() ? null : `Set ${this.opts.envVar} to enable ${this.id} models.`;
  }

  private body(params: GenerateParams, stream: boolean) {
    const body: Record<string, unknown> = { model: params.model.providerModelId, messages: params.messages, stream };
    if (params.maxOutputTokens) {
      // OpenAI's newer models use max_completion_tokens; HF router accepts max_tokens.
      body[this.id === "openai" ? "max_completion_tokens" : "max_tokens"] = params.maxOutputTokens;
    }
    if (params.temperature !== undefined && this.id !== "openai") body.temperature = params.temperature;
    // OpenAI and DeepSeek report token usage in the final stream chunk when asked.
    if (stream && (this.id === "openai" || this.id === "deepseek" || this.id === "xai")) body.stream_options = { include_usage: true };
    return body;
  }

  /** One retry for transient failures (429, 5xx, network) before any output has been received. */
  private async request(params: Pick<GenerateParams, "model" | "signal">, body: Record<string, unknown>): Promise<Response> {
    try {
      return await this.requestOnce(params, body);
    } catch (err) {
      const transient = err instanceof ApiError && (err.code === "rate_limited" || err.code === "upstream_error") && !params.signal?.aborted;
      if (!transient) throw err;
      await new Promise((r) => setTimeout(r, 700));
      return this.requestOnce(params, body);
    }
  }

  private async requestOnce(params: Pick<GenerateParams, "model" | "signal">, payload: Record<string, unknown>): Promise<Response> {
    const key = this.opts.apiKey();
    if (!key) throw new ApiError("not_configured", this.missingConfig()!);
    // A key pasted with spaces, quotes or typographic characters can't go in a header and makes fetch throw.
    if (!/^[\x21-\x7e]+$/.test(key)) {
      throw new ApiError("not_configured", `The ${this.id} API key contains spaces or invalid characters. Re-paste it in your hosting environment and redeploy.`);
    }
    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: params.signal,
      });
    } catch (err) {
      if ((err as Error)?.name === "TimeoutError" || params.signal?.aborted) {
        throw new ApiError("timeout", `${params.model.displayName} did not respond in time.`);
      }
      const cause = (err as { cause?: { code?: string } })?.cause?.code;
      console.error(`[${this.id}] request failed: ${(err as Error)?.name ?? "Error"}${cause ? ` (${cause})` : ""}`);
      throw new ApiError("upstream_error", `Could not reach ${this.id}${cause ? ` (${cause})` : ""}.`);
    }
    if (!res.ok) {
      let detail = "";
      try {
        const j = (await res.json()) as { error?: { message?: string } | string };
        detail = typeof j.error === "string" ? j.error : (j.error?.message ?? "");
      } catch {
        /* ignore */
      }
      const code = res.status === 429 ? "rate_limited" : res.status === 401 || res.status === 403 ? "not_configured" : res.status >= 500 ? "upstream_error" : "bad_request";
      // Provider details (which can echo parts of keys or internal settings) are logged, never shown to users.
      reportError(new Error(`${params.model.id} returned ${res.status}: ${detail.slice(0, 500)}`), { where: "provider.openai-compatible" });
      throw new ApiError(code, providerErrorMessage(params.model.displayName, res.status, detail));
    }
    return res;
  }

  async generate(params: GenerateParams): Promise<GenerateResult> {
    const res = await this.request(params, this.body(params, false));
    const j = (await res.json()) as { model?: string; choices?: { message?: { content?: string | null } }[]; usage?: OpenAIUsage };
    return { text: j.choices?.[0]?.message?.content ?? "", usage: toUsage(j.usage), simulated: false, servedModel: typeof j.model === "string" ? j.model : null };
  }

  async *stream(params: GenerateParams): AsyncGenerator<StreamEvent> {
    const res = await this.request(params, this.body(params, true));
    if (!res.body) throw new ApiError("upstream_error", "Empty stream from provider.");
    let served = false;
    let finish: string | null = null;
    for await (const data of sseData(res.body)) {
      if (data === "[DONE]") break;
      let j: { model?: string; choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[]; usage?: OpenAIUsage | null };
      try {
        j = JSON.parse(data);
      } catch {
        continue;
      }
      if (!served && typeof j.model === "string" && j.model) {
        served = true;
        yield { type: "served", servedModel: j.model };
      }
      const text = j.choices?.[0]?.delta?.content;
      if (text) yield { type: "delta", text };
      if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason;
      if (j.usage) yield { type: "usage", usage: toUsage(j.usage) };
    }
    if (finish) yield { type: "stop", reason: finish === "length" ? "length" : finish === "stop" ? "end" : "other" };
  }

  /** One turn with Chat Completions function calling (offered for OpenAI's own API). */
  async toolTurn(params: ToolTurnParams): Promise<ToolTurnResult> {
    const body: Record<string, unknown> = {
      model: params.model.providerModelId,
      messages: [{ role: "system", content: params.system }, ...toOpenAIToolMessages(params.messages)],
      tools: params.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
      tool_choice: "auto",
      // OpenAI's reasoning models accept function tools on Chat Completions only with reasoning off.
      ...(this.id === "openai" ? { reasoning_effort: "none" } : {}),
      [this.id === "openai" ? "max_completion_tokens" : "max_tokens"]: params.maxOutputTokens,
    };
    const res = await this.request(params, body);
    const j = (await res.json()) as {
      model?: string;
      choices?: {
        finish_reason?: string;
        message?: { content?: string | null; refusal?: string | null; tool_calls?: { id: string; type?: string; function?: { name?: string; arguments?: string } }[] };
      }[];
      usage?: OpenAIUsage;
    };
    const choice = j.choices?.[0];
    const calls = (choice?.message?.tool_calls ?? []).filter((c) => c.function?.name).map((c) => ({ id: c.id, name: c.function!.name!, args: parseArgs(c.function!.arguments) }));
    const finish = choice?.finish_reason;
    const stop: ToolTurnResult["stop"] = choice?.message?.refusal
      ? "refusal"
      : finish === "tool_calls" || calls.length
        ? "tool_use"
        : finish === "stop"
          ? "end_turn"
          : finish === "length"
            ? "max_tokens"
            : finish === "content_filter"
              ? "refusal"
              : "other";
    return { text: (choice?.message?.content ?? choice?.message?.refusal ?? "").trim(), calls, usage: toUsage(j.usage), servedModel: typeof j.model === "string" ? j.model : null, stop };
  }
}

function parseArgs(raw: string | undefined): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw || "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The neutral tool conversation as Chat Completions messages: an assistant
 * message with tool_calls, then one "tool" message per call, then any user text.
 */
export function toOpenAIToolMessages(input: ToolMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const m of input) {
    if (m.role === "assistant") {
      const calls = m.calls ?? [];
      out.push({
        role: "assistant",
        content: m.text || (calls.length ? null : "(no reply)"),
        ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })) } : {}),
      });
    } else {
      for (const r of m.results ?? []) out.push({ role: "tool", tool_call_id: r.id, content: `${r.ok ? "" : "[failed] "}${r.text || "(empty)"}` });
      // Tool messages take text only, so pictures that go with results (or that the user attached) follow as a user message.
      const images = [...(m.results ?? []).flatMap((r) => r.images ?? []), ...(m.images ?? [])];
      if (images.length) {
        out.push({
          role: "user",
          content: [
            { type: "text", text: m.text || "The screenshots from the results above:" },
            ...images.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mediaType};base64,${i.data}` } })),
          ],
        });
      } else if (m.text.trim() || !m.results?.length) out.push({ role: "user", content: m.text || "(continue)" });
    }
  }
  return out;
}

/** OpenAI-style usage; DeepSeek reports cache hits as prompt_cache_hit_tokens. */
type OpenAIUsage = { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } | null; prompt_cache_hit_tokens?: number };

function toUsage(u?: OpenAIUsage | null): Usage {
  return {
    inputTokens: u?.prompt_tokens ?? null,
    outputTokens: u?.completion_tokens ?? null,
    estimated: false,
    cachedInputTokens: u?.prompt_tokens_details?.cached_tokens ?? u?.prompt_cache_hit_tokens ?? null,
  };
}

/** Parse a Server-Sent Events body into `data:` payloads. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const event = buffer.slice(0, idx);
        buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, "");
        const data = event
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (data) yield data;
      }
    }
    const tail = buffer
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}
