import type { ProjectFile } from "../projects";

/**
 * Test runs: which command runs a project's tests, and what its output says.
 * The verdict comes from the exit code first; the counts are read from the
 * output of the common runners (Vitest, Jest, Mocha, node:test, pytest,
 * unittest, Go). Output nobody recognises gives counts of null, never a guess.
 */

export type TestVerdict = "passed" | "failed" | "timed_out" | "stopped" | "error";

export interface TestResult {
  command: string;
  framework: string | null;
  verdict: TestVerdict;
  exitCode: number | null;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  /** Names of failing tests, when the output lists them. */
  failures: string[];
  durationMs: number;
  ranAt: string;
  /** The end of the output (where failures are reported). */
  outputTail: string;
}

/** The command that runs this project's tests, or null when there's no sign of a test setup. */
export function detectTestCommand(files: ProjectFile[]): string | null {
  const byPath = new Map(files.map((f) => [f.path, f.content]));
  const pkg = byPath.get("package.json");
  if (pkg) {
    try {
      const j = JSON.parse(pkg) as { scripts?: Record<string, string>; devDependencies?: Record<string, string>; dependencies?: Record<string, string> };
      const test = j.scripts?.test;
      if (test && !/no test specified/.test(test)) return "npm test";
      const deps = { ...j.dependencies, ...j.devDependencies };
      if (deps.vitest) return "npx vitest run";
      if (deps.jest) return "npx jest";
    } catch {
      /* not valid JSON: fall through */
    }
  }
  const paths = files.map((f) => f.path);
  const py = paths.filter((p) => /(^|\/)(test_[^/]*|[^/]*_test)\.py$/.test(p));
  if (py.length) {
    const usesPytest = byPath.has("pytest.ini") || /pytest/.test(`${byPath.get("requirements.txt") ?? ""}${byPath.get("pyproject.toml") ?? ""}`) || py.some((p) => !/unittest/.test(byPath.get(p)!));
    return usesPytest ? "python -m pytest -q" : "python -m unittest discover -v";
  }
  if (paths.some((p) => p.endsWith("_test.go"))) return "go test ./...";
  if (paths.some((p) => /(^|\/)[^/]+\.test\.(m?js|cjs)$/.test(p) || /^test\/.+\.(m?js|cjs)$/.test(p))) return "node --test";
  return null;
}

