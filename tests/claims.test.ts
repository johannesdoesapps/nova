import { describe, expect, it } from "vitest";
import { extractClaims } from "@/lib/claims/extract";
import { runClaimPipeline, inputFromReport } from "@/lib/claims/pipeline";
import { compareReplays } from "@/lib/claims/replay";
import { classifySourceType } from "@/lib/claims/sources";
import { findQuote, numbers } from "@/lib/claims/text";
import { conflicts, directVsInference, misCitations, missingEvidence, unsupportedStatements } from "@/lib/claims/workflows";
import { newArena, standings, templateHypotheses, verdict, statusFromEvidence, suggestEvidence } from "@/lib/claims/hypothesis";
import { parseJudgements, parseHypotheses } from "@/lib/claims/llm";
import type { PipelineInput } from "@/lib/claims/types";

const NOW = "2026-10-18T00:00:00.000Z";

const SOURCES = [
  {
    url: "https://www.cdc.gov/report",
    title: "CDC report",
    publishedAt: "2025-03-01",
    provider: "tavily",
    text: "In 2024, adult obesity prevalence in the United States was 40.3 percent according to national survey data. Rates were highest among adults aged 40 to 59.",
  },
  {
    url: "https://example-blog.medium.com/post",
    title: "A blog",
    publishedAt: null,
    provider: "tavily",
    text: "Some commentators argue adult obesity prevalence in the United States was 30 percent in 2024. Regular exercise reduces the risk of heart disease substantially.",
  },
  {
    url: "https://www.who.int/fact",
    title: "WHO fact sheet",
    publishedAt: "2015-01-01",
    provider: "tavily",
    text: "Sugar-sweetened beverages are a major source of added sugar in many diets worldwide.",
  },
];

const ANSWER = `Adult obesity prevalence in the United States was 40.3 percent in 2024 [1].
Rates were highest among adults aged 40 to 59 [1]. Regular exercise reduces the risk of heart disease [3].

Interpretation: This suggests public health campaigns have had limited effect.

Electric cars were invented in 1832. You should probably drink more water.

Follow-ups:
- What about children?`;

const input = (extra: Partial<PipelineInput> = {}): PipelineInput => ({ question: "US obesity rate", answer: ANSWER, sources: SOURCES, now: NOW, mode: "rules", ...extra });

describe("text utilities", () => {
  it("parses numbers with units", () => {
    expect(numbers("40.3 percent and $2.5 billion in 2024").map((n) => [n.value, n.unit])).toEqual([
      [40.3, "%"],
      [2.5e9, "$"],
      [2024, "year"],
    ]);
  });
  it("finds quotes tolerant of whitespace and case", () => {
    expect(findQuote("Hello   World, this is a test.", "world, this IS a")).toBeGreaterThan(0);
    expect(findQuote("Hello world", "not there at all")).toBe(-1);
  });
  it("classifies source types from domains", () => {
    expect(classifySourceType("https://www.cdc.gov/x")).toBe("government");
    expect(classifySourceType("https://arxiv.org/abs/1")).toBe("preprint");
    expect(classifySourceType("https://foo.medium.com/x")).toBe("blog_forum");
    expect(classifySourceType(null)).toBe("user_provided");
  });
});

describe("claim extraction", () => {
  const { claims } = extractClaims(ANSWER);
  it("splits sentences into claims, drops follow-ups and questions", () => {
    expect(claims.map((c) => c.text)).not.toContain("What about children?");
    expect(claims.length).toBe(6);
  });
  it("splits compound sentences at citation boundaries", () => {
    const { claims: parts } = extractClaims("Output per employee rose 8% during the pilot [1], and sick days fell by a third [2].");
    expect(parts.map((c) => [c.text, c.citedIndexes])).toEqual([
      ["Output per employee rose 8% during the pilot", [1]],
      ["Sick days fell by a third.", [2]],
    ]);
  });
  it("labels origin from citations and inference markers", () => {
    expect(claims[0]).toMatchObject({ origin: "cited", citedIndexes: [1], kind: "statistical" });
    expect(claims.find((c) => c.text.startsWith("This suggests"))?.origin).toBe("ai_inference");
    expect(claims.find((c) => c.text.startsWith("Electric cars"))?.origin).toBe("uncited");
    expect(claims.find((c) => c.text.startsWith("You should"))?.kind).toBe("opinion");
  });
});

