import { describe, expect, it } from "vitest";
import { binomialTwoSided, bradleyTerry, decayWeight, quantile, wilson } from "@/lib/intel/stats";
import { check } from "@/lib/intel/checkers";
import { BUILT_IN_TEST_SETS, testSetHash } from "@/lib/intel/testsets";
import { redactIdentity, secureShuffle } from "@/lib/intel/blinding";
import { computeFingerprint } from "@/lib/intel/fingerprint";
import { planRoute, categoryForPrompt } from "@/lib/intel/routing";
import { priceChangeNeedsReview, reconcile, validatePrice } from "@/lib/intel/pricing";
import { parsePrivacyProfiles } from "@/lib/intel/profiles";
import type { BenchmarkRun, TrialRecord } from "@/lib/intel/types";
import type { ModelWithStatus } from "@/lib/ai/types";

const NOW = "2026-10-18T00:00:00.000Z";

function trial(i: number, winnerModel: "x" | "y" | "tie", opts: Partial<TrialRecord> = {}, served: [string | null, string | null] = [null, null]): TrialRecord {
  const xFirst = i % 2 === 0;
  const arm = (id: "x" | "y", label: "A" | "B", s: string | null) => ({ label, modelId: id, displayName: id.toUpperCase(), provider: "openai", servedModel: s, latencyMs: 1000 + i, inputTokens: 10, outputTokens: 20, tokensEstimated: false, cost: 0.001, simulated: false, error: null });
  const arms = xFirst ? [arm("x", "A", served[0]), arm("y", "B", served[1])] : [arm("y", "A", served[1]), arm("x", "B", served[0])];
  const winner = winnerModel === "tie" ? "tie" : (arms.find((a) => a.modelId === winnerModel)!.label as "A" | "B");
  return { id: `t${i}`, createdAt: NOW, category: "coding", prompt: "p", promptHash: "h", testItemId: null, arms, winner, ratings: {}, note: null, redactions: 0, ...opts };
}

function run(model: string, passes: boolean[], served: string | null = null, at = NOW, hash = "H1"): BenchmarkRun {
  return {
    id: `${model}-${at}-${served}`,
    createdAt: at,
    testSetId: "ts",
    testSetName: "TS",
    category: "coding",
    testSetHash: hash,
    modelId: model,
    displayName: model.toUpperCase(),
    servedModel: served,
    params: { maxOutputTokens: 600, temperature: 0 },
    simulated: false,
    results: passes.map((p, i) => ({ itemId: `i${i}`, passed: p, score: p ? 1 : 0, detail: "", output: "", latencyMs: 500, inputTokens: 5, outputTokens: 5, cost: null, error: null })),
  };
}

describe("stats", () => {
  it("computes Wilson intervals", () => {
    const w = wilson(8, 10);
    expect(w.p).toBe(0.8);
    expect(w.low).toBeCloseTo(0.49, 2);
    expect(w.high).toBeCloseTo(0.943, 2);
    expect(wilson(0, 0)).toEqual({ p: 0, low: 0, high: 1 });
  });
  it("computes exact binomial p-values", () => {
    expect(binomialTwoSided(0, 6)).toBeCloseTo(0.03125, 5);
    expect(binomialTwoSided(3, 6)).toBeCloseTo(1, 5);
  });
  it("orders models with Bradley–Terry", () => {
    const s = bradleyTerry(["a", "b"], [...Array(8)].map(() => ({ a: "a", b: "b", w: 1 })).concat([{ a: "b", b: "a", w: 1 }]));
    expect(s.get("a")!).toBeGreaterThan(s.get("b")!);
  });
  it("has quantiles and time decay", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(decayWeight("2026-07-20T00:00:00.000Z", NOW, 90)).toBeCloseTo(0.5, 2);
  });
});

