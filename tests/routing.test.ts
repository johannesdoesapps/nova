/**
 * Auto routing and the Coding mode with the real model registry (providers
 * marked configured; no model is called).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_MODELS, withStatus } from "@/lib/ai/registry";
import { autoRoute, blendedPrice, cheapestModel, classifyTask, recommendModel } from "@/lib/ai/router";
import type { ModelWithStatus } from "@/lib/ai/types";

const configured = { anthropic: true, openai: true, google: false, xai: false, deepseek: false, huggingface: false, demo: true };
const models = withStatus(DEFAULT_MODELS, configured) as ModelWithStatus[];
const lowCost = (m: ModelWithStatus | null | undefined) => !!m?.capabilities.includes("low-cost");

describe("Auto routing", () => {
  it("answers everyday questions with a low-cost model", () => {
    for (const q of ["whats the time in new york", "What is the capital of Peru?", "Why is the sky blue?", "Give me a recipe for pancakes"]) {
      const r = autoRoute(models, q)!;
      expect(lowCost(r.model), q).toBe(true);
      expect(r.complexity).toBe("simple");
    }
  });

  it("uses the lowest-cost model for everyday requests", () => {
    for (const p of ["hi", "What is the capital of France?", "Summarise this article in three bullets", "Write a short thank-you email to my landlord"]) {
      expect(autoRoute(models, p)!.model.id, p).toBe("anthropic:claude-haiku-5-5");
    }
  });

  it("escalates hard coding and reasoning tasks to the lowest-cost reasoning model, and says why", () => {
    const hard = autoRoute(models, "Evaluate the trade-offs of event sourcing versus CRUD for our billing system architecture, step by step")!;
    expect(hard.model.id).toBe("anthropic:claude-sonnet-5-5");
    expect(hard.reason).toMatch(/lowest-cost reasoning model.*harder/);
    const code = autoRoute(models, "Find the race condition in this Go worker pool and fix the deadlock")!;
    expect(code.model.capabilities).toContain("reasoning");
    // A plan without reasoning models (Free) stays on the cheapest model.
    const free = models.filter((m) => m.capabilities.includes("low-cost"));
    expect(autoRoute(free, "Prove that there are infinitely many primes, step by step")!.model.id).toBe("anthropic:claude-haiku-5-5");
  });

  it("doesn't escalate when the allowance is running low", () => {
    expect(autoRoute(models, "Design a system architecture for a payments platform, step by step", { preferLowCost: true })!.model.id).toBe("anthropic:claude-haiku-5-5");
  });

  it("keeps long documents on a model whose context fits, without escalating a summary", () => {
    const long = "word ".repeat(30_000);
    const r = autoRoute(models, `Summarise this: ${long}`)!;
    expect(r.model.contextWindow!).toBeGreaterThanOrEqual(Math.ceil((long.length / 4) * 1.3));
    expect(r.model.capabilities).toContain("low-cost");
  });

  it("with the Coding chip on, a non-code question still gets a low-cost model (the reported bug)", () => {
    const r = autoRoute(models, "whats the time in new york", { mode: "coding" })!;
    expect(lowCost(r.model)).toBe(true);
    expect(r.model.capabilities).toContain("coding");
  });

  it("with the Coding chip on, picks the lowest-cost coding-capable model", () => {
    const pricier = models.map((m) => (m.id === "anthropic:claude-haiku-5-5" ? { ...m, capabilities: m.capabilities.filter((c) => c !== "coding") } : m));
    const r = autoRoute(pricier, "Fix this TypeError in my React component", { mode: "coding" })!;
    expect(r.model.id).toBe("openai:gpt-5.6-luna");
    expect(r.reason).toMatch(/for coding/);
  });

  it("follows current prices: a price change changes the default", () => {
    const repriced = models.map((m) => (m.id === "openai:gpt-5.6-luna" ? { ...m, inputPrice: 0.01, outputPrice: 0.05 } : m));
    expect(autoRoute(repriced, "hi")!.model.id).toBe("openai:gpt-5.6-luna");
    expect(cheapestModel(repriced)!.id).toBe("openai:gpt-5.6-luna");
  });

  it("picks a model whose context window fits a long prompt, cheapest first", () => {
    const small = models.map((m) => (m.id === "anthropic:claude-haiku-5-5" ? { ...m, contextWindow: 8000 } : m));
    const r = autoRoute(small, "word ".repeat(30_000))!;
    expect(r.model.contextWindow).toBeGreaterThan(30_000);
    expect(r.reason).toMatch(/large enough context window/);
  });

  it("ranks by expected price, with unpriced models last", () => {
    expect(blendedPrice({ inputPrice: 0.1, outputPrice: 0.5 })).toBeCloseTo(0.2);
    expect(blendedPrice({ inputPrice: null, outputPrice: 0.5 })).toBeNull();
    const unpricedCheapLooking = models.map((m) => (m.id === "anthropic:claude-haiku-5-5" ? { ...m, inputPrice: null } : m));
    expect(cheapestModel(unpricedCheapLooking)!.id).toBe("openai:gpt-5.6-luna");
  });

  it("respects the Deep and Coding Smart Router modes", () => {
    expect(autoRoute(models, "hi", { routerMode: "deep" })!.model.capabilities).toContain("reasoning");
    expect(autoRoute(models, "hi", { routerMode: "coding" })!.model.capabilities).toContain("coding");
  });

  it("never picks a model without a required capability", () => {
    const textOnly = models.map((m) => ({ ...m, capabilities: m.capabilities.filter((c) => c !== "vision") }));
    expect(recommendModel(textOnly, "describe this image", { needs: ["vision"] }).model).toBeNull();
    expect(autoRoute(textOnly, "describe this image", { needs: ["vision"] })).toBeNull();
  });

  it("classifies without calling a model", () => {
    expect(classifyTask("fix this TypeError").kind).toBe("coding");
    expect(classifyTask("x".repeat(10_000)).complexity).toBe("complex");
  });
});

describe("explicit model choice", () => {
  const saved = { ...process.env };
  beforeAll(() => {
    for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "NOVA_MODELS"]) delete process.env[k];
    process.env.ANTHROPIC_API_KEY = "test-key";
  });
  afterAll(() => {
    process.env = saved;
  });

  it("uses the model the user picked, whatever the message", async () => {
    const { resolveModelChoice } = await import("@/lib/ai");
    const c = await resolveModelChoice("anthropic:claude-sonnet-5-5", { prompt: "hi", mode: "coding", preferLowCost: true });
    expect(c.model.id).toBe("anthropic:claude-sonnet-5-5");
    expect(c.routing).toBeNull();
    const auto = await resolveModelChoice("auto", { prompt: "hi" });
    expect(auto.model.id).toBe("anthropic:claude-haiku-5-5");
    expect(auto.routing?.reason).toMatch(/Auto chose Claude Haiku 5\.5/);
  });

  it("Auto deep mode only chooses models the user's plan includes", async () => {
    const { resolveModelChoice } = await import("@/lib/ai");
    const pro = await resolveModelChoice("auto:deep", { prompt: "Prove that there are infinitely many primes, step by step", tiers: ["standard", "advanced"] });
    expect(pro.model.tier ?? "advanced").not.toBe("premium");
    const free = await resolveModelChoice("auto:deep", { prompt: "Prove that there are infinitely many primes", tiers: ["standard"] });
    expect(free.model.id).toBe("anthropic:claude-haiku-5-5");
  });

  it("refuses an unknown model instead of silently switching", async () => {
    const { resolveModelChoice } = await import("@/lib/ai");
    await expect(resolveModelChoice("anthropic:nope", { prompt: "hi" })).rejects.toThrow(/isn't an available model/);
  });
});
