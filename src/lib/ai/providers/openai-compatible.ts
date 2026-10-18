import { ApiError } from "../../http";
import type { AIProvider, GenerateParams, GenerateResult, ProviderId, StreamEvent, Usage } from "../types";

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
    const body: Record<string, unknown> = {
      model: params.model.providerModelId,
      messages: params.messages,
      stream,
    };
    if (params.maxOutputTokens) {
      // OpenAI's newer models use max_completion_tokens; HF router accepts max_tokens.
      body[this.id === "openai" ? "max_completion_tokens" : "max_tokens"] = params.maxOutputTokens;
    }
    if (params.temperature !== undefined && this.id !== "openai") body.temperature = params.temperature;
    if (stream && this.id === "openai") body.stream_options = { include_usage: true };
    return body;
  }

  /** One retry for transient failures (429, 5xx, network) before any output has been received. */
  private async request(params: GenerateParams, stream: boolean): Promise<Response> {
    try {
      return await this.requestOnce(params, stream);
    } catch (err) {
      const transient = err instanceof ApiError && (err.code === "rate_limited" || err.code === "upstream_error") && !params.signal?.aborted;
      if (!transient) throw err;
      await new Promise((r) => setTimeout(r, 700));
      return this.requestOnce(params, stream);
    }
  }

  private async requestOnce(params: GenerateParams, stream: boolean): Promise<Response> {
    const key = this.opts.apiKey();
    if (!key) throw new ApiError("not_configured", this.missingConfig()!);
    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(this.body(params, stream)),
        signal: params.signal,
      });
    } catch (err) {
      if ((err as Error)?.name === "TimeoutError" || params.signal?.aborted) {
        throw new ApiError("timeout", `${params.model.displayName} did not respond in time.`);
      }
      throw new ApiError("upstream_error", `Could not reach ${this.id}.`);
    }
    if (!res.ok) {
      let detail = "";
      try {
        const j = (await res.json()) as { error?: { message?: string } | string };
        detail = typeof j.error === "string" ? j.error : (j.error?.message ?? "");
      } catch {
        /* ignore */
      }
      const code =
        res.status === 429
          ? "rate_limited"
          : res.status === 401 || res.status === 403
            ? "not_configured"
            : res.status >= 500
              ? "upstream_error"
              : "bad_request";
      throw new ApiError(
        code,
        `${params.model.displayName} returned ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
      );
    }
    return res;
  }

  async generate(params: GenerateParams): Promise<GenerateResult> {
    const res = await this.request(params, false);
    const j = (await res.json()) as {
      model?: string;
      choices?: { message?: { content?: string | null } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: j.choices?.[0]?.message?.content ?? "",
      usage: toUsage(j.usage),
      simulated: false,
      servedModel: typeof j.model === "string" ? j.model : null,
    };
  }

  async *stream(params: GenerateParams): AsyncGenerator<StreamEvent> {
    const res = await this.request(params, true);
    if (!res.body) throw new ApiError("upstream_error", "Empty stream from provider.");
    let served = false;
    for await (const data of sseData(res.body)) {
      if (data === "[DONE]") break;
      let j: {
        model?: string;
        choices?: { delta?: { content?: string | null } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
      };
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
      if (j.usage) yield { type: "usage", usage: toUsage(j.usage) };
    }
  }
}

function toUsage(u?: { prompt_tokens?: number; completion_tokens?: number } | null): Usage {
  return {
    inputTokens: u?.prompt_tokens ?? null,
    outputTokens: u?.completion_tokens ?? null,
    estimated: false,
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
