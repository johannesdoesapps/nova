/**
 * Route-handler integration tests in guest/demo mode (no Supabase, no AI keys).
 * Verifies validation, honest demo labelling, independent failures and that
 * persistence routes refuse to run without auth.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  for (const k of [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "OPENAI_API_KEY",
    "HUGGINGFACE_API_KEY",
    "SEARCH_API_KEY",
    "NOVA_MODELS",
  ])
    delete process.env[k];
});

const post = (url: string, body: unknown, ip = "10.0.0.1") =>
  new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

async function readNdjson(res: Response) {
  const text = await res.text();
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("GET /api/models", () => {
  it("lists demo models as the only available ones and recommends one", async () => {
    const { GET } = await import("@/app/api/models/route");
    const res = await GET(new Request("http://localhost/api/models?prompt=summarize%20this&costSensitive=true"));
    expect(res.status).toBe(200);
    const j = await res.json();
    const available = j.models.filter((m: { available: boolean }) => m.available);
    expect(available.every((m: { provider: string }) => m.provider === "demo")).toBe(true);
    expect(j.models.some((m: { provider: string; available: boolean }) => m.provider === "openai" && !m.available)).toBe(true);
    expect(j.recommendation.modelId).toMatch(/^demo:/);
    expect(j.recommendation.disclaimer).toBeTruthy();
  });
});

describe("POST /api/search", () => {
  it("rejects invalid input with a consistent error envelope", async () => {
    const { POST } = await import("@/app/api/search/route");
    const res = await POST(post("/api/search", { query: "x" }));
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error.code).toBe("bad_request");
    const bad = await POST(post("/api/search", "{not json"));
    expect(bad.status).toBe(400);
  });

  it("says evidence could not be retrieved and labels the answer as simulated", async () => {
    const { POST } = await import("@/app/api/search/route");
    const res = await POST(post("/api/search", { query: "latest open-source AI developments" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("ndjson");
    const events = await readNdjson(res);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("meta");
    expect(types).toContain("notice");
    expect(String(events.find((e) => e.type === "notice")!.message)).toMatch(/could not be retrieved/i);
    const sources = events.find((e) => e.type === "sources")!;
    expect(sources.sources).toEqual([]);
    const done = events.find((e) => e.type === "done")!;
    expect(done.simulated).toBe(true);
    expect(done.grounded).toBe(false);
    expect(done.citedSources).toEqual([]);
    expect(String(done.answer)).toMatch(/simulated/i);
  });
});

describe("POST /api/chat", () => {
  it("streams a labelled demo reply for guests without persisting", async () => {
    const { POST } = await import("@/app/api/chat/route");
    const res = await POST(post("/api/chat", { message: "Hello there", mode: "critic", history: [{ role: "user", content: "earlier" }] }));
    const events = await readNdjson(res);
    expect(events[0]).toMatchObject({ type: "meta", conversationId: null, persisted: false });
    const done = events.find((e) => e.type === "done")!;
    expect(done).toMatchObject({ simulated: true, assistantMessageId: null });
    // The model shown while streaming is the one that answered.
    expect((done.model as { id: string }).id).toBe((events[0]!.model as { id: string }).id);
    const deltas = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
    expect(deltas).toBe(done.text);
  });

  it("rejects unsupported attachment types", async () => {
    const { POST } = await import("@/app/api/chat/route");
    const res = await POST(post("/api/chat", { message: "read this", attachments: [{ name: "x.pdf", content: "%PDF" }] }));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/compare", () => {
  it("runs models in parallel and reports failures per model", async () => {
    const { POST } = await import("@/app/api/compare/route");
    const res = await POST(post("/api/compare", { prompt: "Say hi", modelIds: ["demo:alpha", "demo:beta", "openai:gpt-5"] }, "10.0.0.2"));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.results).toHaveLength(3);
    const [a, b, c] = j.results;
    expect(a).toMatchObject({ status: "success", simulated: true, estimatedCost: 0 });
    expect(typeof a.latencyMs).toBe("number");
    expect(b.status).toBe("success");
    expect(c).toMatchObject({ status: "error", simulated: false, estimatedCost: null });
    expect(c.error).toMatch(/OPENAI_API_KEY/);
  });

  it("enforces the configurable model limit", async () => {
    const { POST } = await import("@/app/api/compare/route");
    const res = await POST(post("/api/compare", { prompt: "p", modelIds: ["a", "b", "c", "d"] }, "10.0.0.3"));
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/at most 3/);
  });

  it("rate-limits bursts per client", async () => {
    vi.resetModules();
    process.env.NOVA_RATE_LIMIT_PER_MINUTE = "2";
    const { POST } = await import("@/app/api/compare/route");
    const body = { prompt: "p", modelIds: ["demo:alpha", "demo:beta"] };
    expect((await POST(post("/api/compare", body, "10.9.9.9"))).status).toBe(200);
    const limited = await POST(post("/api/compare", body, "10.9.9.9"));
    expect(limited.status).toBe(429);
    expect((await limited.json()).error.code).toBe("rate_limited");
    delete process.env.NOVA_RATE_LIMIT_PER_MINUTE;
  });
});

describe("persistence routes without Supabase", () => {
  it("return 503 not_configured naming the missing variables", async () => {
    const { GET, POST } = await import("@/app/api/projects/route");
    const r1 = await GET();
    expect(r1.status).toBe(503);
    expect((await r1.json()).error.message).toMatch(/NEXT_PUBLIC_SUPABASE_URL/);
    const r2 = await POST(post("/api/projects", { name: "Startup Research" }));
    expect(r2.status).toBe(503);
  });
});

describe("GET /api/status", () => {
  it("exposes only booleans, never secret values", async () => {
    process.env.OPENAI_API_KEY = "sk-super-secret-value";
    vi.resetModules();
    const { GET } = await import("@/app/api/status/route");
    const res = await GET();
    const text = await res.text();
    expect(text).not.toContain("sk-super-secret-value");
    const j = JSON.parse(text);
    expect(j.integrations.find((i: { id: string }) => i.id === "openai").configured).toBe(true);
    delete process.env.OPENAI_API_KEY;
  });
});

describe("request body limits", () => {
  it("stops reading a body without Content-Length once it passes the limit", async () => {
    const { parseJsonBody } = await import("@/lib/http");
    const { z } = await import("zod");
    const big = new ReadableStream({
      start(c) {
        for (let i = 0; i < 100; i++) c.enqueue(new TextEncoder().encode("x".repeat(1000)));
        c.close();
      },
    });
    const req = new Request("http://x", { method: "POST", body: big, duplex: "half" } as RequestInit);
    await expect(parseJsonBody(req, z.object({}), 10_000)).rejects.toThrow(/exceeds 10000 bytes/);
    // Limits count bytes, not characters.
    const ok = new Request("http://x", { method: "POST", body: JSON.stringify({ t: "é".repeat(10) }) });
    await expect(parseJsonBody(ok, z.object({ t: z.string() }), 1000)).resolves.toEqual({ t: "é".repeat(10) });
  });
});
