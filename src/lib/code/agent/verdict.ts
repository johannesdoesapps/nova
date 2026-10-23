import { diagnoseOutput } from "./diagnose";
import type { CheckItem, CheckStatus, RunReport, RunView, SkippedCheck, TaskState } from "./types";

/**
 * Whether a coding task's work is verified, decided from evidence only: the
 * checks that actually ran (tests, build, server, browser inspection), when
 * they ran relative to the agent's last change, and what they found. The
 * agent saying it's done ends the work, never the verification. Pure (no
 * server imports): the server stores the result in the report and the page
 * works it out the same way.
 */

/** What each state means. A run is "verified" only when checks ran after the last change and every one that applies passed. */
export const TASK_STATE_INFO: Record<TaskState, { label: string; meaning: string }> = {
  queued: { label: "Queued", meaning: "Created; the agent hasn't taken its first step yet." },
  running: { label: "Working", meaning: "The agent is planning or working on the task." },
  waiting: { label: "Waiting for you", meaning: "The agent is paused until you answer, approve something or start the project's computer." },
  verifying: { label: "Verifying", meaning: "The agent says it has finished; Orbis is running the checks that apply before calling it done." },
  verified: { label: "Done and verified", meaning: "Checks ran after the last change and every check that applies passed, including automated tests or a production build." },
  checked: {
    label: "Done, checked in a browser",
    meaning: "The site started and a real browser found no problems after the last change, but no automated tests or production build ran, so its behaviour isn't tested.",
  },
  warnings: { label: "Done, with warnings", meaning: "Finished, but a check failed, ran before the last change, couldn't complete or didn't run, or the agent left problems open." },
  unverified: { label: "Done, not verified", meaning: "Finished, but no checks ran, so nothing confirms the work does what was asked." },
  failed: { label: "Failed", meaning: "The run stopped with an error before finishing." },
  cancelled: { label: "Stopped", meaning: "Stopped before finishing. Changes made so far are kept until you undo them." },
};

export const CHECK_STATUS_LABEL: Record<CheckStatus, string> = { passed: "Passed", failed: "Failed", stale: "Out of date", error: "Couldn't complete", not_run: "Not run" };

const clip = (s: string | null | undefined, n: number) => (s ? (s.length > n ? `…${s.slice(-n)}` : s) : null);

export interface ChecklistInput {
  tests: (NonNullable<RunReport["tests"]> & { outputTail?: string }) | null;
  checks: RunReport["checks"] | undefined;
  /** The project's test command, or null when it has no test setup. */
  testSetup: string | null | undefined;
  web: boolean;
  /** Checks Orbis would have run but couldn't, with the reason. */
  skipped?: SkippedCheck[];
  /** The build command's output, when it failed. */
  buildOutput?: string | null;
}