describe("checkers and test sets", () => {
  it("scores deterministically", () => {
    expect(check({ type: "exact", answer: "2,4,6" }, "The output is:\n2,4,6").passed).toBe(true);
    expect(check({ type: "numeric", answer: -4, tolerance: 0.01 }, "Net change: -4%").passed).toBe(true);
    expect(check({ type: "not_stated", forbidden: ["engineer"] }, "The passage does not state who designed it.\nnot stated").passed).toBe(true);
    expect(check({ type: "not_stated" }, "It was designed by Smith.").passed).toBe(false);
    expect(check({ type: "bullets", count: 3, maxWords: 5 }, "- a b\n- c d\n- e f").passed).toBe(true);
    expect(check({ type: "json_keys", keys: ["title", "summary"] }, '```json\n{"title":"t","summary":"s"}\n```').passed).toBe(true);
    expect(check({ type: "lowercase" }, "the sea is wide.").passed).toBe(true);
    expect(check({ type: "regex", pattern: "O\\(\\s*log\\s*\\(?\\s*n\\s*\\)?\\s*\\)" }, "O(log n)").passed).toBe(true);
  });
  it("ships unique ids and stable hashes that change with content", () => {
    const ids = BUILT_IN_TEST_SETS.flatMap((s) => s.items.map((i) => `${s.id}/${i.id}`));
    expect(new Set(ids).size).toBe(ids.length);
    const s = BUILT_IN_TEST_SETS[0]!;
    expect(testSetHash(s)).toBe(testSetHash({ ...s }));
    expect(testSetHash({ ...s, items: s.items.slice(1) })).not.toBe(testSetHash(s));
  });
});

describe("blinding", () => {
  it("redacts model self-identification", () => {
    const r = redactIdentity("As ChatGPT, built by OpenAI, I think Claude Sonnet and Llama 3.3 differ.");
    expect(r.text).not.toMatch(/chatgpt|openai|claude|llama/i);
    expect(r.count).toBe(4);
  });
  it("shuffles without losing items", () => {
    expect(secureShuffle([1, 2, 3, 4]).sort()).toEqual([1, 2, 3, 4]);
  });
});

describe("fingerprint", () => {
  const models = [{ id: "x", displayName: "X" }, { id: "y", displayName: "Y" }];
  it("refuses to conclude from too few trials", () => {
    const fp = computeFingerprint({ trials: [0, 1, 2, 3].map((i) => trial(i, "x")), benchmarks: [], models }, { now: NOW });
    const c = fp.categories.find((c) => c.category === "coding")!;
    expect(c.pairwise[0]!.verdict).toBe("insufficient");
    expect(c.pairwise[0]!.needed).toBe(6);
    expect(c.personal.sufficiency).toBe("insufficient");
    expect(fp.categories.find((c) => c.category === "writing")!.personal.sufficiency).toBe("insufficient");
  });
  it("reports a clear personal preference only when the interval excludes 50%", () => {
    const trials = [...Array(14)].map((_, i) => trial(i, i < 13 ? "x" : "y"));
    const c = computeFingerprint({ trials, benchmarks: [], models }, { now: NOW }).categories.find((c) => c.category === "coding")!;
    expect(c.personal).toMatchObject({ modelId: "x", sufficiency: "clear", basis: "personal_preference" });
    const even = [...Array(14)].map((_, i) => trial(i, i % 2 ? "x" : "y"));
    const c2 = computeFingerprint({ trials: even, benchmarks: [], models }, { now: NOW }).categories.find((c) => c.category === "coding")!;
    expect(c2.pairwise[0]!.verdict).toBe("no_clear_difference");
    expect(c2.personal.sufficiency).toBe("tentative");
  });
  it("keeps general benchmark evidence separate and requires paired significance", () => {
    const fp = computeFingerprint(
      { trials: [], benchmarks: [run("x", Array(24).fill(true)), run("y", [...Array(24)].map((_, i) => i < 12))], models },
      { now: NOW },
    );
    const c = fp.categories.find((c) => c.category === "coding")!;
    expect(c.general).toMatchObject({ modelId: "x", sufficiency: "clear", basis: "general_benchmark" });
    expect(c.personal.sufficiency).toBe("insufficient");
    expect(c.paired[0]!.verdict).toMatch(/a_better|b_better/);
  });
  it("tracks served versions, down-weights older ones and detects drift", () => {
    const old = run("x", [...Array(20)].map(() => true), "x-2026-01", "2026-09-01T00:00:00.000Z");
    const neu = run("x", [...Array(20)].map((_, i) => i < 10), "x-2026-09", "2026-10-10T00:00:00.000Z");
    const fp = computeFingerprint({ trials: [], benchmarks: [old, neu], models }, { now: NOW });
    const m = fp.categories.find((c) => c.category === "coding")!.models.find((m) => m.modelId === "x")!;
    expect(m.version.current).toBe("x-2026-09");
    expect(m.version.seen).toEqual(["x-2026-01", "x-2026-09"]);
    expect(m.benchmark.items).toBe(20); // older version not pooled into the measurement
    expect(m.version.drift).toMatchObject({ verdict: "changed", regressed: 10, improved: 0 });
  });
});

