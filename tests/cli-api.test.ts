/**
 * The Orbis terminal app's server side: bearer-token sign-in (src/lib/cli-auth.ts), GET /api/cli/config,
 * POST /api/cli/turn (validation, model choice, Bastion, metering exactly like an Orbis Code step),
 * POST /api/cli/fetch (the guarded link reader), POST /api/cli/session, and the /cli/login page's helpers.
 * Supabase, the model provider and the usage ledger are stand-ins.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/http";

const GOOD = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJlLXZhbHVl";
const OTHER = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTIifQ.c2lnbmF0dXJlLXZhbHVl";

const state = {
  clients: [] as { url: string; key: string; opts: { global?: { headers?: Record<string, string> } } }[],
  suspended: null as null | { kind: string; message: string },
  signedIn: true,
  turn: vi.fn(),
  link: vi.fn(),
};

const model = (id: string, provider: string, extra: Record<string, unknown> = {}) => ({ id, provider, displayName: id.toUpperCase(), description: "", capabilities: ["coding"], contextWindow: 200_000, inputPrice: 1, outputPrice: 5, isEnabled: true, available: true, lastVerifiedAt: null, providerModelId: id, ...extra });

vi.mock("@/lib/env", async (orig) => ({
  ...(await orig<typeof import("@/lib/env")>()),
  isSupabaseConfigured: () => true,
  publicEnv: { supabaseUrl: "https://sb.test", supabaseKey: "pk-test", siteUrl: "https://orbis.test" },
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: (url: string, key: string, opts: { global?: { headers?: Record<string, string> } }) => {
    state.clients.push({ url, key, opts });
    return {
      auth: {
        getUser: async (token: string) =>
          token === GOOD ? { data: { user: { id: "user-1", email: "pat@example.com", user_metadata: { full_name: "Pat" } } }, error: null } : { data: { user: null }, error: { message: "invalid JWT" } },
      },
    };
  },
}));
vi.mock("@/lib/supabase/admin", () => ({ serviceSupabase: () => null }));
vi.mock("@/lib/auth", () => ({
  requireUser: async () => {
    if (!state.signedIn) throw new ApiError("unauthorized", "Please sign in to continue.");
    return { mode: "authenticated", user: { id: "user-1", email: "pat@example.com", displayName: null }, supabase: {} };
  },
}));
vi.mock("@/lib/usage", () => ({
  enforceLimits: vi.fn(async () => ({ requestId: "r1", units: 1 })),
  planLimits: vi.fn(async () => ({ maxOutputTokens: 4000, historyChars: 100_000, tiers: ["standard"], webSearchesLeft: 0 })),
  recordRunLater: vi.fn(),
  releaseUsage: vi.fn(async () => {}),
}));
vi.mock("@/lib/ai", () => ({
  getModels: async () => [model("claude-x", "anthropic", { isDefault: true }), model("gpt-x", "openai"), model("gemini-x", "google"), model("demo-x", "demo"), model("off-x", "anthropic", { available: false })],
  resolveModelChoice: vi.fn(async (id: string) => {
    if (id === "missing") throw new ApiError("bad_request", '"missing" isn\'t an available model.');
    const m = id === "gemini-x" ? model("gemini-x", "google") : model("claude-x", "anthropic");
    return { model: m, routing: id.startsWith("auto") ? { auto: true, mode: "coding", reason: "Best for code." } : null, settings: {} };
  }),
  getProvider: () => ({ toolTurn: (...a: unknown[]) => state.turn(...a) }),
  withTimeout: () => new AbortController().signal,
}));
vi.mock("@/lib/ai/platform", () => ({ autoIdFor: (m: string) => `auto:${m}` }));
vi.mock("@/lib/code/agent/engine", () => ({ AGENT_OUTPUT_TOKENS: 16_000, usesNativeTools: (m: { provider: string }) => m.provider === "anthropic" || m.provider === "openai" }));
vi.mock("@/lib/bastion/server", () => ({ agentSuspended: async () => state.suspended }));
vi.mock("@/lib/links/read", () => ({ readLink: (...a: unknown[]) => state.link(...a) }));
vi.mock("@/lib/observability", () => ({ reportError: () => {} }));

const { GET: config } = await import("@/app/api/cli/config/route");
const { POST: turn } = await import("@/app/api/cli/turn/route");
const { POST: fetchRoute } = await import("@/app/api/cli/fetch/route");
const { POST: session } = await import("@/app/api/cli/session/route");
const { bearerToken } = await import("@/lib/cli-auth");
const { cliCallbackUrl, cliLoginPath, cliPort, cliState } = await import("@/lib/cli-login");
const { CLI_VERSION } = await import("@/lib/cli-version");
const usage = await import("@/lib/usage");
const ai = await import("@/lib/ai");

const req = (url: string, body: unknown, token: string | null = GOOD, raw?: string) =>
  new Request(`https://orbis.test${url}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: raw ?? JSON.stringify(body) });
const tool = { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } };
const goodBody = { system: "You are Orbis.", messages: [{ role: "user", text: "Fix the test" }], tools: [tool] };

beforeEach(() => {
  state.clients = [];
  state.suspended = null;
  state.signedIn = true;
  state.turn.mockReset();
  state.turn.mockResolvedValue({ text: "Reading.", calls: [{ id: "c1", name: "read_file", args: { path: "a.ts" } }], usage: { inputTokens: 120, outputTokens: 30, estimated: false }, servedModel: "claude-x-2026", stop: "tool_use" });
  state.link.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe("bearer sign-in", () => {
  it("reads only well-formed bearer tokens", () => {
    const h = (v: string) => new Request("https://x", { headers: { authorization: v } });
    expect(bearerToken(h(`Bearer ${GOOD}`))).toBe(GOOD);
    expect(bearerToken(h(`bearer ${GOOD}`))).toBe(GOOD);
    expect(bearerToken(h("Bearer not-a-jwt"))).toBeNull();
    expect(bearerToken(h(`Basic ${GOOD}`))).toBeNull();
    expect(bearerToken(new Request("https://x"))).toBeNull();
  });
});

describe("GET /api/cli/config", () => {
  it("is public and lists only available models with native tool calling", async () => {
    const res = await config();
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j).toMatchObject({ supabaseUrl: "https://sb.test", supabaseKey: "pk-test", autoModelId: "auto:coding", cli: { version: CLI_VERSION, download: "/downloads/orbis-cli.mjs" } });
    expect(j.models.map((m: { id: string }) => m.id)).toEqual(["claude-x", "gpt-x"]);
    expect(j.models[0]).toMatchObject({ isDefault: true, contextWindow: 200_000 });
    expect(JSON.stringify(j)).not.toMatch(/service|secret/i);
  });

  it("advertises the same version as the downloadable file", () => {
    const src = readFileSync(join(__dirname, "..", "public/downloads/orbis-cli.mjs"), "utf8");
    expect(/export const VERSION = "([^"]+)"/.exec(src)?.[1]).toBe(CLI_VERSION);
  });
});

describe("POST /api/cli/turn", () => {
  it("needs a valid access token", async () => {
    expect((await turn(req("/api/cli/turn", goodBody, null))).status).toBe(401);
    expect((await turn(req("/api/cli/turn", goodBody, "garbage"))).status).toBe(401);
    const bad = await turn(req("/api/cli/turn", goodBody, OTHER));
    expect(bad.status).toBe(401);
    expect((await bad.json()).error.message).toMatch(/orbis login/);
    expect(state.turn).not.toHaveBeenCalled();
    expect(usage.enforceLimits).not.toHaveBeenCalled();
  });

  it("validates the body", async () => {
    const status = async (b: unknown, raw?: string) => (await turn(req("/api/cli/turn", b, GOOD, raw))).status;
    expect(await status(null, "{not json")).toBe(400);
    expect(await status({ ...goodBody, messages: [] })).toBe(400);
    expect(await status({ ...goodBody, messages: [{ role: "system", text: "x" }] })).toBe(400);
    expect(await status({ ...goodBody, tools: [] })).toBe(400);
    expect(await status({ ...goodBody, tools: [{ ...tool, name: "bad name!" }] })).toBe(400);
    expect(await status({ ...goodBody, tools: Array.from({ length: 65 }, (_, i) => ({ ...tool, name: `t${i}` })) })).toBe(400);
    expect(await status({ ...goodBody, tools: [tool, tool] })).toBe(400);
    expect(await status({ ...goodBody, maxOutputTokens: 10 })).toBe(400);
    expect(await status({ ...goodBody, system: "x".repeat(1_600_000) })).toBe(413);
    expect(state.turn).not.toHaveBeenCalled();
  });

  it("runs one metered model turn as the user, like an Orbis Code step", async () => {
    const messages = [
      { role: "user", text: "Fix the test" },
      { role: "assistant", text: "Looking.", calls: [{ id: "c0", name: "read_file", args: { path: "x.ts" } }] },
      { role: "user", text: "", results: [{ id: "c0", ok: true, text: "contents" }] },
    ];
    const res = await turn(req("/api/cli/turn", { ...goodBody, messages, maxOutputTokens: 50_000 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "Reading.", calls: [{ id: "c1", name: "read_file", args: { path: "a.ts" } }], usage: { inputTokens: 120, outputTokens: 30, estimated: false }, stop: "tool_use", model: "CLAUDE-X", modelId: "claude-x" });
    // the Supabase client carries the user's token, so row-level security applies
    expect(state.clients[0]).toMatchObject({ url: "https://sb.test", key: "pk-test", opts: { global: { headers: { Authorization: `Bearer ${GOOD}` } } } });
    expect(vi.mocked(ai.resolveModelChoice)).toHaveBeenCalledWith("auto:coding", { prompt: "Fix the test", mode: "coding", tiers: ["standard"] });
    const [, auth, cost, models, opts] = vi.mocked(usage.enforceLimits).mock.calls[0]!;
    expect(auth).toMatchObject({ mode: "authenticated", user: { id: "user-1", email: "pat@example.com", displayName: "Pat" } });
    expect(cost).toBe(1);
    expect((models as { id: string }[]).map((m) => m.id)).toEqual(["claude-x"]);
    expect(opts).toMatchObject({ purpose: "code_agent", maxOutputTokens: 16_000 });
    expect(state.turn.mock.calls[0]![0]).toMatchObject({ system: "You are Orbis.", messages, tools: [tool], maxOutputTokens: 16_000 });
    expect(vi.mocked(usage.recordRunLater).mock.calls[0]![1]).toMatchObject({ purpose: "code_agent", category: "coding", status: "success", requestedModel: "auto:coding", servedModel: "claude-x-2026", routingReason: "Best for code." });
    expect(usage.releaseUsage).not.toHaveBeenCalled();
  });

  it("refuses models without native tools, unknown models and a suspended agent before metering", async () => {
    const r1 = await turn(req("/api/cli/turn", { ...goodBody, model: "gemini-x" }));
    expect(r1.status).toBe(400);
    expect((await r1.json()).error.message).toMatch(/can't call tools/);
    expect((await turn(req("/api/cli/turn", { ...goodBody, model: "missing" }))).status).toBe(400);
    state.suspended = { kind: "suspended", message: "this agent is suspended by an administrator." };
    const r3 = await turn(req("/api/cli/turn", goodBody));
    expect(r3.status).toBe(403);
    expect((await r3.json()).error.message).toMatch(/Bastion/);
    expect(usage.enforceLimits).not.toHaveBeenCalled();
  });

  it("gives the allowance back when the model call fails", async () => {
    state.turn.mockRejectedValueOnce(new Error("socket hang up"));
    const res = await turn(req("/api/cli/turn", goodBody));
    expect(res.status).toBe(502);
    expect((await res.json()).error.message).toMatch(/wasn't counted/);
    expect(usage.releaseUsage).toHaveBeenCalledTimes(1);
    expect(usage.recordRunLater).not.toHaveBeenCalled();
    state.turn.mockRejectedValueOnce(new ApiError("quota_exceeded", "Limit reached."));
    expect((await turn(req("/api/cli/turn", goodBody))).status).toBe(429);
  });

  it("passes on the usage guard's refusal", async () => {
    vi.mocked(usage.enforceLimits).mockRejectedValueOnce(new ApiError("quota_exceeded", "You've used this week's allowance."));
    const res = await turn(req("/api/cli/turn", goodBody));
    expect(res.status).toBe(429);
    expect(state.turn).not.toHaveBeenCalled();
  });
});

describe("POST /api/cli/fetch", () => {
  it("needs sign-in and an http(s) address, and reads through the guarded reader", async () => {
    expect((await fetchRoute(req("/api/cli/fetch", { url: "https://example.com" }, null))).status).toBe(401);
    expect((await fetchRoute(req("/api/cli/fetch", { url: "file:///etc/passwd" }))).status).toBe(400);
    expect((await fetchRoute(req("/api/cli/fetch", { url: "not a url" }))).status).toBe(400);
    state.link.mockResolvedValueOnce({ ok: true, url: "https://example.com", finalUrl: "https://example.com/", title: "Example", text: "Example Domain text" });
    const ok = await fetchRoute(req("/api/cli/fetch", { url: "https://example.com" }));
    expect(await ok.json()).toEqual({ ok: true, url: "https://example.com", finalUrl: "https://example.com/", title: "Example", text: "Example Domain text", truncated: false });
    state.link.mockResolvedValueOnce({ ok: false, url: "http://10.0.0.1", reason: "it points to a private or internal address, which Orbis never opens" });
    const blocked = await fetchRoute(req("/api/cli/fetch", { url: "http://10.0.0.1" }));
    expect(await blocked.json()).toMatchObject({ ok: false, reason: expect.stringMatching(/private/) });
    expect(usage.enforceLimits).not.toHaveBeenCalled();
  });
});

describe("POST /api/cli/session", () => {
  it("needs the browser's sign-in, and says when it can't open a separate session", async () => {
    state.signedIn = false;
    expect((await session()).status).toBe(401);
    state.signedIn = true;
    const res = await session();
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("not_configured");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("/cli/login helpers", () => {
  it("accepts only a plain port and a URL-safe state, and sends tokens to 127.0.0.1 in the fragment", () => {
    expect(cliPort("54321")).toBe(54321);
    for (const p of ["80", "70000", "1e4", "", undefined, "12a45"]) expect(cliPort(p)).toBeNull();
    expect(cliState("a".repeat(16))).toBe("a".repeat(16));
    for (const s of ["short", "a".repeat(129), "bad state with spaces!!", "<script>alert(1)</script>xx"]) expect(cliState(s)).toBeNull();
    const u = cliCallbackUrl(54321, { access_token: "a.b.c", refresh_token: "r&1", expires_at: 99 }, "s".repeat(20));
    expect(u).toBe(`http://127.0.0.1:54321/callback#access_token=a.b.c&refresh_token=r%261&state=${"s".repeat(20)}&expires_at=99`);
    expect(new URL(u).search).toBe("");
    expect(cliLoginPath(54321, "s".repeat(20))).toBe(`/cli/login?port=54321&state=${"s".repeat(20)}`);
  });
});
