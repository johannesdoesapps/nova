/**
 * Code runs (the Run button): the script the sandbox runs, executed here with
 * the real bash/python3/node against a temporary directory standing in for
 * the VM; the cost ceiling and its place in each plan's margin; and the
 * database counting (code_run_status) in the real migrations on PGlite.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CODE_OUTPUT_LIMIT, codeLanguage } from "@/lib/code/languages";
import { codeRunCostUsd, maxCodeRunCostUsd } from "@/lib/code/pricing";
import { DEFAULT_BILLING, PLAN_IDS, planEconomics, validateBilling } from "@/lib/plans";

vi.mock("server-only", () => ({}));
vi.mock("@vercel/sandbox", () => ({ Sandbox: { create: vi.fn() } }));

const { parseRunnerOutput, runCode, runnerScript } = await import("@/lib/code/run");
type BoxFactory = import("@/lib/code/run").BoxFactory;

/** A stand-in for the VM: files go to a temp dir, commands run with the local shell. */
function localBox(dir: string): BoxFactory {
  return async () => ({
    async writeFiles(files) {
      for (const f of files) writeFileSync(f.path, f.content);
    },
    runCommand({ cmd, args, env }) {
      return new Promise((resolve) => {
        execFile(cmd, args, { env: { ...process.env, ...env }, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) =>
          resolve({ exitCode: err ? 1 : 0, stdout: async () => stdout }),
        );
      });
    },
    async stop() {
      stopped.push(dir);
    },
  });
}
const stopped: string[] = [];
let dir: string;
const run = (language: string, code: string, seconds = 10) => runCode({ language, code, seconds, dir }, localBox(dir));

describe("languages", () => {
  it("maps code block tags to runnable languages", () => {
    expect(codeLanguage("py")?.id).toBe("python");
    expect(codeLanguage("JS")?.id).toBe("javascript");
    expect(codeLanguage("ts")?.id).toBe("typescript");
    expect(codeLanguage("sh")?.id).toBe("bash");
    expect(codeLanguage("rust")).toBeNull();
    expect(codeLanguage("")).toBeNull();
  });
});

describe("runner script (local bash standing in for the VM)", () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "orbis-run-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("runs Python and returns its output and exit code, then stops the VM", async () => {
    const r = await run("python", "print('hello from', 'orbis')\nprint(2 + 3)");
    expect(r).toMatchObject({ language: "python", stdout: "hello from orbis\n5\n", stderr: "", exitCode: 0, timedOut: false, truncated: false });
    expect(stopped).toContain(dir);
  });

  it("runs JavaScript and Bash, with quotes in the code left intact", async () => {
    expect((await run("js", "console.log(\"it's\", [1,2].map((x) => x * 2).join(','))")).stdout).toBe("it's 2,4\n");
    expect((await run("bash", "echo 'single' \"double\"; echo $((6*7))")).stdout).toBe("single double\n42\n");
  });

  it("reports errors on stderr with a non-zero exit code", async () => {
    const r = await run("python", "import sys\nprint('partial')\nraise ValueError('boom')");
    expect(r.stdout).toBe("partial\n");
    expect(r.stderr).toContain("ValueError: boom");
    expect(r.exitCode).toBe(1);
    expect(r.timedOut).toBe(false);
  });

  it("stops a program at the time limit", async () => {
    const r = await run("python", "import time\nprint('start', flush=True)\ntime.sleep(10)", 1);
    expect(r.timedOut).toBe(true);
    expect([124, 137]).toContain(r.exitCode);
    expect(r.stdout).toBe("start\n");
  });

  it("shortens long output to the limit", async () => {
    const r = await run("python", `print('x' * ${CODE_OUTPUT_LIMIT * 3})`);
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBe(CODE_OUTPUT_LIMIT);
  });

  it("gives the program no input", async () => {
    const r = await run("python", "import sys\nprint(repr(sys.stdin.read()))");
    expect(r.stdout).toBe("''\n");
  });

  it("refuses unsupported languages", async () => {
    await expect(run("rust", "fn main() {}")).rejects.toThrow(/Unsupported/);
  });

  it("parses garbled output as a failed run instead of throwing", () => {
    expect(parseRunnerOutput("something unexpected")).toMatchObject({ exitCode: 1, stdout: "" });
    expect(runnerScript(["python3", "main.py"], 30, "/tmp")).toContain("timeout -s KILL 30 'python3' 'main.py'");
  });
});

