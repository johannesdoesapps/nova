/**
 * Route-handler tests for Claim DNA and Model Intelligence in guest/demo mode
 * (no Supabase, no AI keys).
 */
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "OPENAI_API_KEY", "HUGGINGFACE_API_KEY", "SEARCH_API_KEY", "NOVARA_MODELS"]) delete process.env[k];
  process.env.NOVARA_DAILY_REQUEST_LIMIT = "1000";
  process.env.NOVARA_RATE_LIMIT_PER_MINUTE = "1000";
});

const post = (url: string, body: unknown, ip = "10.0.9.1") =>
  new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) });

describe("POST /api/claims/analyze", () => {
  it("returns a report with claims, sources and a replay log", async () => {
    const { POST } = await import("@/app/api/claims/analyze/route");
    const res = await POST(post("/api/claims/analyze", {
      question: "q",
      answer: "The bridge opened in 1998 [1]. It carries 40,000 cars a day.",
      sources: [{ url: "https://example.gov/bridge", title: "Bridge", text: "The bridge opened to traffic in 1998 after four years of construction." }],
    }));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.saved).toBe(false);
    expect(j.report.claims).toHaveLength(2);
    expect(j.report.claims[0].assessment.status).toBe("supported");
    expect(j.report.claims[1].assessment.status).toBe("insufficient");
    expect(j.report.replay.events.map((e: { step: string }) => e.step)).toContain("evidence_linking");
  });
  it("falls back to rules with an honest notice in demo model mode", async () => {
    const { POST } = await import("@/app/api/claims/analyze/route");
    const j = await (await POST(post("/api/claims/analyze", { answer: "The bridge opened in 1998 [1].", mode: "model", sources: [{ text: "The bridge opened in 1998." }] }))).json();
    expect(j.notices.join(" ")).toMatch(/Demo mode/);
    expect(j.report.mode).toBe("model");
  });
  it("rejects javascript: source URLs", async () => {
    const { POST } = await import("@/app/api/claims/analyze/route");
    const res = await POST(post("/api/claims/analyze", { answer: "Something long enough here.", sources: [{ url: "javascript:alert(1)", text: "x" }] }));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/claims/hypotheses", () => {
  it("returns labelled template hypotheses", async () => {
    const { POST } = await import("@/app/api/claims/hypotheses/route");
    const j = await (await POST(post("/api/claims/hypotheses", { question: "Why did sales fall?", useModel: true }))).json();
    expect(j.origin).toBe("template");
    expect(j.hypotheses.length).toBeGreaterThanOrEqual(3);
  });
});

describe("blind trials", () => {
  it("hides identities until the vote, then reveals them", async () => {
    const { POST: start } = await import("@/app/api/intel/trials/route");
    const r = await start(post("/api/intel/trials", { prompt: "Say hi", category: "general" }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.void).toBe(false);
    expect(j.simulated).toBe(true);
    const raw = JSON.stringify(j);
    expect(raw).not.toMatch(/demo:alpha|demo:beta|Demo model/);
    expect(j.shown.map((s: { label: string }) => s.label)).toEqual(["A", "B"]);

    const { POST: vote } = await import("@/app/api/intel/trials/vote/route");
    const v = await (await vote(post("/api/intel/trials/vote", { token: j.token, winner: "A", ratings: { A: 4 } }))).json();
    expect(v.saved).toBe(false);
    expect(v.trial.arms.map((a: { modelId: string }) => a.modelId).sort()).toEqual(["demo:alpha", "demo:beta"]);
    expect(v.trial.winner).toBe("A");
  });
  it("rejects tampered tokens", async () => {
    const { POST: vote } = await import("@/app/api/intel/trials/vote/route");
    const res = await vote(post("/api/intel/trials/vote", { token: "aaaa.bbbb.cccccccccc", winner: "A" }));
    expect(res.status).toBe(400);
  });
});

describe("benchmarks, routing, directory", () => {
  it("runs a built-in test set with deterministic scoring", async () => {
    const { POST } = await import("@/app/api/intel/benchmarks/route");
    const j = await (await POST(post("/api/intel/benchmarks", { modelId: "demo:alpha", testSetId: "general-facts-v1", maxItems: 4 }))).json();
    expect(j.run.results).toHaveLength(4);
    expect(j.run.simulated).toBe(true);
    expect(j.run.testSetHash).toMatch(/^[0-9a-f]{14}$/);
    expect(j.run.results.every((r: { passed: boolean }) => r.passed === false)).toBe(true); // template text can't pass
  });
  it("plans a route with rules when there is no evaluation history", async () => {
    const { POST } = await import("@/app/api/intel/route/route");
    const j = await (await POST(post("/api/intel/route", { prompt: "Summarise this memo" }))).json();
    expect(j.plan.basis).toBe("rules");
    expect(j.plan.primary).toMatch(/^demo:/);
  });
  it("executes with fallbacks and reports attempts", async () => {
    const { POST } = await import("@/app/api/intel/route/route");
    const j = await (await POST(post("/api/intel/route", { prompt: "Summarise this memo", execute: true }))).json();
    expect(j.attempts[0].ok).toBe(true);
    expect(j.result.simulated).toBe(true);
  });
  it("lists models with price validation and unverified privacy by default", async () => {
    const { GET } = await import("@/app/api/intel/directory/route");
    const j = await (await GET()).json();
    const real = j.models.find((m: { provider: string }) => m.provider === "openai");
    expect(real.priceValidation.status).toBe("unverified");
    expect(real.privacy.trainsOnApiData).toBeNull();
  });
});