describe("routing", () => {
  const mk = (id: string, provider: "openai" | "huggingface", price: number | null): ModelWithStatus => ({
    id, provider, providerModelId: id, displayName: id, description: "", capabilities: ["chat", "coding"], contextWindow: 100000,
    inputPrice: price, outputPrice: price, isEnabled: true, lastVerifiedAt: null, available: true,
  });
  const models = [mk("x", "openai", 1), mk("y", "huggingface", null), mk("z", "openai", 10)];
  const profiles = parsePrivacyProfiles(JSON.stringify({ openai: { trainsOnApiData: false, retentionDays: 30 } }));

  it("classifies prompts into categories", () => {
    expect(categoryForPrompt("Extract the invoice fields")).toBe("extraction");
    expect(categoryForPrompt("Why does this TypeError happen in my function?")).toBe("coding");
    expect(categoryForPrompt("Draft an email to my landlord")).toBe("writing");
  });
  it("applies hard constraints and explains exclusions", () => {
    const plan = planRoute({ prompt: "fix this bug in my function", models, fingerprint: null, privacyProfiles: profiles, constraints: { requireNoTraining: true, maxPricePer1M: 5 }, rulesPick: "z" });
    expect(plan.primary).toBe("x");
    expect(plan.basis).toBe("rules");
    expect(plan.excluded.find((e) => e.modelId === "y")?.reason).toMatch(/not verified/);
    expect(plan.excluded.find((e) => e.modelId === "z")?.reason).toMatch(/exceeds/);
  });
  it("uses sufficient personal evidence and prefers cross-provider fallbacks", () => {
    const trials = [...Array(14)].map((_, i) => trial(i, i < 13 ? "y" : "x"));
    const fp = computeFingerprint({ trials, benchmarks: [], models }, { now: NOW });
    const plan = planRoute({ prompt: "fix this bug in my function", models, fingerprint: fp, privacyProfiles: profiles, rulesPick: "x" });
    expect(plan).toMatchObject({ primary: "y", basis: "personal_preference", sufficiency: "clear" });
    expect(plan.fallbacks[0]).toBe("x");
  });
});

describe("pricing", () => {
  it("validates provenance, bounds and staleness", () => {
    expect(validatePrice({ id: "a", provider: "openai", inputPrice: null, outputPrice: null, lastVerifiedAt: null }, NOW).status).toBe("unverified");
    expect(validatePrice({ id: "a", provider: "openai", inputPrice: 1, outputPrice: 4, lastVerifiedAt: "2026-10-01", priceSourceUrl: "https://x.test" }, NOW).status).toBe("verified");
    expect(validatePrice({ id: "a", provider: "openai", inputPrice: 1, outputPrice: 4, lastVerifiedAt: "2026-05-01", priceSourceUrl: "https://x.test" }, NOW).status).toBe("stale");
    expect(validatePrice({ id: "a", provider: "openai", inputPrice: 2000, outputPrice: 4000, lastVerifiedAt: "2026-10-01" }, NOW).status).toBe("invalid");
  });
  it("flags large price changes and reconciles against billing", () => {
    expect(priceChangeNeedsReview(1, 2)).toBe(true);
    expect(priceChangeNeedsReview(1, 1.2)).toBe(false);
    expect(reconcile(102, 100).verdict).toBe("match");
    expect(reconcile(130, 100).verdict).toBe("investigate");
  });
});

describe("custom test sets", () => {
  it("refuse regex checkers, which could freeze the server (ReDoS)", async () => {
    const { customTestSet } = await import("@/lib/validation-research");
    const base = { id: "my-set", name: "Mine", category: "analysis", version: "1", items: [{ id: "a", prompt: "Write about cats.", checker: { type: "contains_any", values: ["cat"] } }] };
    expect(customTestSet.safeParse(base).success).toBe(true);
    const evil = { ...base, items: [{ id: "a", prompt: "Write about cats.", checker: { type: "regex", pattern: "([a-z ,.']+)*#" } }] };
    expect(customTestSet.safeParse(evil).success).toBe(false);
  });
});
