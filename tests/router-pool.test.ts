/** The model menu names each Smart Router mode's models; the router must only ever pick from them. */
import { describe, expect, it } from "vitest";
import { ROUTER_MODES } from "@/lib/ai/platform";
import { DEFAULT_MODELS } from "@/lib/ai/registry";
import { autoRoute, routerPool } from "@/lib/ai/router";
import type { ModelWithStatus } from "@/lib/ai/types";

const models = DEFAULT_MODELS.map((m) => ({ ...m, available: m.provider === "anthropic" || m.provider === "openai" })) as ModelWithStatus[];
const names = (ms: ModelWithStatus[]) => ms.filter((m) => m.available).map((m) => m.displayName);
const PROMPTS = ["hi", "Summarise this article in three bullets", "Prove that the square root of 2 is irrational", "Fix this TypeError in my React component", "Compare the economic effects of tariffs, with sources"];

describe("Smart Router pools", () => {
  it("narrows each mode to suitable models", () => {
    expect(names(routerPool(models, "quick"))).toEqual(["Claude Haiku 5.5", "GPT-5 mini"]);
    expect(names(routerPool(models, "deep"))).toEqual(["Claude Sonnet 5.5", "GPT-5"]);
    expect(names(routerPool(models, "balanced"))).toHaveLength(4);
  });

  it("only ever routes to a model named for that mode", () => {
    for (const mode of ROUTER_MODES) {
      const pool = new Set(routerPool(models, mode.id).map((m) => m.id));
      for (const p of PROMPTS) {
        const r = autoRoute(models, p, { routerMode: mode.id });
        expect(r && pool.has(r.model.id), `${mode.id}: ${p}`).toBe(true);
      }
    }
  });

  it("never names models that aren't configured", () => {
    for (const mode of ROUTER_MODES) for (const m of routerPool(models, mode.id).filter((x) => x.available)) expect(["anthropic", "openai"]).toContain(m.provider);
  });
});
