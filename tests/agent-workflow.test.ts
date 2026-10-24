/**
 * Multi-agent workflows (Fix and verify): the fixed step order, what each
 * observed task state does to the workflow, skipping test and review when
 * the fix changed nothing, failures and their recovery (bounded retries,
 * skipping only optional steps), the approval gate, cancelling, expiry, and
 * reading task records into step outcomes.
 */
import { describe, expect, it } from "vitest";
import {
  cancel,
  childFromReview,
  childFromRun,
  decide,
  expired,
  MAX_ATTEMPTS,
  newSteps,
  observe,
  recover,
  recoveries,
  regressionTests,
  reviewTaskIds,
  started,
  startFailed,
  TEMPLATE_INFO,
  workflowInput,
  WORKFLOW_TTL_MS,
  type WorkflowState,
} from "@/lib/agent-platform/workflow";

const AT = "2026-10-24T10:00:00.000Z";
const fresh = (): WorkflowState => ({ status: "running", current: 0, steps: newSteps("fix_and_verify"), log: [], error: null });
const done = (files: string[]) => ({ state: "done" as const, summary: `${files.length} files changed; tests passed after the last change.`, changedFiles: files });

/** Run the workflow to its approval step with every task succeeding. */
function toApproval(): WorkflowState {
  let w = started(fresh(), "fix-1", AT);
  w = observe(w, done(["src/cart.js"]), AT);
  w = started(w, "qa-1", AT);
  w = observe(w, done(["tests/cart.test.js"]), AT);
  w = started(w, "rev-1", AT);
  return observe(w, { state: "done", summary: "No findings.", changedFiles: [] }, AT);
}

describe("the Fix and verify template", () => {
  it("runs Bug Fixing, QA Testing and Code Review in that order, then waits for the user", () => {
    expect(TEMPLATE_INFO.fix_and_verify.steps.map((s) => [s.key, s.agent])).toEqual([
      ["fix", "bug_fixer"],
      ["test", "qa_tester"],
      ["review", "code_review"],
      ["approve", null],
    ]);
    const w = toApproval();
    expect(w.status).toBe("needs_approval");
    expect(w.current).toBe(3);
    expect(w.steps.map((s) => s.status)).toEqual(["done", "done", "done", "waiting"]);
    expect(w.steps.map((s) => s.taskId)).toEqual(["fix-1", "qa-1", "rev-1", null]);
  });

  it("only the fix is required; tests and review can be skipped after they fail", () => {
    expect(TEMPLATE_INFO.fix_and_verify.steps.filter((s) => s.optional).map((s) => s.key)).toEqual(["test", "review"]);
  });

  it("validates the start form", () => {
    expect(workflowInput.safeParse({ template: "fix_and_verify", projectId: "00000000-0000-4000-8000-000000000001", bug: { summary: "Total wrong" } }).success).toBe(true);
    expect(workflowInput.safeParse({ template: "deploy_everything", projectId: "00000000-0000-4000-8000-000000000001", bug: { summary: "x y z" } }).success).toBe(false);
    expect(workflowInput.safeParse({ template: "fix_and_verify", projectId: "00000000-0000-4000-8000-000000000001", bug: { summary: "Total" }, options: { commands: "off" } }).success).toBe(false);
  });
});

describe("observing the current step's task", () => {
  it("a task waiting for the user makes the workflow wait, and working again resumes it", () => {
    let w = started(fresh(), "fix-1", AT);
    w = observe(w, { state: "waiting", reason: "approve the plan" }, AT);
    expect(w.status).toBe("waiting");
    expect(w.steps[0]!.status).toBe("waiting");
    expect(w.log.at(-1)!.text).toMatch(/approve the plan/);
    w = observe(w, { state: "working" }, AT);
    expect(w.status).toBe("running");
    expect(w.steps[0]!.status).toBe("running");
  });

  it("a fix that changed nothing skips tests and review and goes to the decision", () => {
    let w = started(fresh(), "fix-1", AT);
    w = observe(w, done([]), AT);
    expect(w.status).toBe("needs_approval");
    expect(w.steps.map((s) => s.status)).toEqual(["done", "skipped", "skipped", "waiting"]);
    expect(w.steps[1]!.summary).toMatch(/changed no files/);
  });

  it("a failed or stopped task stops the workflow at that step, with the reason", () => {
    let w = observe(started(fresh(), "fix-1", AT), { state: "failed", error: "The model provider is unavailable." }, AT);
    expect(w).toMatchObject({ status: "failed", error: "Reproduce and fix the bug: The model provider is unavailable." });
    expect(w.steps[0]).toMatchObject({ status: "failed", attempts: 1 });
    w = observe(started(fresh(), "fix-1", AT), { state: "cancelled" }, AT);
    expect(w.status).toBe("failed");
    expect(w.steps[0]!.error).toBe("The task was stopped.");
  });

  it("ignores observations once the workflow has ended or before a step started", () => {
    const ended = { ...fresh(), status: "completed" as const };
    expect(observe(ended, done(["a"]), AT)).toBe(ended);
    const notStarted = fresh();
    expect(observe(notStarted, done(["a"]), AT)).toBe(notStarted);
  });

  it("couldn't start a step (quota, a busy project): the step fails without a task", () => {
    const w = startFailed(fresh(), "Your usage limit is reached.", AT);
    expect(w.status).toBe("failed");
    expect(w.steps[0]).toMatchObject({ status: "failed", taskId: null, attempts: 1, error: "Your usage limit is reached." });
  });
});

