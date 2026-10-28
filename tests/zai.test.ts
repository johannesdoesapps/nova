/**
 * Z.ai (GLM) provider: registration and plan tiers, request shape against Z.ai's OpenAI-compatible endpoint,
 * streaming, usage, and plain-language errors — with fetch stubbed, so no real API calls.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { recipientsFor } from "@/lib/ai/disclosure";
import { OpenAICompatibleProvider } from "@/lib/ai/providers/openai-compatible";
import { DEFAULT_MODELS, withStatus } from "@/lib/ai/registry";
import { redactIdentity } from "@/lib/intel/blinding";
import { modelTier } from "@/lib/plans";

const glm = DEFAULT_MODELS.find((m) => m.id === "zai:glm-5.3")!;
const flash = DEFAULT_MODELS.find((m) => m.id === "zai:glm-5.3-flash")!;
const sseOf = (chunks: object[]) => chunks.map((j) => `data: ${JSON.stringify(j)}\n\n`).join("") + "data: [DONE]\n\n";
const zai = (key: string | null = "zai-test-key") => new OpenAICompatibleProvider("zai", { baseUrl: "https://api.z.ai/api/paas/v4", apiKey: () => key ?? undefined, envVar: "ZAI_API_KEY" });
const none = { anthropic: false, openai: false, google: false, xai: false, deepseek: false, zai: false, huggingface: false, demo: true };

afterEach(() => vi.unstubAllGlobals());

describe("Z.ai (GLM) provider", () => {
  it("offers GLM-5.3 and GLM-5.3 Flash only when ZAI_API_KEY is set", () => {
    expect(DEFAULT_MODELS.filter((m) => m.provider === "zai").map((m) => m.providerModelId)).toEqual(["glm-5.3", "glm-5.3-flash"]);
    expect(withStatus(DEFAULT_MODELS, { ...none, openai: true }).find((m) => m.id === glm.id)).toMatchObject({ available: false, unavailableReason: "Set ZAI_API_KEY to enable" });
    const on = withStatus(DEFAULT_MODELS, { ...none, zai: true });
    expect(on.find((m) => m.id === glm.id)!.available).toBe(true);
    expect(on.some((m) => m.provider === "demo")).toBe(false);
  });

  it("puts the flagship on paid plans and Flash on every plan, with no unverified prices", () => {
    expect(modelTier(glm)).toBe("advanced");
    expect(modelTier(flash)).toBe("standard");
    for (const m of [glm, flash]) expect([m.inputPrice, m.outputPrice]).toEqual([null, null]);
  });

  it("tells the user their message goes to Z.ai before it's sent", () => {
    expect(recipientsFor([{ ...glm, available: true, locked: false }], glm.id).names).toEqual(["Z.ai (GLM)"]);
  });

  it("streams from Z.ai's chat completions endpoint and reports the served model and usage", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        sseOf([
          { model: "glm-5.3", choices: [{ delta: { content: "你好" } }] },
          { choices: [{ delta: { content: ", hello!" } }] },
          { choices: [], usage: { prompt_tokens: 9, completion_tokens: 4 } },
        ]),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    let text = "";
    let usage;
    let served;
    for await (const ev of zai().stream({ model: glm, messages: [{ role: "user", content: "你好" }], maxOutputTokens: 100 })) {
      if (ev.type === "delta") text += ev.text;
      else if (ev.type === "usage") usage = ev.usage;
      else if (ev.type === "served") served = ev.servedModel;
    }
    expect(text).toBe("你好, hello!");
    expect(served).toBe("glm-5.3");
    expect(usage).toMatchObject({ inputTokens: 9, outputTokens: 4, estimated: false });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.z.ai/api/paas/v4/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer zai-test-key");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ model: "glm-5.3", stream: true, max_tokens: 100, messages: [{ role: "user", content: "你好" }] });
    // OpenAI's stream_options extension isn't sent to providers not known to accept it.
    expect(body.stream_options).toBeUndefined();
  });

  it("explains a missing or rejected key and rate limits in plain language", async () => {
    await expect(zai(null).generate({ model: glm, messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(/ZAI_API_KEY/);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "Authorization Token Missing" } }), { status: 401 })));
    await expect(zai().generate({ model: glm, messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ code: "not_configured" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "Rate limit" } }), { status: 429 })));
    await expect(zai().generate({ model: glm, messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("hides GLM's name in blind comparisons, like every other model's", () => {
    expect(redactIdentity("As GLM-5.3 (made by Zhipu), I think… ChatGLM agrees.").text).not.toMatch(/glm|zhipu/i);
  });
});
