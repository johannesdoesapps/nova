/**
 * Jarvis Mode's server side: the system prompt, vetting the model's proposals, the JSON fallback, and the
 * /api/jarvis/turn and /api/jarvis/look routes (with the model and usage layer mocked).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanSpeech, parseJsonReply, systemPrompt, turnRequest, vetCalls, MAX_CALLS } from "@/lib/jarvis/planner";
import { offeredTools } from "@/lib/jarvis/tools";

const env = vi.hoisted(() => ({
  provider: "anthropic",
  capabilities: ["chat", "vision"] as string[],
  toolTurns: [] as Record<string, unknown>[],
  streamed: [] as unknown[],
  recorded: [] as Record<string, unknown>[],
  enforced: [] as Record<string, unknown>[],
  reply: { text: "I'll open it.", calls: [] as { id: string; name: string; args: Record<string, unknown> | null }[] },
  streamText: "",
}));
vi.mock("@/lib/auth", () => ({ requireUserIfConfigured: async () => ({ mode: "authenticated", user: { id: "u1" }, supabase: {} }) }));
vi.mock("@/lib/usage", () => ({
  planLimits: async () => ({ maxOutputTokens: 8000, tiers: ["standard"] }),
  shouldSaveAllowance: async () => false,
  enforceLimits: async (_r: unknown, _a: unknown, _c: unknown, _m: unknown, opts: Record<string, unknown>) => {
    env.enforced.push(opts);
    return {};
  },
  recordRunLater: (_a: unknown, run: Record<string, unknown>) => env.recorded.push(run),
}));
vi.mock("@/lib/ai", () => ({
  withTimeout: (_ms: number, s?: AbortSignal) => s ?? new AbortController().signal,
  resolveModelChoice: async (requested: string) => ({
    model: { id: "m1", displayName: "Model One", provider: env.provider, inputPrice: 1, outputPrice: 2, capabilities: env.capabilities },
    routing: { auto: true, mode: requested, reason: "test" },
  }),
  getProvider: () => ({
    async toolTurn(p: Record<string, unknown>) {
      env.toolTurns.push(p);
      return { ...env.reply, usage: { inputTokens: 100, outputTokens: 20, estimated: false }, servedModel: "m1", stop: "end_turn" };
    },
    async *stream(req: unknown) {
      env.streamed.push(req);
      yield { type: "delta", text: env.streamText };
      yield { type: "usage", usage: { inputTokens: 50, outputTokens: 10, estimated: false } };
    },
  }),
}));

const post = async (path: string, body: unknown) => {
  const { POST } = await import(path === "turn" ? "@/app/api/jarvis/turn/route" : "@/app/api/jarvis/look/route");
  return POST(new Request(`https://x.test/api/jarvis/${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
};

beforeEach(() => {
  env.provider = "anthropic";
  env.capabilities = ["chat", "vision"];
  env.toolTurns.length = 0;
  env.streamed.length = 0;
  env.recorded.length = 0;
  env.enforced.length = 0;
  env.reply = { text: "I'll open it.", calls: [] };
});

describe("planner", () => {
  it("tells the model what it can reach, its limits and the user's autonomy", () => {
    const off = systemPrompt(turnRequest.parse({ message: "x" }), offeredTools(false), false);
    expect(off).toMatch(/Desktop Agent is not connected/);
    expect(off).toMatch(/autonomy setting is 3 \(Supervised\)/);
    expect(off).toMatch(/cannot delete files/);
    expect(off).toMatch(/<untrusted>/);
    expect(off).not.toMatch(/Reply with only a JSON object/);
    const on = systemPrompt(turnRequest.parse({ message: "x", desktop: { connected: true, platform: "darwin", folders: ["~/Downloads"] }, autonomy: 1 }), offeredTools(true), true);
    expect(on).toMatch(/connected on macOS\. It can reach only these folders: ~\/Downloads/);
    expect(on).toMatch(/Observe/);
    expect(on).toMatch(/- organize_folder: /);
  });

  it("keeps only valid, offered, distinct calls, up to the limit", () => {
    const offered = offeredTools(false);
    const raw = [
      { name: "open_url", args: { url: "https://a.com" } },
      { name: "open_url", args: { url: "https://a.com" } },
      { name: "move_file", args: { from: "a", to: "b" } },
      { name: "delete_everything", args: {} },
      ...Array.from({ length: 10 }, (_, i) => ({ name: "open_url", args: { url: `https://b${i}.com` } })),
    ];
    const v = vetCalls(raw, offered);
    expect(v.calls).toHaveLength(MAX_CALLS);
    expect(v.calls[0]).toEqual({ tool: "open_url", args: { url: "https://a.com" } });
    expect(v.rejected.map((r) => r.error)).toEqual(["That tool isn't available right now.", "Unknown tool.", "Only 8 actions per request.", "Only 8 actions per request.", "Only 8 actions per request."]);
  });

  it("reads JSON-format replies, and treats anything else as speech", () => {
    expect(parseJsonReply('Sure! {"say":"Opening it.","calls":[{"tool":"open_url","args":{"url":"https://a.com"}}]}')).toEqual({ say: "Opening it.", raw: [{ name: "open_url", args: { url: "https://a.com" } }] });
    expect(parseJsonReply("Just an answer {not json}")).toEqual({ say: "Just an answer {not json}", raw: [] });
    expect(cleanSpeech("**Done.** Here's `x`\n\n\n\n# Next")).toBe("Done. Here's x\n\n Next");
  });
});

describe("POST /api/jarvis/turn", () => {
  it("returns what to say and the vetted calls, and meters the turn", async () => {
    env.reply = {
      text: "I'll research that and open Code for the site.",
      calls: [
        { id: "1", name: "research", args: { question: "Compare five AI coding tools" } },
        { id: "2", name: "organize_folder", args: { path: "~/Downloads" } },
        { id: "3", name: "build_website", args: { description: "A site for my bakery" } },
      ],
    };
    const res = await post("turn", { message: "Research AI coding tools and build my bakery site", history: [{ role: "assistant", text: "Hi" }, { role: "user", text: "Hello" }] });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.say).toBe("I'll research that and open Code for the site.");
    expect(j.calls).toEqual([
      { tool: "research", args: { question: "Compare five AI coding tools", depth: "standard" } },
      { tool: "build_website", args: { description: "A site for my bakery" } },
    ]);
    expect(j.rejected).toEqual([{ tool: "organize_folder", error: "That tool isn't available right now." }]);
    const turn = env.toolTurns[0] as { messages: { role: string; text: string }[]; tools: { name: string }[] };
    expect(turn.messages.map((m) => m.role)).toEqual(["user", "user"]);
    expect(turn.tools.map((t) => t.name)).not.toContain("organize_folder");
    expect(env.enforced[0]).toMatchObject({ purpose: "jarvis" });
    expect(env.recorded[0]).toMatchObject({ purpose: "jarvis", status: "success", tools: ["research", "build_website"] });
  });

  it("offers desktop tools when the agent is connected", async () => {
    env.reply = { text: "I'll sort Downloads by type.", calls: [{ id: "1", name: "organize_folder", args: { path: "~/Downloads" } }] };
    const j = await (await post("turn", { message: "Organise my downloads", desktop: { connected: true, platform: "win32", folders: ["~/Downloads"] }, autonomy: 2 })).json();
    expect(j.calls).toEqual([{ tool: "organize_folder", args: { path: "~/Downloads" } }]);
  });

  it("falls back to the JSON format for models without native tool calling", async () => {
    env.provider = "google";
    env.streamText = '{"say":"Opening the docs.","calls":[{"tool":"open_url","args":{"url":"https://nextjs.org/docs"}}]}';
    const j = await (await post("turn", { message: "Open the Next.js docs" })).json();
    expect(j).toMatchObject({ say: "Opening the docs.", calls: [{ tool: "open_url", args: { url: "https://nextjs.org/docs" } }] });
    expect(env.toolTurns).toHaveLength(0);
  });

  it("answers in words only, with no tools, when asked to", async () => {
    env.streamText = "That paragraph says the meeting moved to Friday.";
    const j = await (await post("turn", { message: "Summarise what I copied", answerOnly: true, desktop: { connected: true, folders: [] } })).json();
    expect(j).toMatchObject({ say: "That paragraph says the meeting moved to Friday.", calls: [] });
    expect(env.toolTurns).toHaveLength(0);
    const sys = (env.streamed[0] as { messages: { role: string; content: string }[] }).messages[0]!.content;
    expect(sys).toMatch(/Tools available now: none/);
    expect(sys).not.toMatch(/Reply with only a JSON object/);
  });

  it("rejects bad requests", async () => {
    expect((await post("turn", { message: "" })).status).toBe(400);
    expect((await post("turn", { message: "x", autonomy: 5 })).status).toBe(400);
    expect((await post("turn", { message: "x", history: Array.from({ length: 17 }, () => ({ role: "user", text: "a" })) })).status).toBe(400);
  });
});

describe("POST /api/jarvis/look", () => {
  const image = { mediaType: "image/png", data: "A".repeat(200) };

  it("answers about the shared picture and doesn't keep it", async () => {
    env.reply = { text: "The installer failed: “EACCES: permission denied”.", calls: [] };
    const j = await (await post("look", { question: "Why did this fail?", image })).json();
    expect(j.answer).toBe("The installer failed: “EACCES: permission denied”.");
    const turn = env.toolTurns[0] as { messages: { images: unknown[] }[] };
    expect(turn.messages[0]!.images).toEqual([image]);
    expect(JSON.stringify(env.recorded)).not.toContain("AAAA");
  });

  it("asks for a better view when the picture doesn't show enough", async () => {
    env.reply = { text: "", calls: [{ id: "1", name: "ask_for_better_view", args: { reason: "the error dialog is cut off" } }] };
    const j = await (await post("look", { question: "What does the error say?", image })).json();
    expect(j.needsBetterView).toBe(true);
    expect(j.answer).toMatch(/the error dialog is cut off/);
  });

  it("needs a model that reads images, and a real image", async () => {
    env.capabilities = ["chat"];
    expect((await post("look", { question: "What's this?", image })).status).toBe(503);
    env.capabilities = ["chat", "vision"];
    expect((await post("look", { question: "What's this?", image: { mediaType: "image/gif", data: "A".repeat(200) } })).status).toBe(400);
    expect((await post("look", { question: "What's this?", image: { mediaType: "image/png", data: "<script>".repeat(30) } })).status).toBe(400);
  });
});
