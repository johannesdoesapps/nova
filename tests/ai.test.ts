import { describe, expect, it, vi, afterEach } from "vitest";
import { estimateCost, estimateTokens } from "@/lib/ai/cost";
import { DEFAULT_MODELS, parseModelsOverride, RETIRED_MODELS, withStatus } from "@/lib/ai/registry";
import { classifyTask, recommendModel } from "@/lib/ai/router";
import { OpenAICompatibleProvider, sseData } from "@/lib/ai/providers/openai-compatible";
import { demoProvider, DEMO_NOTICE } from "@/lib/ai/providers/demo";
import type { ModelWithStatus } from "@/lib/ai/types";

const all = { anthropic: false, openai: true, google: false, xai: false, deepseek: false, huggingface: true, demo: true };

describe("cost", () => {
  it("estimates ~4 chars per token", () => {
    expect(estimateTokens("abcd".repeat(10))).toBe(10);
  });
  it("returns null instead of inventing a price", () => {
    expect(estimateCost({ inputPrice: null, outputPrice: null }, { inputTokens: 1000, outputTokens: 1000 })).toBeNull();
    expect(estimateCost({ inputPrice: 1, outputPrice: 2 }, { inputTokens: null, outputTokens: 10 })).toBeNull();
  });
  it("computes USD per 1M tokens", () => {
    expect(estimateCost({ inputPrice: 2, outputPrice: 8 }, { inputTokens: 500_000, outputTokens: 250_000 })).toBeCloseTo(3);
  });
});