describe("pipeline", () => {
  const report = runClaimPipeline(input(), "r1");
  const byStart = (s: string) => report.claims.find((c) => c.text.startsWith(s))!;

  it("marks a claim with matching source text and figures as directly supported but contested by a conflicting figure", () => {
    const c = byStart("Adult obesity");
    expect(c.evidence.find((l) => l.sourceId === "S1")?.stance).toBe("supports");
    expect(c.evidence.find((l) => l.sourceId === "S2")?.stance).toBe("contradicts");
    expect(c.assessment.status).toBe("contested");
    expect(conflicts(report.claims).map((x) => x.claim.id)).toContain(c.id);
  });
  it("detects mis-citations", () => {
    const c = byStart("Regular exercise");
    const s3 = c.evidence.find((l) => l.sourceId === "S3");
    expect(s3?.cited).toBe(true);
    expect(s3?.stance).toBe("insufficient");
    expect(misCitations(report.claims).some((m) => m.claim.id === c.id)).toBe(true);
    // ...but finds the uncited source that does support it.
    expect(c.evidence.find((l) => l.sourceId === "S2")?.stance).toBe("supports");
  });
  it("flags unsupported statements and suggests searches", () => {
    const c = byStart("Electric cars");
    expect(c.assessment.status).toBe("insufficient");
    expect(c.assessment.basis).toBe("none");
    expect(unsupportedStatements(report.claims)).toContain(c);
    expect(missingEvidence(report.claims).find((m) => m.claim.id === c.id)?.queries.length).toBeGreaterThan(0);
  });
  it("separates AI inference from direct evidence and marks opinions not checkable", () => {
    const d = directVsInference(report.claims);
    expect(d.inference.some((c) => c.text.startsWith("This suggests"))).toBe(true);
    expect(d.direct.some((c) => c.text.startsWith("Rates were highest"))).toBe(true);
    expect(byStart("You should").assessment.status).toBe("not_checkable");
    expect(byStart("You should").assessment.estimate).toBeNull();
  });
  it("never presents estimates without a caveat and caps snippet-only evidence below the top band", () => {
    for (const c of report.claims) {
      if (c.assessment.estimate) {
        expect(c.assessment.estimate.caveat).toMatch(/not a probability/);
        expect(c.assessment.estimate.value).toBeLessThan(0.7);
      }
    }
    expect(report.summary.snippetOnly).toBe(true);
    expect(byStart("Rates were highest").assessment.limitations.join(" ")).toMatch(/snippets/);
  });
  it("records sources with provenance and reliability flags", () => {
    expect(report.sources[1]!.reliability.flags.join(" ")).toMatch(/No publication date/);
    expect(report.sources[2]!.reliability.flags.join(" ")).toMatch(/years ago/);
    expect(report.sources[0]!.provenance[0]!.action).toMatch(/tavily/);
  });
});