/** Every check that applies to the task or ran, in a fixed order: tests, build, server, browser. */
export function buildChecklist(i: ChecklistInput): CheckItem[] {
  const skippedFor = (c: SkippedCheck["check"]) => i.skipped?.find((s) => s.check === c)?.reason;
  const out: CheckItem[] = [];

  const t = i.tests;
  if (t) {
    const counts = t.passed !== null || t.failed !== null ? `${t.passed ?? 0} passed, ${t.failed ?? 0} failed${t.skipped ? `, ${t.skipped} skipped` : ""}` : `exit code ${t.exitCode ?? "none"}`;
    const status: CheckStatus = !t.afterLastEdit ? "stale" : t.verdict === "passed" ? "passed" : t.verdict === "failed" ? "failed" : "error";
    const how = t.verdict === "timed_out" ? "Timed out" : t.verdict === "stopped" ? "Stopped before finishing" : t.verdict === "error" ? "Couldn't run the tests" : counts;
    out.push({
      id: "tests",
      label: "Automated tests",
      kind: "automated",
      status,
      applicable: true,
      at: t.ranAt,
      command: t.command,
      summary: status === "stale" ? `${how} — but files changed after this run, so it doesn't cover the final code` : how,
      details: t.failures.slice(0, 10),
      output: status === "passed" ? null : clip(t.outputTail, 2_000),
    });
  } else {
    out.push({
      id: "tests",
      label: "Automated tests",
      kind: "automated",
      status: "not_run",
      applicable: !!i.testSetup,
      at: null,
      command: i.testSetup ?? null,
      summary: skippedFor("tests") ?? (i.testSetup ? `Not run (the project's tests run with ${i.testSetup})` : "Not run: the project has no test setup"),
      details: [],
      output: null,
    });
  }

  const b = i.checks?.build;
  if (b) {
    const status: CheckStatus = b.freshness === "stale" ? "stale" : b.passed ? "passed" : "failed";
    out.push({
      id: "build",
      label: "Production build",
      kind: "automated",
      status,
      applicable: true,
      at: b.ranAt,
      command: b.command,
      summary:
        status === "stale"
          ? "Ran before the last change"
          : b.passed
            ? "Built without errors"
            : `Failed (exit code ${b.exitCode ?? "none"})${(() => {
                const d = diagnoseOutput(i.buildOutput);
                return d ? `. ${d.hint}` : "";
              })()}`,
      details: [],
      output: status === "failed" ? clip(i.buildOutput, 2_000) : null,
    });
  } else {
    out.push({ id: "build", label: "Production build", kind: "automated", status: "not_run", applicable: false, at: null, command: null, summary: "Not run", details: [], output: null });
  }

  const s = i.checks?.server;
  if (s) {
    const ok = s.state === "running";
    out.push({
      id: "server",
      label: "Development server",
      kind: "process",
      status: ok ? (s.freshness === "stale" ? "stale" : "passed") : "failed",
      applicable: true,
      at: s.at,
      command: s.command,
      summary: `${ok ? `Started and answered (HTTP ${s.http})` : s.state === "exited" ? "Didn't start: the command exited" : "Didn't answer in time"}${!ok && s.note ? `. ${s.note}` : ""}`,
      details: [],
      output: null,
    });
  }

  const p = i.checks?.preview;
  const browserApplies = i.web || !!s;
  if (p) {
    const status: CheckStatus = p.freshness === "stale" ? "stale" : p.verdict === "passed" ? "passed" : p.verdict === "problems" ? "failed" : "error";
    out.push({
      id: "browser",
      label: "Browser inspection",
      kind: "inspection",
      status,
      applicable: true,
      at: p.checkedAt,
      command: null,
      summary:
        status === "stale"
          ? "Checked before the last change"
          : status === "passed"
            ? `${p.path} loaded at ${p.sizes?.length ? p.sizes.join(", ") : "desktop and phone sizes"} with no problems found`
            : status === "failed"
              ? `${p.problems.length} problem${p.problems.length === 1 ? "" : "s"} found on ${p.path}`
              : `Couldn't load ${p.path} in the browser`,
      details: [...p.problems.slice(0, 10), ...p.warnings.slice(0, 5).map((w) => `Warning: ${w}`)],
      output: null,
    });
  } else if (browserApplies) {
    out.push({
      id: "browser",
      label: "Browser inspection",
      kind: "inspection",
      status: "not_run",
      applicable: true,
      at: null,
      command: null,
      summary: skippedFor("browser") ?? "Not run: the page wasn't opened in a browser",
      details: [],
      output: null,
    });
  }
  return out;
}

/** The report's checklist; for reports written before checklists existed, rebuilt from the same records. */
export function checklistOf(r: RunReport): CheckItem[] {
  return r.checklist ?? buildChecklist({ tests: r.tests, checks: r.checks, testSetup: r.testSetup ?? null, web: !!r.web || !!r.checks?.server });
}

export interface Assessment {
  state: Extract<TaskState, "verified" | "checked" | "warnings" | "unverified">;
  /** Why it isn't verified (empty when it is). */
  reasons: string[];
}

/** A finished run's verdict, from its checklist: verified only when checks ran after the last change and none failed, went stale or was missed. */
export function assessReport(r: RunReport): Assessment {
  const items = checklistOf(r);
  const ran = items.filter((c) => c.status !== "not_run");
  const reasons: string[] = [];
  for (const c of items) {
    if (c.status === "failed") reasons.push(`${c.label} failed.`);
    else if (c.status === "error") reasons.push(`${c.label} couldn't complete.`);
    else if (c.status === "stale") reasons.push(`${c.label} ran before the last change, so it doesn't cover the final code.`);
    else if (c.status === "not_run" && c.applicable) reasons.push(`${c.label} didn't run.`);
  }
  if (r.unresolved.length) reasons.push(`The agent left ${r.unresolved.length} problem${r.unresolved.length === 1 ? "" : "s"} open.`);
  if (!ran.length) {
    return {
      state: "unverified",
      reasons: [r.files.length ? "No checks ran, so nothing confirms the changes work." : "No files changed and no checks ran.", ...reasons.filter((x) => !x.endsWith("didn't run."))],
    };
  }
  if (!ran.some((c) => c.status === "passed")) return { state: "warnings", reasons };
  if (reasons.length) return { state: "warnings", reasons };
  // A page that loads and looks right isn't tested behaviour: without an automated check (tests or a build) it's "checked", not "verified".
  if (!ran.some((c) => c.kind === "automated" && c.status === "passed"))
    return { state: "checked", reasons: ["Only the server and a browser inspection ran: they show the page loads and lays out correctly, not that its features work."] };
  return { state: "verified", reasons: [] };
}

