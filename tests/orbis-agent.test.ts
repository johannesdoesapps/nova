/**
 * The Orbis Agent in chat: when delegation is offered, how a proposed task is
 * read out of a reply (and refused when it names an unavailable agent,
 * someone else's project or bad input), and the Activity list that answers
 * "what's still running?" from the tasks' own records.
 */
import { describe, expect, it } from "vitest";
import { fromCodeRun, fromResearch, fromReview, mergeActivity, openTasksSummary } from "@/lib/agent-platform/activity";
import { asksAboutTasks, delegationPrompt, DELEGABLE, extractTask, stripTaskBlock, wantsDelegation } from "@/lib/agent-platform/delegation";

const P1 = "00000000-0000-4000-8000-0000000000a1";
const projects = [{ id: P1, name: "Shop" }];
const all = { available: [...DELEGABLE], projects };
const reply = (block: unknown) => `I'll hand this to Bug Fixing.\n\n\`\`\`orbis-task\n${typeof block === "string" ? block : JSON.stringify(block)}\n\`\`\``;
let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

describe("when the Orbis Agent offers delegation", () => {
  it("for work a specialist does", () => {
    for (const m of [
      "Fix the checkout bug in my shop",
      "Write unit tests for src/cart.js",
      "Review my pull request",
      "Research the best Postgres hosting",
      "TypeError: x is undefined at cart.js:12",
      "Refactor the auth module",
    ])
      expect(wantsDelegation(m), m).toBe(true);
    for (const m of ["Hi!", "Write me a poem about autumn", "What's the capital of Peru?"]) expect(wantsDelegation(m), m).toBe(false);
  });

  it("for questions about tasks", () => {
    expect(asksAboutTasks("What tasks are still running?")).toBe(true);
    expect(asksAboutTasks("Is my bug fix done yet?")).toBe(true);
    expect(asksAboutTasks("Tell me a joke")).toBe(false);
  });

  it("lists only the agents this user can start, and fences project names as data", () => {
    const p = delegationPrompt(["bug_fixer", "code_review"], [{ id: P1, name: "Shop <script>" }]);
    expect(p).toContain('"bug_fixer"');
    expect(p).toContain('"code_review"');
    expect(p).not.toContain('"deep_research"');
    expect(p).toContain(`${P1}: Shop script`);
    expect(p).toMatch(/never say a task is running, done, fixed or tested/);
    expect(delegationPrompt([], projects)).toBe("");
  });
});