describe("registry", () => {
  it("ships prices for real providers only with a source and verification date", () => {
    for (const m of DEFAULT_MODELS.filter((m) => m.provider !== "demo")) {
      if (m.inputPrice === null && m.outputPrice === null) continue;
      expect(m.priceSourceUrl).toMatch(/^https:\/\//);
      expect(m.lastVerifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
  it("defaults to the low-cost Claude model when an Anthropic key is set", () => {
    const models = withStatus(DEFAULT_MODELS, { anthropic: true, openai: true, google: false, xai: false, deepseek: false, huggingface: false, demo: true });
    expect(models.find((m) => m.available)?.id).toBe("anthropic:claude-haiku-5-5");
    const noClaude = withStatus(DEFAULT_MODELS, { anthropic: false, openai: true, google: false, xai: false, deepseek: false, huggingface: false, demo: true });
    expect(noClaude.find((m) => m.available)?.provider).toBe("openai");
    expect(noClaude.find((m) => m.provider === "anthropic")?.unavailableReason).toContain("ANTHROPIC_API_KEY");
  });
  it("offers demo models only when no real provider is configured", () => {
    const none = withStatus(DEFAULT_MODELS, { anthropic: false, openai: false, google: false, xai: false, deepseek: false, huggingface: false, demo: true });
    expect(none.some((m) => m.provider === "demo" && m.available)).toBe(true);
    expect(none.filter((m) => m.provider === "openai").every((m) => !m.available && m.unavailableReason?.includes("OPENAI_API_KEY"))).toBe(true);
    const some = withStatus(DEFAULT_MODELS, { anthropic: false, openai: true, google: false, xai: false, deepseek: false, huggingface: false, demo: true });
    expect(some.some((m) => m.provider === "demo")).toBe(false);
    const grokOnly = withStatus(DEFAULT_MODELS, { anthropic: false, openai: false, google: false, xai: true, deepseek: false, huggingface: false, demo: true });
    expect(grokOnly.some((m) => m.provider === "demo")).toBe(false);
    expect(grokOnly.filter((m) => m.provider === "xai").every((m) => m.available)).toBe(true);
  });
  it("maps every retired model to a current one", () => {
    for (const [id, r] of Object.entries(RETIRED_MODELS)) {
      expect(DEFAULT_MODELS.some((m) => m.id === id)).toBe(false);
      expect(DEFAULT_MODELS.some((m) => m.id === r.replacement)).toBe(true);
    }
  });
  it("parses a valid NOVA_MODELS override and ignores invalid JSON", () => {
    const parsed = parseModelsOverride(JSON.stringify([{ id: "x", provider: "openai", providerModelId: "m", displayName: "X", inputPrice: 1, outputPrice: 2 }]));
    expect(parsed?.[0]).toMatchObject({ id: "x", capabilities: ["chat"], contextWindow: null, inputPrice: 1 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseModelsOverride("{nope")).toBeNull();
    expect(parseModelsOverride(JSON.stringify([{ id: "x", provider: "bogus" }]))).toBeNull();
    warn.mockRestore();
  });
});

describe("router", () => {
  const models = withStatus(DEFAULT_MODELS, all) as ModelWithStatus[];
  it("classifies tasks with transparent rules", () => {
    expect(classifyTask("Summarize this article in 3 bullet points").kind).toBe("summary");
    expect(classifyTask("Why does this throw TypeError in my function?").kind).toBe("coding");
    expect(classifyTask("Compare the pros and cons of two pricing strategies").kind).toBe("analysis");
    expect(classifyTask("x".repeat(200_000)).kind).toBe("long-document");
    expect(classifyTask("hello there").kind).toBe("general");
    // Coding mode doesn't turn every message into a programming task.
    expect(classifyTask("whats the time in new york", "coding").kind).toBe("general");
    expect(classifyTask("how do I center a div with css", "coding").kind).toBe("coding");
  });
  it("recommends a fast/low-cost model for summaries and a reasoning model for analysis", () => {
    expect(recommendModel(models, "Summarise these notes").model?.capabilities).toContain("low-cost");
    expect(recommendModel(models, "Evaluate the trade-offs of this strategy").model?.capabilities).toContain("reasoning");
  });
  it("excludes models whose context window is too small for long prompts", () => {
    const r = recommendModel(models, "word ".repeat(150_000));
    expect(r.model?.contextWindow ?? 0).toBeGreaterThan(150_000 * 1.25);
  });
  it("never recommends unavailable models and always explains itself", () => {
    const none = withStatus(DEFAULT_MODELS.filter((m) => m.provider !== "demo"), { anthropic: false, openai: false, google: false, xai: false, deepseek: false, huggingface: false, demo: true });
    const r = recommendModel(none, "anything");
    expect(r.model).toBeNull();
    expect(r.explanation.length).toBeGreaterThan(0);
    expect(r.disclaimer).toMatch(/estimates/i);
  });
});

describe("OpenAI-compatible provider", () => {
  afterEach(() => vi.unstubAllGlobals());
  const model = { ...DEFAULT_MODELS.find((m) => m.id === "openai:gpt-5.6-luna")! };

  it("parses SSE across chunk boundaries", async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('data: {"a":1}\n\nda'));
        c.enqueue(enc.encode('ta: {"a":2}\n\ndata: [DONE]\n\n'));
        c.close();
      },
    });
    const out: string[] = [];
    for await (const d of sseData(body)) out.push(d);
    expect(out).toEqual(['{"a":1}', '{"a":2}', "[DONE]"]);
  });

  it("streams deltas and usage from a chat completions stream", async () => {
    const sse = [
      { choices: [{ delta: { content: "Hel" } }] },
      { choices: [{ delta: { content: "lo" } }] },
      { choices: [], usage: { prompt_tokens: 7, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } } },
    ]
      .map((j) => `data: ${JSON.stringify(j)}\n\n`)
      .join("") + "data: [DONE]\n\n";
    const fetchMock = vi.fn(async () => new Response(sse, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const p = new OpenAICompatibleProvider("openai", { baseUrl: "https://example.test/v1", apiKey: () => "sk-test", envVar: "OPENAI_API_KEY" });
    let text = "";
    let usage;
    for await (const ev of p.stream({ model, messages: [{ role: "user", content: "hi" }], maxOutputTokens: 50 })) {
      if (ev.type === "delta") text += ev.text;
      else if (ev.type === "usage") usage = ev.usage;
    }
    expect(text).toBe("Hello");
    expect(usage).toEqual({ inputTokens: 7, outputTokens: 2, estimated: false, cachedInputTokens: 4 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://example.test/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    const sent = JSON.parse(init.body as string);
    expect(sent).toMatchObject({ model: "gpt-5.6-luna", stream: true, max_completion_tokens: 50, stream_options: { include_usage: true } });
  });

  it("explains provider errors without exposing the provider's raw text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "bad model" } }), { status: 404 })));
    const p = new OpenAICompatibleProvider("huggingface", { baseUrl: "https://x.test/v1", apiKey: () => "hf", envVar: "HUGGINGFACE_API_KEY" });
    const err = await p.generate({ model, messages: [{ role: "user", content: "hi" }] }).then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/isn't available from its provider right now/);
    expect(err?.message).not.toMatch(/bad model/);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "Incorrect API key provided: sk-proj-abcd****wxyz" } }), { status: 401 })));
    const auth = await p.generate({ model, messages: [{ role: "user", content: "hi" }] }).then(() => null, (e: Error) => e);
    expect(auth?.message).not.toMatch(/sk-|API key provided/);
    expect(auth?.message).toMatch(/configuration problem/);
  });

  it("reports a missing key clearly", async () => {
    const p = new OpenAICompatibleProvider("openai", { baseUrl: "https://x.test/v1", apiKey: () => undefined, envVar: "OPENAI_API_KEY" });
    expect(p.isConfigured()).toBe(false);
    await expect(p.generate({ model, messages: [] })).rejects.toThrow(/OPENAI_API_KEY/);
  });
});

