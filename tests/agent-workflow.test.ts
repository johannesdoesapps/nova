/**
 * Multi-agent workflows (Fix and verify) as a dependency graph: the template's
 * graph is valid; steps start when what they depend on has finished; QA
 * Testing and Code Review run side by side after the fix while two steps that
 * edit the project never run at once; a failure stops new steps but lets
 * running ones finish; bounded retries and skipping only optional steps; the
 * approval gate; cancelling and timing out stop every running step; and task
 * records are read into step outcomes.
 */
import { describe, expect, it } from "vitest";
import {
  cancel,
  changedBefore,
  childFromReview,
  childFromRun,
  decide,
  expired,
  failedStep,
  MAX_ATTEMPTS,
  newSteps,
  nextToDrive,
  observe,
  recover,
  recoveries,
  regressionTests,
  reviewTaskIds,
  runnable,
  started,
  startFailed,
  templateProblems,
  TEMPLATE_INFO,
  timeOut,
  workflowInput,
  WORKFLOW_TTL_MS,
  type StepDef,
  type WorkflowState,
} from "@/lib/agent-platform/workflow";
import { stepState } from "@/lib/agent-platform/protocol";

const AT = "2026-10-24T10:00:00.000Z";
const LATER = "2026-10-24T10:05:00.000Z";
const fresh = (): WorkflowState => ({ status: "running", current: 0, steps: newSteps("fix_and_verify"), log: [], error: null });
const done = (files: string[]) => ({ state: "done" as const, summary: `${files.length} files changed; tests passed after the last change.`, changedFiles: files });
const status = (w: WorkflowState) => Object.fromEntries(w.steps.map((s) => [s.key, s.status]));

/** The fix done, then QA and review started side by side. */
function afterFix(): WorkflowState {
  let w = started(fresh(), "fix", "fix-1", AT);
  w = observe(w, "fix", done(["src/cart.js"]), AT);
  for (const s of runnable(w)) w = started(w, s.key, `${s.key}-1`, AT);
  return w;
}

function toApproval(): WorkflowState {
  let w = afterFix();
  w = observe(w, "test", done(["tests/cart.test.js"]), AT);
  return observe(w, "review", { state: "done", summary: "No findings.", changedFiles: [] }, AT);
}

