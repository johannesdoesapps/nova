/**
 * DeepSeek provider: request shape, streaming, usage, interrupted streams,
 * errors and key handling — with fetch stubbed, so no real API calls.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { highlight } from "@/components/common/highlight";
import { OpenAICompatibleProvider } from "@/lib/ai/providers/openai-compatible";
import { DEFAULT_MODELS, withStatus } from "@/lib/ai/registry";

const flash = DEFAULT_MODELS.find((m) => m.id === "deepseek:deepseek-flash")!;
const sseOf = (chunks: object[]) => chunks.map((j) => `data: ${JSON.stringify(j)}\n\n`).join("") + "data: [DONE]\n\n";
const deepseek = (key: string | null = "sk-ds-test") =>
  new OpenAICompatibleProvider("deepseek", { baseUrl: "https://api.deepseek.com/v1", apiKey: () => key ?? undefined, envVar: "DEEPSEEK_API_KEY" });

afterEach(() => vi.unstubAllGlobals());

describe("DeepSeek provider", () => {
  it("is registered with configurable models and only offered when its key is set", () => {
    expect(DEFAULT_MODELS.filter((m) => m.provider === "deepseek").map((m) => m.providerModelId)).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
    const off = withStatus(DEFAULT_MODELS, { anthropic: false, openai: true, google: false, xai: false, deepseek: false, huggingface: false, demo: true });
    expect(off.find((m) => m.id === flash.id)).toMatchObject({ available: false, unavailableReason: "Set DEEPSEEK_API_KEY to enable" });
    const on = withStatus(DEFAULT_MODELS, { anthropic: false, openai: false, google: false, xai: false, deepseek: true, huggingface: false, demo: true });
    expect(on.find((m) => m.id === flash.id)!.available).toBe(true);
    expect(on.some((m) => m.provider === "demo")).toBe(false);
  });

  it("streams Chinese and English text, reports usage, and sends the key only server-side", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        sseOf([
          { model: "deepseek-flash", choices: [{ delta: { content: "你好" } }] },
          { choices: [{ delta: { content: ", hello!" } }] },
          { choices: [], usage: { prompt_tokens: 12, completion_tokens: 4 } },
        ]),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    let text = "";
    let usage;
    let served;
    for await (const ev of deepseek().stream({ model: flash, messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "你好" }], maxOutputTokens: 100, temperature: 0.3 })) {
      if (ev.type === "delta") text += ev.text;
      else if (ev.type === "usage") usage = ev.usage;
      else served = ev.servedModel;
    }
    expect(text).toBe("你好, hello!");
    expect(served).toBe("deepseek-flash");
    expect(usage).toEqual({ inputTokens: 12, outputTokens: 4, estimated: false });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-ds-test");
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: "deepseek-flash",
      stream: true,
      max_tokens: 100,
      temperature: 0.3,
      stream_options: { include_usage: true },
      messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "你好" }],
    });
  });

  it("stops cleanly when the user presses Stop mid-stream", async () => {
    const enc = new TextEncoder();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`));
            init.signal?.addEventListener("abort", () => c.error(new DOMException("Aborted", "AbortError")));
          },
        });
        return new Response(body);
      }),
    );
    const ac = new AbortController();
    let text = "";
    await expect(
      (async () => {
        for await (const ev of deepseek().stream({ model: flash, messages: [{ role: "user", content: "hi" }], signal: ac.signal })) {
          if (ev.type === "delta") {
            text += ev.text;
            ac.abort();
          }
        }
      })(),
    ).rejects.toThrow();
    expect(text).toBe("partial");
  });

  it("explains missing keys, rejected keys and rate limits in plain language", async () => {
    await expect(deepseek(null).generate({ model: flash, messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(/DEEPSEEK_API_KEY/);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "Authentication Fails" } }), { status: 401 })));
    await expect(deepseek().generate({ model: flash, messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ code: "not_configured" });
    const limited = vi.fn(async () => new Response(JSON.stringify({ error: { message: "Rate limit" } }), { status: 429 }));
    vi.stubGlobal("fetch", limited);
    await expect(deepseek().generate({ model: flash, messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ code: "rate_limited" });
    expect(limited).toHaveBeenCalledTimes(2);
  });
});

describe("code highlighting", () => {
  const html = (code: string, lang: string) => renderToStaticMarkup(createElement("code", null, highlight(code, lang)));
  it("colours keywords, strings, numbers, comments and calls", () => {
    const out = html('const n = 42; // answer\nprint("hi")', "ts");
    expect(out).toContain('<span class="tok-k">const</span>');
    expect(out).toContain('<span class="tok-n">42</span>');
    expect(out).toContain('<span class="tok-c">// answer</span>');
    expect(out).toContain('<span class="tok-f">print</span>');
    expect(out).toContain('<span class="tok-s">&quot;hi&quot;</span>');
  });
  it("keeps the text exactly and leaves plain text alone", () => {
    const code = 'def f(x):\n    return x * 2  # double\n';
    expect(html(code, "python").replace(/<[^>]+>/g, "")).toBe(code.replace(/"/g, "&quot;"));
    expect(highlight("just words", "text")).toBe("just words");
  });
});
