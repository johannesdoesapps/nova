import type { ProjectFile } from "../projects";
import { detectTestCommand } from "./test-results";
import type { RunChecks, RunOptions, RunTests, SkippedCheck, VerifyStep } from "./types";

/**
 * Which checks Orbis runs itself when the agent says it has finished (or the
 * user asks to re-run them): the project's tests when it has a test setup,
 * and a browser inspection for a website whose preview is running. A check
 * that already ran after the agent's last change isn't repeated (its result
 * stands, pass or fail). Checks that apply but can't run here are returned
 * with the reason, so the report says "not run" and why — never "passed".
 */
export function planVerification(i: {
  options: Pick<RunOptions, "readOnly" | "commands" | "web">;
  files: ProjectFile[];
  tests: RunTests | null;
  checks: RunChecks;
  lastEditAt: string | null;
  /** Files the run changed (that are still changed). */
  changedFiles: number;
  computer: boolean;
  /** The user pressed "Re-run checks": every check that applies runs again, and their click counts as approval. */
  rerun?: boolean;
}): { queue: VerifyStep[]; skipped: SkippedCheck[] } {
  if (!i.changedFiles && !i.rerun) return { queue: [], skipped: [] };
  const current = (at: string | null | undefined) => !!at && (!i.lastEditAt || Date.parse(at) >= Date.parse(i.lastEditAt));

  const want: VerifyStep[] = [];
  const testCmd = detectTestCommand(i.files);
  if (testCmd && (i.rerun || !current(i.tests?.last?.ranAt))) want.push({ check: "tests", command: testCmd });
  const isSite = !!i.options.web || !!i.checks.server;
  if (isSite && (i.rerun || !current(i.checks.preview?.checkedAt))) want.push({ check: "browser", path: i.checks.preview?.path ?? "/" });
  if (!want.length) return { queue: [], skipped: [] };

  const skip = (reason: string) => ({ queue: [], skipped: want.map((w) => ({ check: w.check, reason })) });
  if (i.options.readOnly || i.options.commands === "off") return skip("Not run: commands are off in this session, so Orbis couldn't run checks.");
  if (i.options.commands === "ask" && !i.rerun) return skip("Not run: in this mode every command needs your approval, so Orbis didn't run checks on its own. Use Re-run checks.");
  if (!i.computer) return skip("Not run: the project's computer was off. Start it, then use Re-run checks.");

  const queue: VerifyStep[] = [];
  const skipped: SkippedCheck[] = [];
  for (const w of want) {
    if (w.check === "browser" && i.checks.server?.state !== "running")
      skipped.push({ check: "browser", reason: "Not run: the preview server wasn't running, so the page couldn't be opened. Press Run, then use Re-run checks." });
    else queue.push(w);
  }
  return { queue, skipped };
}