describe("demo provider", () => {
  it("labels output as simulated", async () => {
    const r = await demoProvider.generate({ model: DEFAULT_MODELS.at(-1)!, messages: [{ role: "user", content: "What is RAG?" }] });
    expect(r.simulated).toBe(true);
    expect(r.text.startsWith(DEMO_NOTICE)).toBe(true);
    expect(r.usage.estimated).toBe(true);
  });
  it("streams the same text losslessly", async () => {
    const params = { model: DEFAULT_MODELS.at(-1)!, messages: [{ role: "user" as const, content: "Explain transformers" }] };
    let s = "";
    for await (const ev of demoProvider.stream(params)) if (ev.type === "delta") s += ev.text;
    expect(s).toBe((await demoProvider.generate(params)).text);
  });
});

describe("history trimming", () => {
  it("keeps the most recent turns within budget and starts on a user turn", async () => {
    const { trimHistory } = await import("@/lib/ai/trim");
    const h = Array.from({ length: 30 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", content: `m${i}` }));
    const t = trimHistory(h, 5);
    expect(t[0]!.role).toBe("user");
    expect(t.at(-1)!.content).toBe("m29");
    expect(t.length).toBeLessThanOrEqual(5);
    const big = [{ role: "user" as const, content: "a".repeat(30_000) }, { role: "assistant" as const, content: "ok" }, { role: "user" as const, content: "next" }];
    expect(trimHistory(big, 20, 24_000).map((m) => m.content)).toEqual(["next"]);
  });
});

describe("Anthropic provider", () => {
  it("moves system prompts to the top level and starts on a user turn", async () => {
    const { toAnthropicMessages } = await import("@/lib/ai/providers/anthropic");
    const r = toAnthropicMessages([
      { role: "system", content: "Be brief." },
      { role: "assistant", content: "orphan" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "again" },
    ]);
    expect(r.system).toBe("Be brief.");
    expect(r.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });
  it("is unavailable without ANTHROPIC_API_KEY", async () => {
    const { AnthropicProvider } = await import("@/lib/ai/providers/anthropic");
    const p = new AnthropicProvider(() => undefined);
    expect(p.isConfigured()).toBe(false);
    expect(p.missingConfig()).toContain("ANTHROPIC_API_KEY");
  });
});
