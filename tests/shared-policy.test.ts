/**
 * Every AI endpoint goes through the same usage enforcement and time context
 * (usage module mocked here; demo provider; no real model is called).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/http";
import { withTimeContext } from "@/lib/ai/turn-context";
import { demoProvider } from "@/lib/ai/providers/demo";
import type { GenerateParams } from "@/lib/ai/types";

const enforce = vi.fn();
vi.mock("@/lib/usage", async (orig) => ({ ...(await orig<typeof import("@/lib/usage")>()), enforceLimits: (...a: unknown[]) => enforce(...a) }));

const post = (path: string, body: unknown, tz = "Europe/Zurich") =>
  new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.8.0.1", "x-nova-time-zone": tz }, body: JSON.stringify(body) });

beforeAll(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "NOVA_MODELS"]) delete process.env[k];
});
afterEach(() => {
  enforce.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("shared usage enforcement", () => {
  it("chat, agents and Council all reserve usage for the model that will run, with the request id", async () => {
    enforce.mockResolvedValue({ requestId: "r", units: 1, entitlement: null });
    const rid = "00000000-0000-4000-8000-0000000000aa";
    await (await (await import("@/app/api/chat/route")).POST(post("/api/chat", { message: "hi", requestId: rid }))).text();
    await (await (await import("@/app/api/agents/chat/route")).POST(post("/api/agents/chat", { agentId: "coding", message: "hi", requestId: rid }))).text();
    await (await (await import("@/app/api/council/answer/route")).POST(post("/api/council/answer", { question: "hi", modelId: "demo:alpha" }))).text();
    const calls = enforce.mock.calls.map((c) => ({ models: (c[3] as { id: string }[]).map((m) => m.id), opts: c[4] }));
    expect(calls[0]).toMatchObject({ models: [expect.any(String)], opts: { requestId: rid, purpose: "chat" } });
    expect(calls[1]).toMatchObject({ models: [expect.any(String)], opts: { requestId: rid, purpose: "agent" } });
    expect(calls[2]).toMatchObject({ models: ["demo:alpha"], opts: { purpose: "council" } });
  });

  it("an agent can't bypass a limit by using a different endpoint", async () => {
    enforce.mockRejectedValue(new ApiError("quota_exceeded", "You've reached your Free plan's 5-hour limit."));
    const res = await (await import("@/app/api/agents/chat/route")).POST(post("/api/agents/chat", { agentId: "research", message: "hi" }));
    expect(res.status).toBe(429);
    const chat = await (await import("@/app/api/chat/route")).POST(post("/api/chat", { message: "hi" }));
    expect(chat.status).toBe(429);
  });
});

describe("time context in every feature's prompt", () => {
  it("adds the user's local time to an existing system prompt, or adds one", () => {
    const req = post("/x", {}, "America/New_York");
    const now = new Date("2026-10-19T16:40:00Z");
    const a = withTimeContext([{ role: "system", content: "Plan things." }, { role: "user", content: "hi" }], req, now);
    expect(a[0]!.content).toMatch(/^Plan things\.\n\n.*Monday, 19 October 2026, 12:40/s);
    const b = withTimeContext([{ role: "user", content: "hi" }], req, now);
    expect(b[0]!.role).toBe("system");
    expect(b).toHaveLength(2);
  });

  it("gives Council today's date", async () => {
    enforce.mockResolvedValue({ requestId: "r", units: 1, entitlement: null });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-19T16:40:00Z"));
    const seen: GenerateParams[] = [];
    const stream = demoProvider.stream.bind(demoProvider);
    const generate = demoProvider.generate.bind(demoProvider);
    vi.spyOn(demoProvider, "stream").mockImplementation((p: GenerateParams) => (seen.push(p), stream(p)));
    vi.spyOn(demoProvider, "generate").mockImplementation((p: GenerateParams) => (seen.push(p), generate(p)));
    await (await (await import("@/app/api/council/answer/route")).POST(post("/api/council/answer", { question: "What should I do this week?", modelId: "demo:alpha" }))).text();
    expect(seen).toHaveLength(1);
    for (const p of seen) expect(p.messages[0]!.content).toContain("User's local time: Monday, 19 October 2026, 18:40");
  });
});
