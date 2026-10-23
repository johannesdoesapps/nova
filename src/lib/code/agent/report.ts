import { diffStats } from "../diff";
import type { RunChange } from "./tools";
import type { AgentEvent, Freshness, RunChecks, RunReport, RunStatus, RunTests, RunUsage, SkippedCheck, Verification } from "./types";
import { assessReport, buildChecklist } from "./verdict";

/**
 * The final report of a run, built from its records: the files it changed
 * (as they are now compared with before the run), the commands it actually
 * ran with their exit codes, and the latest test run. The verification
 * status comes only from test runs that happened; the agent's own summary is
 * kept, labelled as its words. The checklist lists every check that applies
 * or ran (tests, build, server, browser inspection) with its evidence, and
 * the task's state is worked out from it (verdict.ts).
 */
export function buildReport(input: {
  status: RunStatus;
  summary: string | null;
  unresolved: string[];
  changes: (RunChange & { revertedAt?: string | null })[];
  current: Map<string, string>;
  events: Pick<AgentEvent, "kind" | "detail">[];
  tests: RunTests | null;
  checks?: RunChecks | null;
  lastEditAt: string | null;
  usage: RunUsage;
  steps: number;
  activeMs: number;
  checkpoints: number;
  /** The project's test command now, or null when it has no test setup. */
  testSetup?: string | null;
  web?: boolean;
  /** Checks that applied but couldn't run, with why. */
  skipped?: SkippedCheck[];
  now?: Date;
}): RunReport {
  const lines = (s: string | null) => (s ? s.replace(/\n$/, "").split("\n").length : 0);
  const files: RunReport["files"] = [];
  for (const c of input.changes) {
    const now = input.current.get(c.path) ?? null;
    if (now === c.before) continue;
    if (now === null) files.push({ path: c.path, change: "deleted", added: 0, removed: lines(c.before) });
    else if (c.before === null) files.push({ path: c.path, change: "created", added: lines(now), removed: 0 });
    else files.push({ path: c.path, change: "modified", ...diffStats(c.before, now) });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  const commands: RunReport["commands"] = [];
  for (const e of input.events) {
    const d = e.detail as { command?: string; exitCode?: number | null; blocked?: string; timedOut?: boolean; cancelled?: boolean } | null;
    if (e.kind !== "command" || !d?.command || d.blocked) continue;
    commands.push({
      command: d.command.slice(0, 300),
      exitCode: d.exitCode ?? null,
      result: d.cancelled ? "stopped" : d.timedOut ? "timed out" : d.exitCode === 0 ? "succeeded" : `failed (exit ${d.exitCode ?? "?"})`,
    });
  }

  const last = input.tests?.last ?? null;
  const afterLastEdit = !!last && (!input.lastEditAt || Date.parse(last.ranAt) >= Date.parse(input.lastEditAt));
  let verification: Verification = "not_run";
  if (last) verification = !afterLastEdit ? "stale" : last.verdict === "passed" ? "passed" : "failed";
  let tests: RunReport["tests"] = null;
  if (last) {
    const copy: Partial<typeof last> = { ...last };
    delete copy.outputTail;
    tests = { ...(copy as Omit<typeof last, "outputTail">), afterLastEdit };
  }

  const fresh = (at: string | undefined): Freshness => (!input.lastEditAt || (at && Date.parse(at) >= Date.parse(input.lastEditAt)) ? "current" : "stale");
  const c = input.checks;
  const checks: RunReport["checks"] =
    c && (c.server || c.preview || c.build)
      ? {
          server: c.server ? { ...c.server, freshness: fresh(c.server.at) } : null,
          preview: c.preview ? { ...c.preview, freshness: fresh(c.preview.checkedAt) } : null,
          build: c.build ? { ...c.build, freshness: fresh(c.build.ranAt) } : null,
        }
      : undefined;

  // The failed build's output, from the activity log.
  let buildOutput: string | null = null;
  if (checks?.build && !checks.build.passed) {
    for (const e of input.events) {
      const d = e.detail as { command?: string; output?: string } | null;
      if (e.kind === "command" && d?.command?.slice(0, 300) === checks.build.command && typeof d.output === "string") buildOutput = d.output;
    }
  }
  const checklist = buildChecklist({
    tests: tests && last ? { ...tests, outputTail: last.outputTail } : null,
    checks,
    testSetup: input.testSetup ?? null,
    web: !!input.web,
    skipped: input.skipped,
    buildOutput,
  });

  const report: RunReport = {
    outcome: input.status,
    summary: input.summary,
    unresolved: input.unresolved,
    files,
    commands: commands.slice(-40),
    tests,
    verification,
    ...(checks ? { checks } : {}),
    usage: { ...input.usage, steps: input.steps, activeMs: input.activeMs },
    checkpoints: input.checkpoints,
    createdAt: (input.now ?? new Date()).toISOString(),
    checklist,
    testSetup: input.testSetup ?? null,
    web: !!input.web,
  };
  if (input.status === "completed") report.state = assessReport(report).state;
  else if (input.status === "failed" || input.status === "cancelled") report.state = input.status;
  return report;
}

export const VERIFICATION_LABEL: Record<Verification, string> = {
  passed: "Tests passed after the last change",
  failed: "Tests failed",
  not_run: "Not verified: no tests ran",
  stale: "Not re-verified: files changed after the last test run",
};