describe("reading a proposed task out of a reply", () => {
  it("a valid proposal becomes a card and the block leaves the text", () => {
    const r = extractTask(reply({ agent: "bug_fixer", projectId: P1, input: { summary: "Discount total is wrong", logs: "TypeError" } }), all, id);
    expect(r.text).toBe("I'll hand this to Bug Fixing.");
    expect(r.proposal).toMatchObject({
      agent: "bug_fixer",
      agentName: "Bug Fixing",
      projectId: P1,
      projectName: "Shop",
      status: "proposed",
      input: { summary: "Discount total is wrong", logs: "TypeError", details: "" },
    });
  });

  it("research needs no project; review takes a project or a GitHub link", () => {
    expect(extractTask(reply({ agent: "deep_research", projectId: null, input: { question: "Compare Neon and Supabase free tiers" } }), all, id).proposal).toMatchObject({
      agent: "deep_research",
      input: { depth: "quick" },
    });
    expect(extractTask(reply({ agent: "code_review", input: { url: "https://github.com/a/b/pull/3" } }), all, id).proposal).toMatchObject({ agent: "code_review", projectId: null });
    expect(extractTask(reply({ agent: "code_review", input: {} }), all, id).proposal).toBeNull();
  });

  it("refuses agents the user can't start here", () => {
    const r = extractTask(reply({ agent: "deep_research", input: { question: "Compare Neon and Supabase" } }), { ...all, available: ["bug_fixer"] }, id);
    expect(r.proposal).toBeNull();
    expect(r.text).toMatch(/isn't available to you here\. Nothing was prepared\./);
    expect(extractTask(reply({ agent: "deploy_to_prod", input: {} }), all, id).proposal).toBeNull();
  });

  it("refuses a project that isn't the user's, or a missing one", () => {
    expect(extractTask(reply({ agent: "bug_fixer", projectId: "00000000-0000-4000-8000-0000000000ff", input: { summary: "Broken" } }), all, id).text).toMatch(/isn't one of yours/);
    expect(extractTask(reply({ agent: "qa_tester", projectId: null, input: { scope: "cart totals" } }), all, id).text).toMatch(/needs one of your Orbis projects/);
  });

  it("refuses incomplete or unreadable input", () => {
    expect(extractTask(reply({ agent: "bug_fixer", projectId: P1, input: { summary: "" } }), all, id).text).toMatch(/was incomplete \(summary/);
    expect(extractTask(reply("{not json"), all, id).text).toMatch(/couldn't be read/);
  });

  it("a reply without a block is left alone; a stray block is removed when delegation wasn't offered", () => {
    expect(extractTask("Just an answer.", all, id)).toEqual({ text: "Just an answer.", proposal: null });
    expect(stripTaskBlock(reply({ agent: "bug_fixer" }))).toBe("I'll hand this to Bug Fixing.");
    expect(stripTaskBlock("plain")).toBe("plain");
  });
});

describe("activity across agents", () => {
  const T = (m: number) => new Date(Date.UTC(2026, 9, 24, 10, m)).toISOString();
  const run = fromCodeRun({
    id: "r1",
    project_id: P1,
    request: "Fix this bug: Discount total is wrong\n\nDetails: …",
    status: "awaiting_approval",
    options: { agent: "bug_fixer" },
    pending: { kind: "plan" },
    error: null,
    report: null,
    created_at: T(0),
    updated_at: T(5),
    project: { name: "Shop" },
  });
  const done = fromCodeRun({
    id: "r2",
    project_id: P1,
    request: "Add a footer",
    status: "completed",
    options: { web: true },
    pending: null,
    error: null,
    report: { verification: "passed", files: [{}, {}] },
    created_at: T(0),
    updated_at: T(1),
  });
  const review = fromReview({
    id: "v1",
    title: "PR #3",
    status: "completed",
    error: null,
    findings: [
      { severity: "high", status: "open" },
      { severity: "low", status: "dismissed" },
    ],
    created_at: T(0),
    updated_at: T(3),
  });
  const research = fromResearch({ id: "s1", question: "Compare Neon and Supabase", status: "running", phase: "researching", error: null, created_at: T(0), updated_at: T(4) });

  it("maps each kind of task to one set of statuses, with its own page", () => {
    expect(run).toMatchObject({
      agent: "bug_fixer",
      status: "awaiting_approval",
      detail: "Approve the plan",
      href: `/code/${P1}?run=r1`,
      title: "Fix this bug: Discount total is wrong",
      projectName: "Shop",
    });
    expect(done).toMatchObject({ agent: "website_builder", status: "completed", detail: "2 files changed · tests passed" });
    expect(review).toMatchObject({ agent: "code_review", status: "completed", detail: "1 open finding", href: "/review/v1" });
    expect(research).toMatchObject({ agent: "deep_research", status: "running", detail: "Searching the web", href: "/research/s1" });
  });

  it("newest activity first, and a summary of open tasks for the Orbis Agent", () => {
    const items = mergeActivity([done, run], [review], [research]);
    expect(items.map((i) => i.id)).toEqual(["r1", "s1", "v1", "r2"]);
    const s = openTasksSummary(items, { bug_fixer: "Bug Fixing", deep_research: "Deep Research", code_review: "Code Review", website_builder: "Website Builder" });
    expect(s).toMatch(/^<user_tasks>\nOpen tasks \(2\):/);
    expect(s).toContain('[Bug Fixing] "Fix this bug: Discount total is wrong" — Waiting for you (Approve the plan) · project Shop');
    expect(s).toContain("Recently finished:");
    expect(s.trim().endsWith("</user_tasks>")).toBe(true);
    expect(openTasksSummary([], {})).toContain("No open tasks.");
  });
});