describe("recovering from a failed step", () => {
  const failedAt = (step: number, attempts = 1): WorkflowState => {
    const w = toApproval();
    const steps = w.steps.map((s, i) => (i === step ? { ...s, status: "failed" as const, attempts } : i > step ? { ...s, status: "pending" as const } : s));
    return { ...w, steps, current: step, status: "failed", error: "x" };
  };

  it("a required step can be retried but not skipped", () => {
    expect(recoveries(failedAt(0))).toEqual(["retry"]);
    expect(recover(failedAt(0), "skip", AT)).toBeNull();
    const w = recover(failedAt(0), "retry", AT)!;
    expect(w.status).toBe("running");
    expect(w.steps[0]!.status).toBe("pending");
  });

  it("retries are bounded", () => {
    expect(recoveries(failedAt(0, MAX_ATTEMPTS))).toEqual([]);
    expect(recover(failedAt(0, MAX_ATTEMPTS), "retry", AT)).toBeNull();
  });

  it("an optional step can be skipped, and the workflow goes on", () => {
    expect(recoveries(failedAt(1))).toEqual(["retry", "skip"]);
    const w = recover(failedAt(1), "skip", AT)!;
    expect(w.steps[1]!.status).toBe("skipped");
    expect(w.current).toBe(2);
    expect(w.status).toBe("running");
    // Skipping the review goes straight to the decision.
    const r = recover(failedAt(2), "skip", AT)!;
    expect(r.status).toBe("needs_approval");
  });

  it("nothing to recover unless the workflow failed", () => {
    expect(recoveries(toApproval())).toEqual([]);
  });
});

describe("the approval gate", () => {
  it("records the decision only when the workflow is waiting for it", () => {
    const w = decide(toApproval(), "approve", AT)!;
    expect(w.status).toBe("completed");
    expect(w.steps[3]!.summary).toBe("Approved");
    expect(decide(w, "reject", AT)).toBeNull();
    expect(decide(started(fresh(), "fix-1", AT), "approve", AT)).toBeNull();
  });

  it("rejecting is recorded as undone", () => {
    expect(decide(toApproval(), "reject", AT)!.steps[3]!.summary).toMatch(/undone/);
  });
});

describe("stopping and expiry", () => {
  it("cancelling marks the current step and can't be done twice", () => {
    const w = cancel(started(fresh(), "fix-1", AT), AT)!;
    expect(w.status).toBe("cancelled");
    expect(w.steps[0]!.error).toBe("Stopped by you.");
    expect(cancel(w, AT)).toBeNull();
  });

  it("a workflow older than a day expires", () => {
    const now = Date.parse(AT);
    expect(expired(new Date(now - WORKFLOW_TTL_MS - 1).toISOString(), now)).toBe(true);
    expect(expired(new Date(now - 60_000).toISOString(), now)).toBe(false);
  });
});

describe("what each step is given", () => {
  it("QA writes regression tests for the files the fix changed", () => {
    const qa = regressionTests({ summary: "Discount total wrong", details: "", logs: "", reproduce: "", expected: "10% off the subtotal" }, ["src/cart.js"]);
    expect(qa.scope).toMatch(/Discount total wrong.*src\/cart\.js.*fail on the old behaviour/);
    expect(qa.notes).toBe("Expected behaviour: 10% off the subtotal");
    expect(qa.kinds).toEqual(["unit"]);
  });

  it("the review covers the tasks that finished (fix and tests), not skipped or failed ones", () => {
    let w = started(fresh(), "fix-1", AT);
    w = observe(w, done(["src/cart.js"]), AT);
    expect(reviewTaskIds(w)).toEqual(["fix-1"]);
    w = observe(started(w, "qa-1", AT), done(["tests/a.test.js"]), AT);
    expect(reviewTaskIds(w)).toEqual(["fix-1", "qa-1"]);
  });
});

describe("reading task records", () => {
  const run = (status: string, extra: Partial<Parameters<typeof childFromRun>[0]> = {}) => childFromRun({ status, pending: null, error: null, report: null, ...extra });

  it("coding tasks: working, waiting (with why), and how they ended", () => {
    expect(run("planning")).toEqual({ state: "working" });
    expect(run("running")).toEqual({ state: "working" });
    expect(run("awaiting_approval", { pending: { kind: "plan" } })).toEqual({ state: "waiting", reason: "approve the plan" });
    expect(run("needs_input", { pending: { kind: "limit" } })).toMatchObject({ state: "waiting" });
    expect(run("failed", { error: "No model available" })).toEqual({ state: "failed", error: "No model available" });
    expect(run("cancelled")).toEqual({ state: "cancelled" });
    expect(run("completed", { report: { verification: "passed", files: [{ path: "src/cart.js" }] } })).toEqual({
      state: "done",
      summary: "1 file changed; tests passed after the last change.",
      changedFiles: ["src/cart.js"],
    });
    expect(run("completed", { report: { verification: "not_run", files: [] } })).toMatchObject({ summary: "0 files changed; no tests ran." });
  });

  it("reviews: open findings by severity; dismissed ones aren't counted", () => {
    expect(childFromReview({ status: "running", error: null, findings: [] })).toEqual({ state: "working" });
    expect(childFromReview({ status: "failed", error: "AI isn't configured", findings: [] })).toEqual({ state: "failed", error: "AI isn't configured" });
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
    expect(childFromReview({ status: "completed", error: null, findings: [] })).toMatchObject({ summary: "No findings." });
  });
});
