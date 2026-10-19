/**
 * Auto routing and the Coding mode with the real model registry (providers
 * marked configured; no model is called).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_MODELS, withStatus } from "@/lib/ai/registry";
import { autoRoute, classifyTask, recommendModel } from "@/lib/ai/router";
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

  it("uses a stronger model only for demanding requests", () => {
    const r = autoRoute(models, "Evaluate the trade-offs of event sourcing versus CRUD for our billing system architecture, step by step")!;
    expect(r.model.capabilities).toContain("reasoning");
    expect(r.complexity).toBe("complex");
  });

  it("with the Coding chip on, a non-code question still gets a low-cost model (the reported bug)", () => {
    const r = autoRoute(models, "whats the time in new york", { mode: "coding" })!;
    expect(lowCost(r.model)).toBe(true);
    expect(r.model.capabilities).toContain("coding");
    expect(r.reason).toMatch(/Coding mode/);
  });

  it("with the Coding chip on, picks coding models: low-cost for simple code, stronger for hard code", () => {
    const simple = autoRoute(models, "How do I reverse an array in JavaScript?", { mode: "coding" })!;
    expect(simple.model.capabilities).toContain("coding");
    expect(lowCost(simple.model)).toBe(true);
    const hard = autoRoute(models, "Find the race condition in this Go worker pool and refactor the whole scheduler for concurrency safety", { mode: "coding" })!;
    expect(hard.model.capabilities).toEqual(expect.arrayContaining(["coding", "reasoning"]));
  });

  it("keeps to low-cost models when the allowance must be saved, even for hard requests", () => {
    const r = autoRoute(models, "Prove this step by step and compare the trade-offs in depth", { preferLowCost: true })!;
    expect(lowCost(r.model)).toBe(true);
    expect(r.reason).toMatch(/saving your allowance/);
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

  it("refuses an unknown model instead of silently switching", async () => {
    const { resolveModelChoice } = await import("@/lib/ai");
    await expect(resolveModelChoice("anthropic:nope", { prompt: "hi" })).rejects.toThrow(/isn't an available model/);
  });
});