/**
 * The task's state, from the run's status and evidence:
 * - cancelled / failed: the run's status (an error or the user's Stop);
 * - verifying: the agent finished and Orbis is running the checks (checks.verify is set);
 * - queued: working, but no step has been taken and none is in progress;
 * - waiting: paused for the user; running: planning or working;
 * - completed: verified / warnings / unverified from the report's checks. A completed run whose report is
 *   missing is "unverified": without the record, nothing confirms the work.
 */
export function taskState(run: Pick<RunView, "status" | "steps" | "busy" | "report" | "checks">): TaskState {
  if (run.status === "cancelled") return "cancelled";
  if (run.status === "failed") return "failed";
  if (run.status === "completed") return run.report ? assessReport(run.report).state : "unverified";
  if (run.checks?.verify) return "verifying";
  if (run.status === "awaiting_approval" || run.status === "needs_input") return "waiting";
  if (run.steps === 0 && !run.busy) return "queued";
  return "running";
}

/** What to do next, from what the checks found. */
export function nextActions(r: RunReport, state: TaskState): string[] {
  const items = checklistOf(r);
  const out: string[] = [];
  const by = (id: CheckItem["id"]) => items.find((c) => c.id === id);
  const tests = by("tests");
  const browser = by("browser");
  if (tests?.status === "failed" || tests?.status === "error") out.push("Look at the failing tests below, then ask the agent to fix them or fix them yourself.");
  if (by("build")?.status === "failed") out.push("Read the build error and ask the agent to fix it.");
  if (browser?.status === "failed") out.push("Open the preview and look at the problems the browser inspection found.");
  if (items.some((c) => c.status === "stale") || items.some((c) => c.applicable && c.status === "not_run")) out.push("Re-run the checks so they cover the final code.");
  if (tests && tests.status === "not_run" && !tests.applicable && r.files.length) out.push("There are no automated tests: try the changes yourself, or ask the agent to add tests.");
  if (browser && browser.status === "passed") out.push("The browser inspection checks loading and layout, not behaviour: click through the parts you changed.");
  if (r.unresolved.length) out.push("Read the open points below before relying on this work.");
  if (state === "verified" && r.files.length) out.push("Review the changes before you publish or push them.");
  return out;
}

/** A response about the same run that's older than the state already shown (responses can arrive out of order). */
export function isOlderView(shown: Pick<RunView, "id" | "updatedAt"> | null, incoming: Pick<RunView, "id" | "updatedAt">): boolean {
  if (!shown || shown.id !== incoming.id) return false;
  const a = Date.parse(shown.updatedAt);
  const b = Date.parse(incoming.updatedAt);
  return Number.isFinite(a) && Number.isFinite(b) && b < a;
}

/**
 * A follow-up request asking the agent to fix what the checks found (failed tests, a failed build, a server that
 * didn't start, browser problems), quoting the findings. Null when nothing failed. The user edits it before sending.
 */
export function fixRequest(r: RunReport): string | null {
  const items = checklistOf(r).filter((c) => c.status === "failed" || c.status === "error");
  if (!items.length) return null;
  const parts = items.map((c) => {
    const found = c.details.length
      ? `\n${c.details
          .slice(0, 8)
          .map((d) => `  - ${d}`)
          .join("\n")}`
      : "";
    return `- ${c.label}${c.command ? ` (${c.command})` : ""}: ${c.summary}${found}`;
  });
  return `Fix the problems the last checks found, then run the same checks again:\n${parts.join("\n")}`.slice(0, 3_000);
}

/** One line on how a finished session's checks ended, for the next session in the project (its state and what didn't pass). */
export function checksSummary(r: RunReport): string {
  const { state } = assessReport(r);
  const open = checklistOf(r).filter((c) => c.status === "failed" || c.status === "error" || c.status === "stale" || (c.status === "not_run" && c.applicable));
  const parts = open.map((c) => `${c.label}: ${c.summary}${c.details.length ? ` (${c.details.slice(0, 3).join("; ")})` : ""}`);
  return `Checks: ${TASK_STATE_INFO[state].label}${parts.length ? `. Not passing: ${parts.join(" | ")}` : ""}`;
}
