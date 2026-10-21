import { describe, expect, it } from "vitest";
import { recipientsFor } from "@/lib/ai/disclosure";

const m = (id: string, provider: string, extra: Partial<{ available: boolean; locked: boolean }> = {}) => ({ id, provider, available: true, locked: false, ...extra }) as never;
const models = [m("anthropic:haiku", "anthropic"), m("openai:luna", "openai"), m("openai:sol", "openai", { locked: true }), m("google:g", "google", { available: false })];

describe("who receives a message", () => {
  it("a chosen model: its provider only", () => {
    expect(recipientsFor(models, "openai:luna")).toEqual({ names: ["OpenAI (GPT)"], simulated: false, auto: false });
  });
  it("Auto: every provider among the models it may use (available, in the plan)", () => {
    expect(recipientsFor(models, "auto")).toEqual({ names: ["Anthropic (Claude)", "OpenAI (GPT)"], simulated: false, auto: true });
    expect(recipientsFor([m("openai:sol", "openai", { locked: true }), m("anthropic:haiku", "anthropic")], "auto:coding").names).toEqual(["Anthropic (Claude)"]);
  });
  it("only the demo: nothing leaves Orbis", () => {
    expect(recipientsFor([m("demo:x", "demo")], "auto")).toEqual({ names: [], simulated: true, auto: true });
  });
});
