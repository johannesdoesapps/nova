/**
 * Time limits outside the agent loop: the browser check fits the time its
 * request has left, and chat only switches to a backup model while there is
 * time for it to answer before the route is stopped (60 s).
 */
import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/http";
import { DEFAULT_MODELS } from "@/lib/ai/registry";
import type { AIProvider, ModelWithStatus, StreamEvent } from "@/lib/ai/types";

describe("the browser check's time", () => {
  const fakeBox = () => {
    const ran: string[] = [];
    const box = {
      writeFiles: async () => {},
      runCommand: async ({ args }: { args: string[] }) => {
        ran.push(args[1]!);
        return { stdout: async () => '{"url":"/","viewports":[],"links":[],"error":null}' };
      },
    };
    return { box: box as never, ran };
  };

  it("doesn't start when the step has too little time left, and says so", async () => {
    const { runPreviewCheck } = await import("@/lib/code/preview");
    const { box, ran } = fakeBox();
    const r = await runPreviewCheck(box, "/", undefined, undefined, { budgetMs: 25_000 });
    expect(ran).toEqual([]);
    expect(r.error).toContain("wasn't enough time left");
  });

  it("splits the time left between the browser's setup and the check", async () => {
    const { runPreviewCheck } = await import("@/lib/code/preview");
    const full = fakeBox();
    await runPreviewCheck(full.box, "/");
    expect(full.ran[0]).toContain("timeout 150 npm i");
    expect(full.ran[0]).toContain("timeout 90 node");
    const short = fakeBox();
    await runPreviewCheck(short.box, "/", undefined, undefined, { budgetMs: 100_000 });
    // 100 s: 90 s for the check, the 10 s left for setup — together never more than the budget.
    expect(short.ran[0]).toContain("timeout 10 npm i");
    expect(short.ran[0]).toContain("timeout 90 node");
    const tight = fakeBox();
    await runPreviewCheck(tight.box, "/", undefined, undefined, { budgetMs: 40_000 });
    expect(tight.ran[0]).toContain("timeout 30 node");
    expect(tight.ran[0]).toContain("timeout 10 npm i");
  });
});

describe("chat's time", () => {
  it("gives a model call at most 50 s, and only what is left of the request's time", async () => {
    const { modelBudget } = await import("@/lib/ai/fallback");
    const t = 1_000_000;
    expect(modelBudget(t + 55_000, t)).toBe(50_000);
    expect(modelBudget(t + 55_000, t + 40_000)).toBe(15_000);
    expect(modelBudget(t + 55_000, t + 60_000)).toBe(1_000);
  });

  it("doesn't switch to a backup model when there's no time left for it to answer", async () => {
    const { streamWithFallback } = await import("@/lib/ai/fallback");
    const model = (id: string, provider: ModelWithStatus["provider"]): ModelWithStatus => ({ ...DEFAULT_MODELS[0]!, id, provider, displayName: id, available: true });
    const asked: string[] = [];
    const provider = (id: string): AIProvider => ({
      id: "openai",
      isConfigured: () => true,
      missingConfig: () => null,
      generate: async () => ({ text: "", usage: { inputTokens: 0, outputTokens: 0, estimated: true }, simulated: false }),
      async *stream(): AsyncGenerator<StreamEvent> {
        asked.push(id);
        if (id === "anthropic") throw new ApiError("upstream_error", "timed out");
        yield { type: "delta", text: "hi" };
      },
    });
    const collect = async (canFallBack: () => boolean) => {
      const out: string[] = [];
      try {
        for await (const ev of streamWithFallback(model("a", "anthropic"), [model("b", "openai")], { messages: [] }, () => new AbortController().signal, { canFallBack }, provider)) out.push(ev.type);
      } catch (e) {
        out.push(`error:${(e as Error).message}`);
      }
      return out;
    };
    expect(await collect(() => false)).toEqual(["error:timed out"]);
    expect(asked).toEqual(["anthropic"]);
    expect(await collect(() => true)).toEqual(["fallback", "delta"]);
  });
});