describe("the Fix and verify graph", () => {
  it("is a valid graph: fix, then tests and review side by side, then the user's decision", () => {
    const steps = TEMPLATE_INFO.fix_and_verify.steps;
    expect(templateProblems(steps)).toEqual([]);
    expect(steps.map((s) => [s.key, s.agent, s.dependsOn, s.writes])).toEqual([
      ["fix", "bug_fixer", [], "project"],
      ["test", "qa_tester", ["fix"], "project"],
      ["review", "code_review", ["fix"], null],
      ["approve", null, ["test", "review"], null],
    ]);
  });

  it("catches broken graphs: unknown or later dependencies, no approval, steps not before it", () => {
    const base = TEMPLATE_INFO.fix_and_verify.steps;
    const bad: StepDef[] = [{ ...base[1]!, dependsOn: ["review"] }, base[2]!, base[0]!];
    expect(templateProblems(bad).join("; ")).toMatch(/test depends on review, which isn't an earlier step/);
    expect(templateProblems(bad).join("; ")).toMatch(/exactly one approval/);
    const orphan: StepDef[] = [base[0]!, base[1]!, { ...base[3]!, dependsOn: ["fix"] }];
    expect(templateProblems(orphan)).toContain("test isn't before the approval");
  });

  it("only the fix is required", () => {
    expect(TEMPLATE_INFO.fix_and_verify.steps.filter((s) => s.optional).map((s) => s.key)).toEqual(["test", "review"]);
  });

  it("validates the start form", () => {
    expect(workflowInput.safeParse({ template: "fix_and_verify", projectId: "00000000-0000-4000-8000-000000000001", bug: { summary: "Total wrong" } }).success).toBe(true);
    expect(workflowInput.safeParse({ template: "deploy_everything", projectId: "00000000-0000-4000-8000-000000000001", bug: { summary: "x y z" } }).success).toBe(false);
    expect(workflowInput.safeParse({ template: "fix_and_verify", projectId: "00000000-0000-4000-8000-000000000001", bug: { summary: "Total" }, options: { commands: "off" } }).success).toBe(false);
  });
});

describe("dependencies and running side by side", () => {
  it("at first only the fix is ready; the rest wait for it", () => {
    const w = fresh();
    expect(status(w)).toEqual({ fix: "ready", test: "pending", review: "pending", approve: "pending" });
    expect(runnable(w).map((s) => s.key)).toEqual(["fix"]);
    expect(w.steps.map(stepState)).toEqual(["ready", "waiting_dependency", "waiting_dependency", "waiting_dependency"]);
  });

  it("when the fix is done, tests and review start together", () => {
    let w = started(fresh(), "fix", "fix-1", AT);
    expect(runnable(w)).toEqual([]);
    w = observe(w, "fix", done(["src/cart.js"]), AT);
    expect(runnable(w).map((s) => s.key)).toEqual(["test", "review"]);
    w = afterFix();
    expect(status(w)).toMatchObject({ test: "running", review: "running", approve: "pending" });
    expect(w.status).toBe("running");
  });

  it("two steps that edit the project never run at the same time; a read-only step runs alongside", () => {
    const w = afterFix();
    // Pretend another editing step were ready: it must wait while QA (which edits) runs.
    const withExtra: WorkflowState = { ...w, steps: [...w.steps, { ...w.steps[1]!, key: "fix", status: "ready", taskId: null } as never] };
    expect(runnable(withExtra)).toEqual([]);
    // From scratch, two ready editing steps: only one is chosen per pass.
    const both: WorkflowState = { ...fresh(), steps: fresh().steps.map((s) => (s.key === "test" ? { ...s, status: "ready" as const } : s)) };
    expect(runnable(both).map((s) => s.key)).toEqual(["fix"]);
  });

  it("the decision waits for both; it's offered only when both have finished", () => {
    let w = afterFix();
    w = observe(w, "review", { state: "done", summary: "No findings.", changedFiles: [] }, AT);
    expect(w.status).toBe("running");
    expect(status(w).approve).toBe("pending");
    w = observe(w, "test", done(["tests/cart.test.js"]), AT);
    expect(w.status).toBe("needs_approval");
    expect(status(w)).toEqual({ fix: "done", test: "done", review: "done", approve: "waiting" });
    expect(w.log.at(-1)!.text).toBe("Ready for your decision.");
  });

  it("running steps take turns: the one moved on longest ago goes next", () => {
    let w = afterFix();
    w = observe(w, "test", { state: "working" }, LATER);
    expect(nextToDrive(w)!.key).toBe("review");
  });

  it("a fix that changed nothing skips tests and review and goes to the decision", () => {
    let w = started(fresh(), "fix", "fix-1", AT);
    w = observe(w, "fix", done([]), AT);
    expect(w.status).toBe("needs_approval");
    expect(status(w)).toEqual({ fix: "done", test: "skipped", review: "skipped", approve: "waiting" });
  });

  it("each step is given what the steps before it changed", () => {
    const w = afterFix();
    expect(changedBefore(w, "test")).toEqual(["src/cart.js"]);
    expect(reviewTaskIds(w)).toEqual(["fix-1"]);
  });
});

describe("waiting, failing and recovering", () => {
  it("a task waiting for the user makes the workflow wait; working again resumes it", () => {
    let w = started(fresh(), "fix", "fix-1", AT);
    w = observe(w, "fix", { state: "waiting", reason: "approve the plan" }, AT);
    expect(w.status).toBe("waiting");
    expect(w.log.at(-1)!.text).toMatch(/approve the plan/);
    w = observe(w, "fix", { state: "working" }, AT);
    expect(w.status).toBe("running");
  });

  it("a failed step stops new steps, but a step already running finishes first", () => {
    let w = afterFix();
    w = observe(w, "test", { state: "failed", error: "The model provider is unavailable." }, AT);
    expect(w.status).toBe("running"); // review is still running
    expect(w.error).toBe("Add regression tests and run them: The model provider is unavailable.");
    expect(runnable(w)).toEqual([]);
    expect(recoveries(w)).toEqual([]); // not until the review ends
    w = observe(w, "review", { state: "done", summary: "No findings.", changedFiles: [] }, AT);
    expect(w.status).toBe("failed");
    expect(failedStep(w)!.key).toBe("test");
    expect(recoveries(w)).toEqual(["retry", "skip"]);
  });

  it("couldn't start a step (quota, a busy project): it fails without a task", () => {
    const w = startFailed(fresh(), "fix", "Your usage limit is reached.", AT);
    expect(w.status).toBe("failed");
    expect(w.steps[0]).toMatchObject({ status: "failed", taskId: null, attempts: 1, error: "Your usage limit is reached." });
  });

  it("a required step can be retried but not skipped, and retries are bounded", () => {
    const failed = startFailed(fresh(), "fix", "x", AT);
    expect(recoveries(failed)).toEqual(["retry"]);
    expect(recover(failed, "skip", AT)).toBeNull();
    const again = recover(failed, "retry", AT)!;
    expect(again.status).toBe("running");
    expect(runnable(again).map((s) => s.key)).toEqual(["fix"]);
    const exhausted: WorkflowState = { ...failed, steps: failed.steps.map((s) => (s.key === "fix" ? { ...s, attempts: MAX_ATTEMPTS } : s)) };
    expect(recoveries(exhausted)).toEqual([]);
    expect(recover(exhausted, "retry", AT)).toBeNull();
  });

  it("skipping a failed optional step lets the workflow go on to the decision", () => {
    let w = afterFix();
    w = observe(w, "review", { state: "done", summary: "No findings.", changedFiles: [] }, AT);
    w = observe(w, "test", { state: "failed", error: "x" }, AT);
    const skipped = recover(w, "skip", AT, "test")!;
    expect(status(skipped)).toEqual({ fix: "done", test: "skipped", review: "done", approve: "waiting" });
    expect(skipped.status).toBe("needs_approval");
  });

  it("observations are ignored once the workflow has ended or for a step that isn't running", () => {
    const ended = { ...fresh(), status: "completed" as const };
    expect(observe(ended, "fix", done(["a"]), AT)).toBe(ended);
    const notStarted = fresh();
    expect(observe(notStarted, "fix", done(["a"]), AT)).toBe(notStarted);
  });
});

describe("the approval gate", () => {
  it("records the decision only when the workflow is waiting for it", () => {
    const w = decide(toApproval(), "approve", AT)!;
    expect(w.status).toBe("completed");
    expect(w.steps[3]!.summary).toBe("Approved");
    expect(decide(w, "reject", AT)).toBeNull();
    expect(decide(started(fresh(), "fix", "fix-1", AT), "approve", AT)).toBeNull();
    expect(decide(toApproval(), "reject", AT)!.steps[3]!.summary).toMatch(/undone/);
  });
});

describe("cancelling and timing out", () => {
  it("cancelling stops every step still open, once", () => {
    const w = cancel(afterFix(), AT)!;
    expect(w.status).toBe("cancelled");
    expect(status(w)).toEqual({ fix: "done", test: "cancelled", review: "cancelled", approve: "cancelled" });
    expect(w.steps[1]!.error).toBe("Stopped by you.");
    expect(cancel(w, AT)).toBeNull();
  });

  it("a workflow older than a day expires and is stopped with the reason", () => {
    const now = Date.parse(AT);
    expect(expired(new Date(now - WORKFLOW_TTL_MS - 1).toISOString(), now)).toBe(true);
    expect(expired(new Date(now - 60_000).toISOString(), now)).toBe(false);
    const t = timeOut(afterFix(), AT)!;
    expect(t.status).toBe("failed");
    expect(t.error).toMatch(/more than 24 hours/);
    expect(status(t)).toMatchObject({ test: "cancelled", review: "cancelled" });
  });
});

describe("what each step is given", () => {
  it("QA writes regression tests for the files the fix changed", () => {
    const qa = regressionTests({ summary: "Discount total wrong", details: "", logs: "", reproduce: "", expected: "10% off the subtotal" }, ["src/cart.js"]);
    expect(qa.scope).toMatch(/Discount total wrong.*src\/cart\.js.*fail on the old behaviour/);
    expect(qa.notes).toBe("Expected behaviour: 10% off the subtotal");
    expect(qa.kinds).toEqual(["unit"]);
  });
});

describe("reading task records", () => {
  const run = (st: string, extra: Partial<Parameters<typeof childFromRun>[0]> = {}) => childFromRun({ status: st, pending: null, error: null, report: null, ...extra });

  it("coding tasks: working, waiting (with why), and how they ended", () => {
    expect(run("planning")).toEqual({ state: "working" });
    expect(run("awaiting_approval", { pending: { kind: "plan" } })).toEqual({ state: "waiting", reason: "approve the plan" });
    expect(run("failed", { error: "No model available" })).toEqual({ state: "failed", error: "No model available" });
    expect(run("cancelled")).toEqual({ state: "cancelled" });
    expect(run("completed", { report: { verification: "passed", files: [{ path: "src/cart.js" }] } })).toEqual({
      state: "done",
      summary: "1 file changed; tests passed after the last change.",
      changedFiles: ["src/cart.js"],
    });
  });

  it("reviews: open findings by severity; dismissed ones aren't counted", () => {
    expect(childFromReview({ status: "running", error: null, findings: [] })).toEqual({ state: "working" });
    const r = childFromReview({
      status: "completed",
      error: null,
      findings: [
        { severity: "high", status: "open" },
        { severity: "low", status: "open" },
        { severity: "high", status: "dismissed" },
      ],
    });
    expect(r).toMatchObject({ state: "done", summary: "2 findings to look at (1 high, 1 low)." });
  });
});
