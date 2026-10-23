/**
 * Pair coding's rules without any model: replies must match the formats (findings need evidence),
 * reviews open, close and dispute findings, the loop ends at the bar, the round limit or when the
 * agents stop making progress, and the prompts give each agent its own role.
 */
import { describe, expect, it } from "vitest";
import {
  afterReview,
  applyResponses,
  applyReview,
  askText,
  checkPaths,
  codeSchema,
  extractJson,
  filesBlock,
  messagesFor,
  newPairState,
  parseReply,
  planSchema,
  reviewSchema,
  type PairState,
  type Review,
} from "@/lib/code/pair/protocol";

const settings = { architect: null, reviewer: null, maxRounds: 3, approvePlan: false, runTests: true };
const review = (o: Partial<Review> = {}): Review => ({ verdict: "changes_requested", summary: "Needs work.", findings: [], resolved: [], stillOpen: [], testAssessment: "", ...o });
const finding = (o: Partial<Review["findings"][number]> = {}) => ({
  severity: "major" as const,
  category: "correctness" as const,
  file: "sum.js",
  line: 1,
  title: "sum subtracts",
  evidence: "`return a - b` on line 1",
  suggestion: "Use a + b",
  ...o,
});

describe("structured replies", () => {
  it("reads JSON with or without a fence, and says why when it can't", () => {
    expect(extractJson('Here:\n```json\n{"a": 1}\n```')).toEqual({ ok: true, value: { a: 1 } });
    expect(extractJson('{"a": {"b": 2}} trailing')).toEqual({ ok: true, value: { a: { b: 2 } } });
    expect(extractJson("no json")).toMatchObject({ ok: false });
    expect(extractJson('{"a": }')).toMatchObject({ ok: false, error: expect.stringContaining("couldn't be read") });
  });

  it("checks each agent's format, and refuses a finding without evidence", () => {
    expect(parseReply(planSchema, '{"summary": "A todo app"}')).toMatchObject({ ok: true, data: { summary: "A todo app", files: [], testCommand: null } });
    expect(parseReply(codeSchema, '{"files": [{"path": "a.js", "content": "x"}], "responses": [{"id": "F1", "decision": "maybe", "reason": "hmm hmm"}]}')).toMatchObject({ ok: false });
    expect(parseReply(codeSchema, '{"responses": [{"id": "F1", "decision": "reject", "reason": ""}]}')).toMatchObject({ ok: false });
    const noEvidence = JSON.stringify(review({ findings: [{ ...finding(), evidence: "" }] }));
    expect(parseReply(reviewSchema, noEvidence)).toMatchObject({ ok: false, error: expect.stringContaining("evidence") });
    expect(parseReply(reviewSchema, JSON.stringify(review({ findings: [finding()] })))).toMatchObject({ ok: true });
  });
});

