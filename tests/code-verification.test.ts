/**
 * Task verification without the engine: the task state model, the checklist
 * built from a report's records (timeouts, stale checks, missing output),
 * which checks Orbis plans to run, out-of-order responses on the page, file
 * navigation, and the verification panel as rendered.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { canRerun, fileAction, VerificationPanel } from "@/components/code/verification-panel";
import type { RunReport, RunView } from "@/lib/code/agent/types";
import { assessReport, buildChecklist, checklistOf, isOlderView, nextActions, taskState } from "@/lib/code/agent/verdict";
import { planVerification } from "@/lib/code/agent/verify";

const EDIT = "2026-10-23T10:00:00.000Z";
const AFTER = "2026-10-23T10:05:00.000Z";
const BEFORE = "2026-10-23T09:55:00.000Z";

const tests = (o: Partial<NonNullable<RunReport["tests"]>> = {}): NonNullable<RunReport["tests"]> => ({
  command: "npm test",
  framework: "vitest",
  verdict: "passed",
  exitCode: 0,
  passed: 3,
  failed: 0,
  skipped: 0,
  failures: [],
  durationMs: 900,
  ranAt: AFTER,
  afterLastEdit: true,
  ...o,
});

function report(o: Partial<RunReport> = {}): RunReport {
  return {
    outcome: "completed",
    summary: "Done.",
    unresolved: [],
    files: [{ path: "src/sum.js", change: "modified", added: 1, removed: 1 }],
    commands: [],
    tests: null,
    verification: "not_run",
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0, modelCalls: 1, models: ["Claude Haiku 5.5"], steps: 2, activeMs: 1000 },
    checkpoints: 0,
    createdAt: AFTER,
    testSetup: "npm test",
    ...o,
  };
}

function view(o: Partial<RunView> = {}): RunView {
  return {
    id: "r1",
    projectId: "p1",
    request: "Fix sum",
    status: "completed",
    options: { modelId: null, approvePlans: true, reviewEdits: false, commands: "safe" },
    plan: null,
    pending: null,
    summary: "Fixed it; everything works.",
    error: null,
    steps: 3,
    stepLimit: 20,
    busy: false,
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0, modelCalls: 1, models: [] },
    tokenBudget: 600_000,
    activeMs: 1000,
    timeLimitMs: 1_800_000,
    tests: null,
    checks: { server: null, preview: null, build: null },
    report: report(),
    createdAt: EDIT,
    updatedAt: AFTER,
    version: `${AFTER}|`,
    stepStartedAt: null,
    pair: null,
    ...o,
  };
}

describe("task states", () => {
  it("follows the run's status and evidence, never the agent's summary", () => {
    expect(taskState(view({ status: "running", steps: 0, busy: false, report: null }))).toBe("queued");
    expect(taskState(view({ status: "planning", steps: 0, busy: true, report: null }))).toBe("running");
    expect(taskState(view({ status: "running", steps: 2, report: null }))).toBe("running");
    expect(taskState(view({ status: "awaiting_approval", report: null }))).toBe("waiting");
    expect(taskState(view({ status: "needs_input", report: null }))).toBe("waiting");
    const verify = { summary: "", unresolved: [], queue: [{ check: "tests" as const, command: "npm test" }], attempts: 0, skipped: [], startedAt: "" };
    expect(taskState(view({ status: "running", checks: { server: null, preview: null, build: null, verify }, report: null }))).toBe("verifying");
    expect(taskState(view({ status: "failed" }))).toBe("failed");
    expect(taskState(view({ status: "cancelled" }))).toBe("cancelled");
    // The agent says it works, but nothing ran: not verified.
    expect(taskState(view({ report: report() }))).toBe("unverified");
    expect(taskState(view({ report: report({ tests: tests() }) }))).toBe("verified");
  });

  it("treats a finished run whose record is missing as not verified", () => {
    expect(taskState(view({ report: null }))).toBe("unverified");
  });
});

describe("the checklist", () => {
  it("never shows a check that didn't run as passed", () => {
    const items = checklistOf(report());
    expect(items.find((c) => c.id === "tests")).toMatchObject({ status: "not_run", applicable: true, summary: "Not run (the project's tests run with npm test)" });
    expect(items.filter((c) => c.status === "passed")).toEqual([]);
    expect(assessReport(report())).toEqual({ state: "unverified", reasons: ["No checks ran, so nothing confirms the changes work."] });
  });

  it("reports a test run that timed out as a check that couldn't complete", () => {
    const items = checklistOf(report({ tests: tests({ verdict: "timed_out", exitCode: null, passed: null, failed: null }) }));
    expect(items[0]).toMatchObject({ id: "tests", status: "error", summary: "Timed out" });
    expect(assessReport(report({ tests: tests({ verdict: "timed_out" }) }))).toMatchObject({ state: "warnings", reasons: ["Automated tests couldn't complete."] });
  });

  it("marks checks that ran before the last change as out of date", () => {
    const r = report({ tests: tests({ ranAt: BEFORE, afterLastEdit: false }) });
    expect(checklistOf(r)[0]).toMatchObject({ status: "stale" });
    expect(assessReport(r).reasons).toEqual(["Automated tests ran before the last change, so it doesn't cover the final code."]);
    expect(nextActions(r, "warnings")).toContain("Re-run the checks so they cover the final code.");
  });

  it("keeps a browser inspection apart from tests, and doesn't let it stand in for them", () => {
    const checks: RunReport["checks"] = {
      server: { command: "npm run dev", state: "running", http: 200, at: AFTER, freshness: "current" },
      preview: { path: "/", verdict: "passed", problems: [], warnings: [], checkedAt: AFTER, freshness: "current" },
      build: null,
    };
    const r = report({ checks, web: true });
    const browser = checklistOf(r).find((c) => c.id === "browser")!;
    expect(browser).toMatchObject({ kind: "inspection", status: "passed", label: "Browser inspection" });
    // The project has tests that didn't run, so the page loading isn't enough.
    expect(assessReport(r)).toMatchObject({ state: "warnings", reasons: ["Automated tests didn't run."] });
    expect(nextActions(r, "warnings")).toContain("The browser inspection checks loading and layout, not behaviour: click through the parts you changed.");
  });

  it("carries the reason a check was skipped, and failing output", () => {
    const items = buildChecklist({
      tests: { ...tests({ verdict: "failed", passed: 1, failed: 1, failures: ["sum > adds"], exitCode: 1 }), outputTail: "× sum > adds\nTests 1 failed | 1 passed" },
      checks: undefined,
      testSetup: "npm test",
      web: true,
      skipped: [{ check: "browser", reason: "Not run: the preview server wasn't running." }],
    });
    expect(items.find((c) => c.id === "tests")).toMatchObject({ status: "failed", details: ["sum > adds"], output: "× sum > adds\nTests 1 failed | 1 passed" });
    expect(items.find((c) => c.id === "browser")).toMatchObject({ status: "not_run", summary: "Not run: the preview server wasn't running." });
  });

  it("calls the agent's open problems out even when every check passed", () => {
    expect(assessReport(report({ tests: tests(), unresolved: ["Didn't handle overflow"] }))).toEqual({ state: "warnings", reasons: ["The agent left 1 problem open."] });
  });
});

describe("which checks Orbis runs when the agent finishes", () => {
  const base = {
    options: { commands: "safe" as const, readOnly: false, web: false },
    files: [{ path: "package.json", content: '{"scripts":{"test":"vitest run"}}' }],
    tests: null,
    checks: { server: null, preview: null, build: null },
    lastEditAt: EDIT,
    changedFiles: 1,
    computer: true,
  };

  it("runs the tests when they haven't run since the last change, and not again when they have", () => {
    expect(planVerification(base)).toEqual({ queue: [{ check: "tests", command: "npm test" }], skipped: [] });
    const last = { command: "npm test", framework: null, verdict: "failed" as const, exitCode: 1, passed: 0, failed: 1, skipped: 0, failures: [], durationMs: 1, ranAt: AFTER, outputTail: "" };
    expect(planVerification({ ...base, tests: { last, failuresInRow: 1, attemptLimit: 3, runs: 1 } }).queue).toEqual([]);
  });

  it("checks a website in the browser only when its preview is running", () => {
    const site = { ...base, files: [], options: { ...base.options, web: true } };
    expect(planVerification(site).skipped[0]!.reason).toContain("preview server wasn't running");
    const running = { ...site, checks: { ...base.checks, server: { command: "npm run dev", state: "running" as const, http: 200, at: AFTER } } };
    expect(planVerification(running).queue).toEqual([{ check: "browser", path: "/" }]);
  });

  it("doesn't run commands the session doesn't allow, and says so", () => {
    expect(planVerification({ ...base, options: { ...base.options, commands: "off" } })).toMatchObject({ queue: [], skipped: [{ check: "tests" }] });
    expect(planVerification({ ...base, options: { ...base.options, commands: "ask" } }).skipped[0]!.reason).toContain("needs your approval");
    // Pressing Re-run checks is the approval.
    expect(planVerification({ ...base, options: { ...base.options, commands: "ask" }, rerun: true }).queue).toHaveLength(1);
    expect(planVerification({ ...base, computer: false }).skipped[0]!.reason).toContain("computer was off");
    expect(planVerification({ ...base, changedFiles: 0 })).toEqual({ queue: [], skipped: [] });
  });
});

describe("the page", () => {
  it("ignores a response older than what it already shows for the same run", () => {
    expect(isOlderView(view({ updatedAt: AFTER }), view({ updatedAt: BEFORE }))).toBe(true);
    expect(isOlderView(view({ updatedAt: BEFORE }), view({ updatedAt: AFTER }))).toBe(false);
    expect(isOlderView(view({ id: "a", updatedAt: AFTER }), view({ id: "b", updatedAt: BEFORE }))).toBe(false);
    expect(isOlderView(null, view())).toBe(false);
  });

  it("opens a changed file, and shows the changes for a deleted one", () => {
    expect(fileAction({ path: "src/a.js", change: "modified", added: 1, removed: 0 })).toEqual({ kind: "open", path: "src/a.js" });
    expect(fileAction({ path: "src/new.js", change: "created", added: 4, removed: 0 })).toEqual({ kind: "open", path: "src/new.js" });
    expect(fileAction({ path: "old.js", change: "deleted", added: 0, removed: 9 })).toEqual({ kind: "review" });
  });

  it("offers Re-run checks only when there's something Orbis can check", () => {
    expect(canRerun(report())).toBe(true);
    expect(canRerun(report({ testSetup: null }))).toBe(false);
  });

  it("offers Try again when a task failed, with the error, and not when it finished", () => {
    const props = { onShowChanges: () => {}, onOpenFile: () => {}, onRerun: async () => {}, onUndo: async () => {}, onRetry: () => {} };
    const failed = renderToStaticMarkup(
      createElement(VerificationPanel, { ...props, run: view({ status: "failed", error: "The AI provider rejected the request.", report: report({ outcome: "failed" }) }) }),
    );
    expect(failed).toContain("Failed");
    expect(failed).toContain("The AI provider rejected the request.");
    expect(failed).toContain("Try again");
    expect(renderToStaticMarkup(createElement(VerificationPanel, { ...props, run: view() }))).not.toContain("Try again");
  });

  it("renders the verdict, the task, the agent's words labelled as such, every check with its status in words, and Review changes", () => {
    const html = renderToStaticMarkup(
      createElement(VerificationPanel, {
        run: view({ report: report({ tests: tests({ verdict: "failed", passed: 2, failed: 1, failures: ["sum > adds negatives"] }) }) }),
        onShowChanges: () => {},
        onOpenFile: () => {},
        onRerun: async () => {},
        onUndo: async () => {},
      }),
    );
    expect(html).toContain("Done, with warnings");
    expect(html).toContain("Automated tests failed.");
    expect(html).toContain("Fix sum");
    expect(html).toContain("What the agent says it did");
    expect(html).toContain("Failed");
    expect(html).toContain("sum &gt; adds negatives");
    expect(html).toContain("Review changes");
    expect(html).toContain("Re-run checks");
    expect(html).toContain('title="Open src/sum.js"');
    const none = renderToStaticMarkup(createElement(VerificationPanel, { run: view(), onShowChanges: () => {}, onOpenFile: () => {}, onRerun: async () => {}, onUndo: async () => {} }));
    expect(none).toContain("Done, not verified");
    expect(none).toContain("Not run");
    expect(none).toContain("No checks ran, so nothing confirms these changes work.");
    expect(none).not.toContain(">Passed<");
  });
});
