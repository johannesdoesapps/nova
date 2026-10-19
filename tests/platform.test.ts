/**
 * Multi-model platform: Auto routing, agent model defaults, picker categories,
 * platform settings, safe fallback and the admin/agent API surface.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { inCategory, modelTags, priceLabel, recommendedIds } from "@/lib/ai/catalog";
import { DEFAULT_PLATFORM_SETTINGS, parsePlatformSettings } from "@/lib/ai/platform";
import { DEFAULT_MODELS, withStatus } from "@/lib/ai/registry";
import { autoRoute, pickForCapability } from "@/lib/ai/router";
import type { AIProvider, ModelWithStatus, StreamEvent } from "@/lib/ai/types";
import { ApiError } from "@/lib/http";

const KEYS = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "DEEPSEEK_API_KEY", "HUGGINGFACE_API_KEY", "NOVA_MODELS"];
beforeAll(() => {
  for (const k of KEYS) delete process.env[k];
});

const configured = (p: Partial<Record<string, boolean>>) =>
  withStatus(DEFAULT_MODELS, { anthropic: false, openai: false, google: false, deepseek: false, huggingface: false, demo: true, ...p } as never);

describe("Auto mode routing", () => {
  const models = configured({ anthropic: true, openai: true });

  it("uses the lowest-cost available model for every kind of request, and says so", () => {
    for (const q of ["What's a good name for a cat?", "Evaluate the trade-offs of raising prices for our SaaS"]) {
      const r = autoRoute(models, q)!;
      expect(r.model.id).toBe("anthropic:claude-haiku-5-5");
      expect(r.reason).toMatch(/lowest-cost available model \(\$0\.1 in \/ \$0\.5 out per 1M tokens\)/);
    }
    // The Deep mode the user picks still uses a reasoning model.
    expect(autoRoute(models, "Evaluate the trade-offs", { routerMode: "deep" })!.model.capabilities).toContain("reasoning");
  });

  it("routes writing requests to a writing model and explains the choice", () => {
    const r = autoRoute(models, "Draft a polite email to my landlord about the heating")!;
    expect(r.task).toBe("writing");
    expect(r.model.capabilities).toContain("writing");
  });

  it("keeps a chosen Smart Router mode to low-cost models when the allowance is nearly used", () => {
    const r = autoRoute(models, "Evaluate the trade-offs of raising prices", { routerMode: "quick", preferLowCost: true })!;
    expect(r.model.capabilities).toContain("low-cost");
    expect(r.reason).toContain("saving your allowance");
  });

  it("never picks an unconfigured model or one missing a required capability", () => {
    const onlyOpenAI = configured({ openai: true });
    for (let i = 0; i < 5; i++) expect(autoRoute(onlyOpenAI, ["hi", "debug this TypeError", "write an essay", "compare A and B", "summarize this"][i]!)!.model.provider).toBe("openai");
    const noVision = onlyOpenAI.map((m) => ({ ...m, capabilities: m.capabilities.filter((c) => c !== "vision") }));
    expect(autoRoute(noVision, "describe this image", { needs: ["vision"] })).toBeNull();
  });

  it("falls back to clearly labelled demo models only when nothing real is configured", () => {
    expect(autoRoute(configured({}), "hello")!.model.provider).toBe("demo");
    expect(autoRoute(configured({ openai: true }), "hello")!.model.provider).not.toBe("demo");
  });
});

describe("agent model defaults", () => {
  const models = configured({ anthropic: true, openai: true });
  it("picks by capability, not by hardcoded model names", () => {
    expect(pickForCapability(models, "reasoning")!.capabilities).toContain("reasoning");
    expect(pickForCapability(models, "coding")!.capabilities).toContain("low-cost");
    expect(pickForCapability(models, null)).toBeNull();
    expect(pickForCapability(configured({}), "reasoning")).toBeNull();
  });

  it("gives each built-in agent a capability preference, style and memory", async () => {
    const { builtinAgents } = await import("@/lib/agents/builtins");
    const all = builtinAgents();
    expect(all.find((a) => a.id === "research")!.modelPreference).toBe("reasoning");
    expect(all.find((a) => a.id === "coding")!.modelPreference).toBe("coding");
    expect(all.find((a) => a.id === "writing")!.modelPreference).toBe("writing");
    for (const a of all) {
      expect(a.modelId).toBeNull();
      expect([10, 20, 40]).toContain(a.historyLimit);
    }
  });

  it("puts the response style into the agent's system prompt", async () => {
    const { builtinAgents } = await import("@/lib/agents/builtins");
    const { buildAgentSystemPrompt } = await import("@/lib/agents/execute");
    const { capabilityStatus } = await import("@/lib/agents/capabilities");
    const general = builtinAgents().find((a) => a.id === "general")!;
    expect(buildAgentSystemPrompt({ ...general, responseStyle: "concise" }, capabilityStatus())).toMatch(/Response style: Keep answers short/);
    expect(buildAgentSystemPrompt({ ...general, responseStyle: "detailed" }, capabilityStatus())).toMatch(/Response style: Be thorough/);
  });

  it("validates custom agent conversation settings", async () => {
    const { agentInput } = await import("@/lib/agents/schema");
    const base = { name: "Tutor", instructions: "You help students understand algebra step by step." };
    expect(agentInput.parse(base)).toMatchObject({ responseStyle: "balanced", historyLimit: 20 });
    expect(agentInput.safeParse({ ...base, historyLimit: 15 }).success).toBe(false);
    expect(agentInput.safeParse({ ...base, responseStyle: "verbose" }).success).toBe(false);
  });
});

describe("model picker catalog", () => {
  const models = configured({ anthropic: true, openai: true, google: true });
  it("derives categories from capabilities and marks recommended models", () => {
    const rec = recommendedIds(models);
    expect(rec.size).toBeGreaterThan(0);
    const reasoning = models.filter((m) => m.available && inCategory(m, "reasoning", rec));
    expect(reasoning.every((m) => m.capabilities.includes("reasoning"))).toBe(true);
    expect(models.filter((m) => inCategory(m, "multimodal", rec)).every((m) => m.capabilities.includes("vision"))).toBe(true);
  });

  it("shows prices only when both are known, and never for demo models", () => {
    const haiku = models.find((m) => m.id === "anthropic:claude-haiku-5-5")!;
    expect(priceLabel(haiku)).toBe("$0.10 in / $0.50 out per 1M tokens");
    expect(priceLabel(models.find((m) => m.id === "deepseek:deepseek-flash")!)).toBeNull();
    expect(modelTags(haiku)).toContain("Fast");
  });
});

describe("platform settings", () => {
  it("defaults to Auto on, fallback off and every model enabled", () => {
    expect(DEFAULT_PLATFORM_SETTINGS).toMatchObject({ autoEnabled: true, fallbackEnabled: false, enabledModelIds: null, defaultModelId: null });
  });
  it("falls back to defaults rather than trusting malformed stored settings", () => {
    expect(parsePlatformSettings({ autoEnabled: "yes" })).toEqual(DEFAULT_PLATFORM_SETTINGS);
    expect(parsePlatformSettings({ fallbackEnabled: true, modelUnits: { "openai:gpt-5": 20 } })).toMatchObject({ fallbackEnabled: true, modelUnits: { "openai:gpt-5": 20 } });
  });
});

describe("fallback", () => {
  const model = (id: string, provider: ModelWithStatus["provider"]): ModelWithStatus => ({ ...DEFAULT_MODELS[0]!, id, provider, displayName: id, available: true });
  const provider = (behaviour: "ok" | "fail" | "fail-after-text" | "bad-request"): AIProvider => ({
    id: "openai",
    isConfigured: () => true,
    missingConfig: () => null,
    generate: async () => ({ text: "", usage: { inputTokens: 0, outputTokens: 0, estimated: true }, simulated: false }),
    async *stream(): AsyncGenerator<StreamEvent> {
      if (behaviour === "fail") throw new ApiError("upstream_error", "503 from provider");
      if (behaviour === "bad-request") throw new ApiError("bad_request", "invalid request");
      yield { type: "delta", text: "partial" };
      if (behaviour === "fail-after-text") throw new ApiError("upstream_error", "dropped");
    },
  });
  const run = async (behaviours: Record<string, Parameters<typeof provider>[0]>, chain: ModelWithStatus[]) => {
    const { streamWithFallback } = await import("@/lib/ai/fallback");
    const events: string[] = [];
    try {
      for await (const ev of streamWithFallback(chain[0]!, chain.slice(1), { messages: [] }, () => new AbortController().signal, (p) => provider(behaviours[p]!))) {
        events.push(ev.type === "fallback" ? `fallback:${ev.to.id}` : ev.type);
      }
    } catch (e) {
      events.push(`error:${(e as Error).message}`);
    }
    return events;
  };

  it("moves to the next model only when the first fails before answering", async () => {
    expect(await run({ anthropic: "fail", openai: "ok" }, [model("a", "anthropic"), model("b", "openai")])).toEqual(["fallback:b", "delta"]);
  });
  it("never switches after text has streamed, or for errors another model can't fix", async () => {
    expect(await run({ anthropic: "fail-after-text", openai: "ok" }, [model("a", "anthropic"), model("b", "openai")])).toEqual(["delta", "error:dropped"]);
    expect(await run({ anthropic: "bad-request", openai: "ok" }, [model("a", "anthropic"), model("b", "openai")])).toEqual(["error:invalid request"]);
  });
  it("does not fall back at all unless both the admin and the user allow it", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    process.env.OPENAI_API_KEY = "sk-test";
    try {
      const { fallbackChain, getModels } = await import("@/lib/ai");
      const models = await getModels(DEFAULT_PLATFORM_SETTINGS);
      const sonnet = models.find((m) => m.id === "anthropic:claude-sonnet-5-5")!;
      expect(await fallbackChain(sonnet, DEFAULT_PLATFORM_SETTINGS, true)).toEqual([]);
      expect(await fallbackChain(sonnet, { ...DEFAULT_PLATFORM_SETTINGS, fallbackEnabled: true }, false)).toEqual([]);
      const chain = await fallbackChain(sonnet, { ...DEFAULT_PLATFORM_SETTINGS, fallbackEnabled: true }, true);
      expect(chain.length).toBeGreaterThan(0);
      expect(chain.every((m) => m.id !== sonnet.id && m.capabilities.includes("reasoning") && m.available)).toBe(true);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
    }
  });
});

describe("API surface", () => {
  const post = (url: string, body: unknown) =>
    new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.7.0.1" }, body: JSON.stringify(body) });

  it("reports why Auto mode is unavailable when no provider is configured", async () => {
    const { GET } = await import("@/app/api/models/route");
    const j = await (await GET(new Request("http://localhost/api/models"))).json();
    expect(j.auto).toEqual({ enabled: false, reason: expect.stringMatching(/configured AI provider/) });
  });

  it("labels Auto-routed replies and keeps demo output marked as simulated", async () => {
    const { POST } = await import("@/app/api/chat/route");
    const text = await (await POST(post("/api/chat", { message: "Compare the pros and cons of two options", modelId: "auto" }))).text();
    const events = text.trim().split("\n").map((l) => JSON.parse(l));
    expect(events[0]).toMatchObject({ type: "meta", routing: { auto: true, reason: expect.stringContaining("Auto chose") } });
    expect(events.find((e) => e.type === "done")).toMatchObject({ simulated: true });
  });

  it("keeps admin settings and provider checks behind sign-in", async () => {
    const settings = await import("@/app/api/admin/settings/route");
    expect((await settings.GET()).status).toBe(401);
    const test = await import("@/app/api/admin/providers/test/route");
    expect((await test.POST(post("/api/admin/providers/test", { provider: "openai" }))).status).toBe(401);
  });
});