describe("cost and margins", () => {
  it("prices a run from Vercel Sandbox rates (1 vCPU, 2 GB) and caps it at the time limit", () => {
    // 30 s: 30/3600 h × ($0.128 + 2 × $0.0212) + $0.60 per million starts.
    expect(codeRunCostUsd(30_000)).toBeCloseTo((30 / 3600) * (0.128 + 0.0424) + 0.0000006, 6);
    expect(maxCodeRunCostUsd(30)).toBeCloseTo(codeRunCostUsd(33_000), 9);
    expect(maxCodeRunCostUsd(30)).toBeLessThan(0.002);
  });

  it("sets each plan's runs aside before its AI budget, so the margin holds with every run used", () => {
    for (const id of PLAN_IDS) {
      for (const interval of ["month", "year"] as const) {
        const e = planEconomics(DEFAULT_BILLING, id, interval);
        expect(e.codeRunsUsd).toBeCloseTo(DEFAULT_BILLING.plans[id].codeRunsPerPeriod * maxCodeRunCostUsd(DEFAULT_BILLING.codeRunSeconds), 3);
        if (id === "free") continue;
        expect((e.revenueUsd - e.feesUsd - e.overheadUsd - e.codeRunsUsd - e.aiBudgetUsd) / e.revenueUsd).toBeGreaterThanOrEqual(0.6);
      }
    }
    const noRuns = planEconomics({ ...DEFAULT_BILLING, plans: { ...DEFAULT_BILLING.plans, pro: { ...DEFAULT_BILLING.plans.pro, codeRunsPerPeriod: 0 } } }, "pro");
    expect(noRuns.aiBudgetUsd).toBeGreaterThan(planEconomics(DEFAULT_BILLING, "pro").aiBudgetUsd);
  });

  it("validates the run settings", () => {
    expect(validateBilling({ codeRunSeconds: 500 }).ok).toBe(false);
    expect(validateBilling({ plans: { pro: { codeRunsPerPeriod: -1 } } }).ok).toBe(false);
    expect(validateBilling({ codeRunSeconds: 60, codeRunsSiteMonthly: 0 }).ok).toBe(true);
  });
});

describe("code_run_status (counts, in the real migrations)", () => {
  const ALICE = "11111111-1111-4111-8111-111111111111";
  const BOB = "22222222-2222-4222-8222-222222222222";
  const rid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  let db: PGlite;

  async function as<T>(user: string, fn: () => Promise<T>): Promise<T> {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${user}', false); set role authenticated;`);
    try {
      return await fn();
    } finally {
      await db.exec("reset role");
    }
  }

  /** As the server (service role): usage records are written by the server, never by the user's own session. */
  async function asServer<T>(user: string, fn: () => Promise<T>): Promise<T> {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${user}', false);`);
    try {
      return await fn();
    } finally {
      await db.exec("reset role");
    }
  }
  type S = { user_runs: number; user_in_flight: number; site_runs: number };
  const status = (user: string) => as(user, async () => (await db.query<{ s: S }>("select public.code_run_status(date_trunc('month', now())) as s")).rows[0]!.s);
  const hold = (user: string, id: string) =>
    as(user, () =>
      db.query("select public.usage_reserve_v4($1, 0, 200, 1100, 0.0016, 0, null, null, false, 0, 0, date_trunc('month', now()), 4, 20, 'code_run', null, 120, null, null)", [id]),
    );
  const record = (user: string, id: string) =>
    asServer(user, () =>
      db.query("insert into public.model_runs (model_id, status, units, estimated_cost, input_tokens, output_tokens, request_id, tools, purpose) values ('vercel:sandbox', 'success', 0, 0.0002, 0, 0, $1, '{code_run}', 'code_run')", [id]),
    );

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin;
      create schema auth;
      create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$;
      grant usage on schema auth to anon, authenticated;
      grant execute on function auth.uid() to anon, authenticated;
    `);
    const migrations = join(__dirname, "..", "supabase", "migrations");
    for (const f of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) await db.exec(readFileSync(join(migrations, f), "utf8"));
    await db.exec(`
      grant usage on schema public to anon, authenticated;
      grant select, insert, update, delete on all tables in schema public to authenticated;
      insert into auth.users (id, email) values ('${ALICE}', 'alice@example.com'), ('${BOB}', 'bob@example.com');
    `);
  }, 60_000);

  beforeEach(async () => {
    await db.exec("delete from public.usage_holds; delete from public.model_runs;");
  });

  it("counts the caller's recorded runs and runs still in flight, and everyone's runs for the site", async () => {
    await hold(ALICE, rid(1));
    expect(await status(ALICE)).toEqual({ user_runs: 0, user_in_flight: 1, site_runs: 1 });
    await record(ALICE, rid(1));
    // Once recorded, the run counts once (not also as in flight).
    expect(await status(ALICE)).toEqual({ user_runs: 1, user_in_flight: 0, site_runs: 1 });
    await hold(BOB, rid(2));
    expect(await status(BOB)).toEqual({ user_runs: 0, user_in_flight: 1, site_runs: 2 });
    expect(await status(ALICE)).toMatchObject({ user_runs: 1, user_in_flight: 0 });
  });

  it("sees concurrent runs' holds, so parallel requests can't slip past the allowance", async () => {
    await hold(ALICE, rid(3));
    await hold(ALICE, rid(4));
    expect((await status(ALICE)).user_in_flight).toBe(2);
    // A released hold stops counting as in flight.
    await as(ALICE, () => db.query("select public.usage_finish($1, 'released')", [rid(4)]));
    expect((await status(ALICE)).user_in_flight).toBe(1);
  });

  it("ignores other usage and needs a signed-in caller", async () => {
    await asServer(ALICE, () => db.query("insert into public.model_runs (model_id, status, units, estimated_cost) values ('anthropic:m', 'success', 1, 0.01)"));
    expect(await status(ALICE)).toEqual({ user_runs: 0, user_in_flight: 0, site_runs: 0 });
    await db.exec("select set_config('request.jwt.claim.sub', '', false)");
    await expect(db.query("select public.code_run_status(now())")).rejects.toThrow(/Sign in required/);
  });
});
