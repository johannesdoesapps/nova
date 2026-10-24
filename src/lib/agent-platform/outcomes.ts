/**
 * How a task ended, in one vocabulary for every agent, worked out from the task's own records (its checks,
 * citations, findings, steps), never from what the agent says about itself:
 *
 * - verified: finished, and the evidence checks out (tests or a build passed after the last change; every
 *   research finding cites a source it found; a workflow's tests and review ran and you approved).
 * - completed: finished, with evidence that doesn't amount to verification (only an inspection ran; a review's
 *   AI findings; research with uncited paragraphs).
 * - partial: finished, but checks failed, went stale or were missed, problems were left open, or a step was skipped.
 * - blocked: stopped until someone acts (a limit was reached).
 * - failed: ended with an error.
 * - unverified: finished, and nothing confirms the result (no checks ran, or the record is missing).
 *
 * Open tasks (running, waiting for an approval) and cancelled ones have no outcome yet.
 */

export const OUTCOMES = ["verified", "completed", "partial", "blocked", "failed", "unverified"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const OUTCOME_INFO: Record<Outcome, { label: string; meaning: string }> = {
  verified: { label: "Completed and verified", meaning: "Finished, and the evidence checks out." },
  completed: { label: "Completed", meaning: "Finished; the evidence doesn't amount to full verification." },
  partial: { label: "Partly completed", meaning: "Finished with checks failed, missed or out of date, problems left open, or steps skipped." },
  blocked: { label: "Blocked", meaning: "Stopped until you act." },
  failed: { label: "Failed", meaning: "Ended with an error." },
  unverified: { label: "Unverified", meaning: "Finished, but nothing confirms the result." },
};

export interface OutcomeOf {
  outcome: Outcome | null;
  /** Why, from the records. */
  note: string | null;
}

const none: OutcomeOf = { outcome: null, note: null };

/** A coding-agent task (Software Engineer, Bug Fixing, QA Testing, Website Builder). `state` is the verdict its report recorded. */
export function codeRunOutcome(r: { status: string; pendingKind?: string | null; state?: string | null; verification?: string | null }): OutcomeOf {
  if (r.status === "failed") return { outcome: "failed", note: null };
  if (r.status === "needs_input" && r.pendingKind === "limit") return { outcome: "blocked", note: "A limit was reached: raise it or stop the task." };
  if (r.status !== "completed") return none;
  switch (r.state) {
    case "verified":
      return { outcome: "verified", note: "Automated checks passed after the last change." };
    case "checked":
      return { outcome: "completed", note: "Only an inspection ran (the page loads and looks right), not tests of its behaviour." };
    case "warnings":
      return { outcome: "partial", note: "Some checks failed, went out of date or were missed, or problems were left open." };
    case "unverified":
      return { outcome: "unverified", note: "No checks confirm the changes." };
  }
  // Reports from before verdicts were recorded: tests passing is evidence, but not the whole checklist.
  if (r.verification === "passed") return { outcome: "completed", note: "Tests passed after the last change." };
  return { outcome: "unverified", note: "No checks confirm the changes." };
}

/** A research report: verified when every finding paragraph cites a source the research actually found. */
export function researchOutcome(r: { status: string; check?: { cited?: number[]; invalidRemoved?: number; uncitedParagraphs?: number; findingParagraphs?: number } | null }): OutcomeOf {
  if (r.status === "failed") return { outcome: "failed", note: null };
  if (r.status !== "completed") return none;
  const c = r.check;
  if (!c) return { outcome: "unverified", note: "The citation check wasn't recorded." };
  const uncited = c.uncitedParagraphs ?? 0;
  const removed = c.invalidRemoved ?? 0;
  if (!c.cited?.length) return { outcome: "unverified", note: "The report cites no sources." };
  if (uncited === 0 && removed === 0) return { outcome: "verified", note: `Every finding cites a source the research found (${c.cited.length} cited).` };
  const parts = [
    uncited ? `${uncited} finding paragraph${uncited === 1 ? "" : "s"} without a source` : "",
    removed ? `${removed} citation${removed === 1 ? "" : "s"} to sources it didn't find removed` : "",
  ].filter(Boolean);
  return { outcome: "completed", note: `${parts.join("; ")}.` };
}

/** A code review: its findings are evidence about the code, but AI findings aren't confirmed bugs. */
export function reviewOutcome(r: { status: string }): OutcomeOf {
  if (r.status === "failed") return { outcome: "failed", note: null };
  if (r.status !== "completed") return none;
  return { outcome: "completed", note: "Rule matches are certain; AI findings point at real lines but aren't confirmed bugs." };
}

/** A Security Team scan. */
export function securityOutcome(r: { status: string; toolsFailed?: number }): OutcomeOf {
  if (r.status === "failed") return { outcome: "failed", note: null };
  if (r.status !== "completed") return none;
  if (r.toolsFailed) return { outcome: "partial", note: `${r.toolsFailed} scanner${r.toolsFailed === 1 ? "" : "s"} didn't run; their checks are missing.` };
  return { outcome: "completed", note: "Scanner results are evidence; AI explanations are marked as such." };
}

/** A workflow: verified when its tests and review ran and you approved; partial when one was skipped. */
export function workflowOutcome(r: { status: string; decision?: { action: string } | null; steps: { key: string; status: string }[] }): OutcomeOf {
  if (r.status === "failed") return { outcome: "failed", note: null };
  if (r.status !== "completed") return none;
  if (r.decision?.action === "reject") return { outcome: "completed", note: "You rejected the changes; they were undone." };
  const skipped = r.steps.filter((s) => (s.key === "test" || s.key === "review") && s.status !== "done");
  if (skipped.length) return { outcome: "partial", note: `Approved without ${skipped.map((s) => (s.key === "test" ? "tests" : "a review")).join(" or ")}.` };
  return { outcome: "verified", note: "Tests and review ran on the fix, and you approved it." };
}