const ANSI = /\x1b\[[0-9;]*m/g;
const num = (s: string | undefined) => (s === undefined ? null : Number(s));

/** Counts and failing test names from a test runner's output. */
export function parseTestOutput(output: string): Pick<TestResult, "framework" | "passed" | "failed" | "skipped" | "failures"> {
  const text = output.replace(ANSI, "");
  const out = { framework: null as string | null, passed: null as number | null, failed: null as number | null, skipped: null as number | null, failures: [] as string[] };
  let m: RegExpMatchArray | null;

  // Vitest: "Tests  2 failed | 5 passed | 1 skipped (8)"
  if ((m = text.match(/^\s*Tests\s+((?:\d+\s+\w+(?:\s*\|\s*)?)+)\s*\(\d+\)/m))) {
    out.framework = "vitest";
    out.failed = num(m[1]!.match(/(\d+)\s+failed/)?.[1]) ?? 0;
    out.passed = num(m[1]!.match(/(\d+)\s+passed/)?.[1]) ?? 0;
    out.skipped = num(m[1]!.match(/(\d+)\s+(?:skipped|todo)/)?.[1]) ?? 0;
    out.failures = [...text.matchAll(/^\s*(?:×|✗|FAIL)\s+(.+?)(?:\s+\d+ms)?$/gm)].map((x) => x[1]!.trim()).filter((x) => !/^\S+\.(t|j)sx?$/.test(x));
  }
  // Jest: "Tests:       1 failed, 4 passed, 5 total"
  else if ((m = text.match(/^Tests:\s+(.+?)\s*,?\s*(\d+)\s+total/m))) {
    out.framework = "jest";
    out.failed = num(m[1]!.match(/(\d+)\s+failed/)?.[1]) ?? 0;
    out.passed = num(m[1]!.match(/(\d+)\s+passed/)?.[1]) ?? 0;
    out.skipped = num(m[1]!.match(/(\d+)\s+(?:skipped|todo)/)?.[1]) ?? 0;
    out.failures = [...text.matchAll(/^\s*●\s+(.+)$/gm)].map((x) => x[1]!.trim());
  }
  // pytest: "==== 1 failed, 4 passed, 1 skipped in 0.12s ====" or "4 passed in 0.1s"
  else if ((m = text.match(/^[=\s]*((?:\d+\s+(?:failed|passed|skipped|errors?|xfailed|xpassed|deselected)(?:,\s*)?)+)\s+in\s+[\d.]+s/m))) {
    out.framework = "pytest";
    out.failed = (num(m[1]!.match(/(\d+)\s+failed/)?.[1]) ?? 0) + (num(m[1]!.match(/(\d+)\s+errors?/)?.[1]) ?? 0);
    out.passed = num(m[1]!.match(/(\d+)\s+passed/)?.[1]) ?? 0;
    out.skipped = num(m[1]!.match(/(\d+)\s+skipped/)?.[1]) ?? 0;
    out.failures = [...text.matchAll(/^(?:FAILED|ERROR)\s+(\S+)/gm)].map((x) => x[1]!);
  }
  // unittest: "Ran 5 tests in 0.001s" then "OK" or "FAILED (failures=1, errors=1)"
  else if ((m = text.match(/^Ran (\d+) tests? in/m))) {
    out.framework = "unittest";
    const total = Number(m[1]);
    const f = text.match(/^FAILED \(([^)]*)\)/m)?.[1] ?? "";
    out.failed = (num(f.match(/failures=(\d+)/)?.[1]) ?? 0) + (num(f.match(/errors=(\d+)/)?.[1]) ?? 0);
    out.skipped = num(text.match(/skipped=(\d+)/)?.[1]) ?? 0;
    out.passed = Math.max(0, total - out.failed - out.skipped);
    out.failures = [...text.matchAll(/^(?:FAIL|ERROR): (.+)$/gm)].map((x) => x[1]!.trim());
  }
  // node:test (TAP summary): "# pass 4" / "# fail 1"
  else if ((m = text.match(/^# pass (\d+)/m))) {
    out.framework = "node:test";
    out.passed = Number(m[1]);
    out.failed = num(text.match(/^# fail (\d+)/m)?.[1]) ?? 0;
    out.skipped = num(text.match(/^# skipped (\d+)/m)?.[1]) ?? 0;
    out.failures = [...text.matchAll(/^not ok \d+ - (.+)$/gm)].map((x) => x[1]!.trim());
  }
  // Mocha: "4 passing" / "1 failing"
  else if ((m = text.match(/^\s*(\d+) passing/m))) {
    out.framework = "mocha";
    out.passed = Number(m[1]);
    out.failed = num(text.match(/^\s*(\d+) failing/m)?.[1]) ?? 0;
    out.skipped = num(text.match(/^\s*(\d+) pending/m)?.[1]) ?? 0;
  }
  // Go: "--- FAIL: TestX" lines, "ok"/"FAIL" per package
  else if (/^(ok|FAIL|---)\s/m.test(text) && /\bgo\b|_test\.go|^ok\s+\S+\s+[\d.]+s/m.test(text)) {
    out.framework = "go";
    out.failures = [...text.matchAll(/^--- FAIL: (\S+)/gm)].map((x) => x[1]!);
    out.failed = out.failures.length;
    out.passed = [...text.matchAll(/^--- PASS: /gm)].length || null;
  }
  out.failures = [...new Set(out.failures)].slice(0, 30).map((f) => f.slice(0, 200));
  return out;
}

/**
 * The verdict: a run that timed out or was stopped says so; otherwise the exit
 * code decides, and "passed" also needs the output not to report failures.
 */
export function testResult(input: { command: string; exitCode: number | null; output: string; durationMs: number; timedOut: boolean; cancelled: boolean; at?: Date }): TestResult {
  const parsed = parseTestOutput(input.output);
  const verdict: TestVerdict = input.cancelled ? "stopped" : input.timedOut ? "timed_out" : input.exitCode === 0 && !parsed.failed ? "passed" : input.exitCode === null ? "error" : "failed";
  return {
    command: input.command,
    ...parsed,
    verdict,
    exitCode: input.exitCode,
    durationMs: Math.round(input.durationMs),
    ranAt: (input.at ?? new Date()).toISOString(),
    outputTail: input.output.replace(ANSI, "").slice(-4_000),
  };
}

export function describeTestResult(t: TestResult): string {
  const counts =
    t.passed !== null || t.failed !== null ? ` (${[t.passed !== null && `${t.passed} passed`, t.failed && `${t.failed} failed`, t.skipped && `${t.skipped} skipped`].filter(Boolean).join(", ")})` : "";
  const label = { passed: "passed", failed: "failed", timed_out: "timed out", stopped: "stopped", error: "couldn't run" }[t.verdict];
  return `Tests ${label}${counts}: ${t.command}`;
}

/** Whether a command is a test run (so its result is recorded as one). */
export function isTestCommand(command: string): boolean {
  return /^(npm|pnpm|yarn)\s+(run\s+)?test\b|^(npx\s+)?(vitest|jest|mocha|ava)\b|^(python3?\s+-m\s+)?pytest\b|^python3?\s+-m\s+unittest\b|^go\s+test\b|^node\s+--test\b/.test(command.trim());
}