describe("model judgements and reviews", () => {
  it("only counts model judgements whose quotes are verbatim in the source", () => {
    const report = runClaimPipeline(
      input({
        mode: "model",
        modelId: "demo:alpha",
        modelJudgements: [
          { claimIndex: 5, sourceIndex: 3, stance: "supports", quote: "Electric cars date to 1832 in this fabricated quote" },
          { claimIndex: 4, sourceIndex: 1, stance: "supports", quote: "Rates were highest among adults aged 40 to 59" },
        ],
      }),
    );
    const ev = report.claims.find((c) => c.index === 5)!;
    expect(ev.evidence.find((l) => l.sourceId === "S3")).toMatchObject({ judgedBy: "model", quoteVerified: false, stance: "insufficient" });
    expect(ev.assessment.status).toBe("insufficient");
    expect(report.replay.events.find((e) => e.step === "model_judgement")?.deterministic).toBe(false);
  });
  it("applies user reviews and keeps the previous judgement", () => {
    const first = runClaimPipeline(input());
    const link = first.claims[0]!.evidence.find((l) => l.sourceId === "S2")!;
    const second = runClaimPipeline({ ...inputFromReport(first), reviews: [{ linkId: link.id, stance: "insufficient", at: NOW }] });
    const l2 = second.claims[0]!.evidence.find((l) => l.id === link.id)!;
    expect(l2).toMatchObject({ judgedBy: "user", stance: "insufficient", rulesStance: "contradicts" });
    expect(second.claims[0]!.assessment.status).toBe("supported");
  });
  it("parses model JSON defensively", () => {
    expect(parseJudgements('```json\n{"judgements":[{"claimIndex":1,"sourceIndex":1,"stance":"supports","quote":"abc def ghi"}]}\n```').judgements).toHaveLength(1);
    expect(parseJudgements("nope").error).toBeTruthy();
    expect(parseHypotheses('{"hypotheses":[{"label":"a","statement":"b","predictions":[{"expectation":"c","test":"d"}]},{"label":"e","statement":"f","predictions":[{"expectation":"g","test":"h"}]}]}')).toHaveLength(2);
  });
});

describe("research replay", () => {
  it("reproduces a rules-mode run exactly from the stored report", () => {
    const original = runClaimPipeline(input());
    const rerun = runClaimPipeline(inputFromReport(original));
    const cmp = compareReplays(original, rerun);
    expect(cmp.reproducible).toBe(true);
    expect(cmp.steps.every((s) => s.outputMatches)).toBe(true);
  });
  it("pinpoints the first divergent step when a source changes", () => {
    const original = runClaimPipeline(input());
    const changed = inputFromReport(original);
    changed.sources[0] = { ...changed.sources[0]!, text: "Completely different text about bicycles and weather patterns in spring." };
    const cmp = compareReplays(original, runClaimPipeline(changed));
    expect(cmp.reproducible).toBe(false);
    expect(cmp.firstDivergence?.step).toBe("source_ingest");
  });
});

describe("hypothesis arena", () => {
  it("refuses to name a leader without enough discriminating tests", () => {
    const arena = { ...newArena("Why did X rise?"), hypotheses: templateHypotheses("Why did X rise?") };
    expect(verdict(arena).leader).toBeNull();
    expect(standings(arena).every((s) => s.standing === "untested")).toBe(true);
  });
  it("names a provisional leader only when rivals are weakened", () => {
    const arena = { ...newArena("q"), hypotheses: templateHypotheses("q") };
    const set = (h: number, p: number, stance: "consistent" | "inconsistent") => {
      const pred = arena.hypotheses[h]!.predictions[p]!;
      pred.evidence.push({ note: "n", stance, addedBy: "user" });
      pred.status = statusFromEvidence(pred.evidence);
    };
    set(0, 0, "consistent");
    set(1, 0, "inconsistent");
    expect(verdict(arena).leader).toBeNull(); // H3 not weakened yet
    set(2, 0, "inconsistent");
    const v = verdict(arena);
    expect(v.leader).toBe("H1");
    expect(v.message).toMatch(/provisional/);
  });
  it("suggests report claims as evidence without applying them", () => {
    const report = runClaimPipeline(input());
    const arena = { ...newArena("obesity"), hypotheses: [{ id: "H1", label: "a", statement: "Adult obesity prevalence is high in the United States", origin: "user" as const, predictions: [{ id: "H1-P1", expectation: "National survey data show high obesity prevalence", test: "x", status: "untested" as const, evidence: [] }] }] };
    const s = suggestEvidence(arena, report);
    expect(s.length).toBeGreaterThan(0);
    expect(arena.hypotheses[0]!.predictions[0]!.evidence).toHaveLength(0);
  });
});