describe("the review loop", () => {
  it("numbers new findings, closes the ones verified fixed, and keeps disputed rejections open", () => {
    let s: PairState = newPairState(settings);
    s = applyReview(s, review({ findings: [finding(), finding({ title: "no input check", severity: "minor" }), finding({ title: "uses var", severity: "nit" })] })).state;
    expect(s.findings.map((f) => [f.id, f.status])).toEqual([
      ["F1", "open"],
      ["F2", "open"],
      ["F3", "open"],
    ]);
    s = applyResponses(s, [
      { id: "F1", decision: "accept", reason: "Right, fixed the operator." },
      { id: "F2", decision: "reject", reason: "Inputs are validated by the caller in api.js line 4." },
      { id: "F3", decision: "reject", reason: "The project's style uses var throughout." },
    ]);
    // Round 2: F1 verified fixed; F2's rejection disputed; F3's rejection accepted (not listed).
    const r = applyReview(s, review({ verdict: "changes_requested", resolved: ["F1"], stillOpen: ["F2"] }));
    s = r.state;
    expect(s.findings.map((f) => [f.id, f.status])).toEqual([
      ["F1", "fixed"],
      ["F2", "open"],
      ["F3", "rejected"],
    ]);
    expect(r.round).toMatchObject({ round: 2, resolved: 2, open: 1, blocking: 0 });
  });

  it("finishes when the Reviewer approves with nothing blocking open and the latest tests passing", () => {
    let s = applyReview(newPairState(settings), review({ verdict: "approve", findings: [finding({ severity: "minor" })] })).state;
    expect(afterReview(s, "approve")).toEqual({ next: "final" });
    s = applyReview(newPairState(settings), review({ verdict: "approve", findings: [finding()] })).state;
    expect(afterReview(s, "approve")).toEqual({ next: "revise" });
    // Approval doesn't override failing tests from this round.
    const failing: PairState = { ...applyReview(newPairState(settings), review({ verdict: "approve" })).state };
    failing.tests = [{ command: "npm test", round: 1, exitCode: 1, passed: false, outputTail: "1 failed", ranAt: "" }];
    expect(afterReview(failing, "approve")).toEqual({ next: "revise" });
  });

  it("asks the user when the rounds are used up, and stops early when nothing blocking gets fixed twice in a row", () => {
    let s = newPairState({ ...settings, maxRounds: 5 });
    s = applyReview(s, review({ findings: [finding()] })).state;
    expect(afterReview(s, "changes_requested")).toEqual({ next: "revise" });
    s = applyReview(s, review({ stillOpen: ["F1"] })).state;
    expect(s.stalled).toBe(1);
    s = applyReview(s, review({ stillOpen: ["F1"] })).state;
    expect(s.stalled).toBe(2);
    expect(afterReview(s, "changes_requested")).toEqual({ next: "ask", why: "stalled" });
    expect(askText(s, "stalled").question).toContain("stopped instead of trying the same thing again");
    // Progress resets it.
    s = applyReview(s, review({ resolved: ["F1"] })).state;
    expect(s.stalled).toBe(0);
    const capped = applyReview(newPairState({ ...settings, maxRounds: 1 }), review({ findings: [finding()] })).state;
    expect(afterReview(capped, "changes_requested")).toEqual({ next: "ask", why: "rounds" });
    expect(askText(capped, "rounds").options).toEqual(["Accept the result as it is", "One more round"]);
  });

  it("keeps the number of rounds between 1 and 5", () => {
    expect(newPairState({ ...settings, maxRounds: 99 }).settings.maxRounds).toBe(5);
    expect(newPairState({ ...settings, maxRounds: 0 }).settings.maxRounds).toBe(2);
  });
});

describe("prompts and files", () => {
  const ctx = {
    request: "Build a todo API",
    projectName: "Todo",
    files: [
      { path: "a.js", content: "x" },
      { path: ".env", content: "KEY=secret" },
    ],
    isSecret: (p: string) => p === ".env",
  };

  it("gives each agent its own role and the other's work to answer, and never shows secret files", () => {
    let s = newPairState(settings);
    const plan = messagesFor("plan", s, ctx);
    expect(plan[0]!.content).toContain("You are the Architect");
    expect(plan[1]!.content).not.toContain("KEY=secret");
    s = applyReview(s, review({ findings: [finding()] })).state;
    const rev = messagesFor("review", s, ctx);
    expect(rev[0]!.content).toContain("You are the Reviewer");
    expect(rev[0]!.content).toContain("No evidence, no finding");
    expect(rev[1]!.content).toContain("F1 [major, correctness] sum subtracts");
    const fix = messagesFor("revise", { ...s, notes: [{ at: "", text: "Use TypeScript", used: false }] }, ctx);
    expect(fix[1]!.content).toContain("Use TypeScript");
    expect(fix[1]!.content).toContain("every one needs a response");
  });

  it("puts the files that matter first and says which didn't fit", () => {
    const files = [
      { path: "big.txt", content: "y".repeat(500) },
      { path: "main.js", content: "z" },
    ];
    const b = filesBlock(files, ["main.js"], 100);
    expect(b.indexOf("--- main.js")).toBe(0);
    expect(b).toContain("Not shown (over the size budget): big.txt");
  });

  it("refuses paths outside the project and secret files", () => {
    const valid = (p: string) => !p.startsWith("/") && !p.includes("\\");
    expect(checkPaths(["src/a.js", "../etc/passwd", "/abs", "a/./b", ".env"], valid, (p) => p === ".env")).toEqual({
      ok: ["src/a.js"],
      rejected: [
        { path: "../etc/passwd", why: "not a plain path inside the project" },
        { path: "/abs", why: "not a plain path inside the project" },
        { path: "a/./b", why: "not a plain path inside the project" },
        { path: ".env", why: "secret files (like .env) can't be written by the agents" },
      ],
    });
  });
});
