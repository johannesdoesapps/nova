import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const env: Record<string, unknown> = {};
vi.mock("@/lib/env", () => ({ serverEnv: () => env }));

const webSearch = vi.fn(async () => ({ provider: "tavily", sources: [] }));
vi.mock("@/lib/search/web", async (orig) => ({ ...(await orig<typeof import("@/lib/search/web")>()), webSearch: (...a: unknown[]) => (webSearch as (...x: unknown[]) => unknown)(...a) }));

const recordRun = vi.fn(async () => {});
vi.mock("@/lib/usage", () => ({ recordRun: (...a: unknown[]) => (recordRun as (...x: unknown[]) => unknown)(...a) }));

const haiku = { id: "anthropic:claude-haiku-5-5", provider: "anthropic", available: true, inputPrice: 0.1, outputPrice: 0.5 };
const sonnet = { id: "anthropic:claude-sonnet-5-5", provider: "anthropic", available: true, inputPrice: 2, outputPrice: 10 };
const webResearch = vi.fn();
vi.mock("@/lib/ai", () => ({ getModels: async () => [sonnet, haiku], getProvider: () => ({ webResearch: (...a: unknown[]) => webResearch(...a) }) }));
vi.mock("@/lib/ai/settings", () => ({ getPlatformSettings: async () => ({}) }));

const signedIn = { mode: "authenticated", user: { id: "u1" } } as never;
const research = {
  segments: [
    { text: "Supabase's free plan includes two projects ", citations: [{ url: "https://supabase.com/pricing", title: "Pricing", quote: "Free: 2 active projects" }] },
    { text: "and pauses after a week.", citations: [{ url: "https://supabase.com/pricing", title: "Pricing", quote: "Paused after 1 week of inactivity" }] },
  ],
  results: [
    { url: "https://supabase.com/pricing", title: "Pricing & fees", pageAge: "2026-09-01" },
    { url: "https://blog.example.com/review", title: "A review", pageAge: null },
    { url: "javascript:alert(1)", title: "bad", pageAge: null },
  ],
  queries: ["supabase free tier"],
  searches: 1,
  usage: { inputTokens: 12000, outputTokens: 300, estimated: false },
  servedModel: "claude-haiku-5-5",
  stop: "end",
};

describe("live web search", () => {
  beforeEach(() => {
    for (const k of Object.keys(env)) delete env[k];
    webSearch.mockClear();
    recordRun.mockClear();
    webResearch.mockReset().mockResolvedValue(research);
  });

  it("uses a configured search API key first (the cheapest per search)", async () => {
    Object.assign(env, { searchKey: "k", searchProvider: "tavily", anthropicKey: "a" });
    const { searchWeb, searchBackend } = await import("@/lib/search/live");
    expect(searchBackend()).toBe("tavily");
    await searchWeb("q", { auth: signedIn });
    expect(webSearch).toHaveBeenCalledOnce();
    expect(webResearch).not.toHaveBeenCalled();
  });

  it("otherwise runs one Claude web search on the cheapest Claude model and records its tokens without using allowance", async () => {
    Object.assign(env, { anthropicKey: "a", searchProvider: "tavily" });
    const { searchWeb, searchBackend } = await import("@/lib/search/live");
    expect(searchBackend()).toBe("claude");
    const r = await searchWeb("supabase free tier", { auth: signedIn, purpose: "chat_search" });
    const params = webResearch.mock.calls[0]![0] as { model: { id: string }; maxSearches: number; system: string };
    expect(params.model.id).toBe(haiku.id);
    expect(params.maxSearches).toBe(1);
    expect(params.system).toMatch(/untrusted/);
    expect(recordRun).toHaveBeenCalledOnce();
    const run = (recordRun.mock.calls[0] as unknown[])[1] as { auxiliary: boolean; tools?: string[]; purpose: string };
    expect(run.auxiliary).toBe(true);
    expect(run.tools ?? []).toEqual([]); // the caller counts the search, once
    expect(run.purpose).toBe("chat_search");
    // Cited pages first, with the quoted passages; unsafe URLs dropped; numbered from 1.
    expect(r.provider).toBe("claude");
    expect(r.sources.map((s) => s.url)).toEqual(["https://supabase.com/pricing", "https://blog.example.com/review"]);
    expect(r.sources[0]!.snippet).toBe("Free: 2 active projects … Paused after 1 week of inactivity");
    expect(r.sources[0]!.publishedAt).toBe("2026-09-01");
    expect(r.sources.map((s) => s.index)).toEqual([1, 2]);
  });

  it("needs a signed-in person for Claude search, and says when no search is set up", async () => {
    Object.assign(env, { anthropicKey: "a" });
    const { searchWeb } = await import("@/lib/search/live");
    await expect(searchWeb("q", { auth: { mode: "guest" } as never })).rejects.toMatchObject({ code: "unauthorized" });
    delete env.anthropicKey;
    const { searchBackend } = await import("@/lib/search/live");
    expect(searchBackend()).toBeNull();
    await expect(searchWeb("q", { auth: signedIn })).rejects.toMatchObject({ code: "not_configured" });
    expect(webResearch).not.toHaveBeenCalled();
  });

  it("reports a failed search honestly and records nothing", async () => {
    Object.assign(env, { anthropicKey: "a" });
    webResearch.mockRejectedValueOnce(new Error("boom"));
    const { searchWeb } = await import("@/lib/search/live");
    await expect(searchWeb("q", { auth: signedIn })).rejects.toMatchObject({ code: "upstream_error" });
    expect(recordRun).not.toHaveBeenCalled();
  });
});
