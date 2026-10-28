/**
 * Updates on background work: which coding-task changes become an update (and their wording and link), the emails
 * for them, which new updates raise a browser alert, links kept inside Orbis, and the sentence shown before a
 * costly task starts.
 */
import { describe, expect, it, vi } from "vitest";
import { runNotice } from "@/lib/code/agent/notify";
import { customerEmail } from "@/lib/email";
import { safeHref } from "@/lib/inbox";
import { estimateText } from "@/components/studio/usage";
import { freshUpdates } from "@/components/studio/inbox";

vi.mock("server-only", () => ({}));

const run = (o: Record<string, unknown> = {}) =>
  ({ id: "r1", project_id: "p1", request: "Add a   contact form\nwith validation", status: "completed", steps: 7, summary: "Added the form.", error: null, pending: null, ...o }) as Parameters<typeof runNotice>[0];

describe("which task changes become an update", () => {
  it("finished, stopped and waiting do; working states don't", () => {
    expect(runNotice(run())).toEqual({ kind: "task_done", key: "code_run:r1:completed:7", title: "Add a contact form with validation", body: "Added the form.", href: "/code/p1?run=r1" });
    expect(runNotice(run({ status: "failed", error: "The model provider is down." }))).toMatchObject({ kind: "task_failed", body: "The model provider is down." });
    expect(runNotice(run({ status: "awaiting_approval", pending: { kind: "command" } }))).toMatchObject({ kind: "task_waiting", body: "Approve a command", key: "code_run:r1:awaiting_approval:7" });
    expect(runNotice(run({ status: "needs_input", pending: { kind: "question" } }))).toMatchObject({ kind: "task_waiting", body: "Answer a question" });
    for (const status of ["running", "planning", "cancelled"]) expect(runNotice(run({ status }))).toBeNull();
  });
  it("waiting again at a later step is a new update; the same step isn't", () => {
    const a = runNotice(run({ status: "awaiting_approval", steps: 3 }))!;
    expect(runNotice(run({ status: "awaiting_approval", steps: 3 }))!.key).toBe(a.key);
    expect(runNotice(run({ status: "awaiting_approval", steps: 4 }))!.key).not.toBe(a.key);
  });
});

describe("task emails", () => {
  it("say what happened, link to the task on Orbis and how to turn them off", () => {
    const done = customerEmail("task_done", { task: "Add a contact form", detail: "Added the form.", path: "/code/p1?run=r1" });
    expect(done.subject).toBe("Done: Add a contact form");
    expect(done.text).toContain("“Add a contact form”");
    expect(done.text).toContain("https://tryorbis.app/code/p1?run=r1");
    expect(done.text).toContain("Settings → Notifications");
    expect(customerEmail("task_waiting", { task: "x" }).subject).toBe("Needs you: x");
    expect(customerEmail("task_failed", { task: "x" }).subject).toBe("Stopped: x");
  });
  it("never link off Orbis, whatever path they're given", () => {
    for (const path of ["//evil.example/x", "https://evil.example", "javascript:alert(1)"]) expect(customerEmail("task_done", { task: "x", path }).text).toContain("https://tryorbis.app/activity");
  });
  it("keep a long task on one short line", () => {
    const e = customerEmail("task_done", { task: "a\n".repeat(400) });
    expect(e.subject.length).toBeLessThanOrEqual(140);
    expect(e.text).not.toMatch(/a\na/);
  });
});

describe("links in updates", () => {
  it("only paths inside Orbis", () => {
    expect(safeHref("/code/p1?run=r1")).toBe("/code/p1?run=r1");
    for (const h of ["https://evil.example", "//evil.example", "/x//evil", "javascript:alert(1)", "", null, undefined]) expect(safeHref(h)).toBeNull();
  });
});

describe("browser alerts", () => {
  const item = (id: number, read = false) => ({ id, kind: "task_done" as const, title: "t", body: null, href: null, createdAt: "", read });
  it("alert only for updates newer than the last read, never on the first read", () => {
    expect(freshUpdates([item(5), item(4)], null)).toEqual([]);
    expect(freshUpdates([item(7), item(6, true), item(5)], 5).map((i) => i.id)).toEqual([7]);
  });
});

describe("the line before a costly task", () => {
  const base = { unlimited: false, label: "research run", weekLeftPct: 62, windowUsedPct: null, estimate: null };
  it("says what one usually uses, from the user's own runs or everyone's", () => {
    expect(estimateText({ ...base, estimate: { typicalPct: 5, lowPct: 3, highPct: 8, runs: 4, source: "you" } })).toEqual({
      line: "A research run usually uses about 5% of your week (3–8% across your last 4). 62% of your week is left.",
      warn: false,
    });
    expect(estimateText({ ...base, estimate: { typicalPct: 5, lowPct: 5, highPct: 5, runs: 6, source: "everyone" } })!.line).toBe(
      "A research run usually uses about 5% of your week (going by recent runs on Orbis). 62% of your week is left.",
    );
  });
  it("warns when a typical run may not fit in what's left, or the session is nearly used", () => {
    expect(estimateText({ ...base, weekLeftPct: 4, estimate: { typicalPct: 5, lowPct: 3, highPct: 8, runs: 4, source: "you" } })).toMatchObject({ warn: true, line: expect.stringContaining("That may be more than you have left.") });
    expect(estimateText({ ...base, windowUsedPct: 85 })!.line).toContain("Your 5-hour session is 85% used.");
  });
  it("is honest without history, and says nothing for accounts without limits", () => {
    expect(estimateText(base)!.line).toBe("What this research run uses is counted as it runs. 62% of your week is left.");
    expect(estimateText({ ...base, weekLeftPct: 0 })).toMatchObject({ warn: true, line: expect.stringContaining("used up") });
    expect(estimateText({ ...base, unlimited: true })).toBeNull();
    expect(estimateText(null)).toBeNull();
  });
});
