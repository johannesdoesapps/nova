/**
 * The coding agent's task lifecycle, end to end through the engine with an
 * in-memory database, project and computer, and a scripted model: a full
 * inspect → plan → approve → edit → test → finish run; the native tool
 * conversation staying consistent; and the bounds and recovery paths —
 * step, token and test-attempt limits, repeated actions, a retried request,
 * a provider failure, an interrupted step, cancellation, refusals and
 * replies cut off at the output limit. Commands take one poll (1.5 s).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelInfo, ToolTurnParams, ToolTurnResult } from "@/lib/ai/types";
import type { RunRow } from "@/lib/code/agent/runs";
import type { AgentChange, AgentEvent } from "@/lib/code/agent/types";

// ---------------------------------------------------------------- fakes

const MODEL: ModelInfo = {
  id: "claude-haiku-5-5",
  provider: "anthropic",
  providerModelId: "claude-haiku-5-5",
  displayName: "Claude Haiku 5.5",
  description: "",
  capabilities: ["coding"],
  contextWindow: 1_000_000,
  inputPrice: 0.1,
  outputPrice: 0.5,
  isEnabled: true,
  lastVerifiedAt: null,
};
const JSON_MODEL: ModelInfo = { ...MODEL, id: "deepseek-flash", provider: "deepseek", providerModelId: "deepseek-flash", displayName: "DeepSeek Flash", inputPrice: null, outputPrice: null };

type Turn = Partial<ToolTurnResult> | ((p: ToolTurnParams) => Partial<ToolTurnResult> | Promise<Partial<ToolTurnResult>>);
const script: { turns: Turn[]; seen: ToolTurnParams[]; json: string[]; model: ModelInfo } = { turns: [], seen: [], json: [], model: MODEL };
const call = (name: string, args: Record<string, unknown> = {}, id = `toolu_${Math.random().toString(36).slice(2, 8)}`) => ({ id, name, args });
const turn = (text: string, ...calls: ReturnType<typeof call>[]): Partial<ToolTurnResult> => ({ text, calls, stop: calls.length ? "tool_use" : "end_turn" });

const toolTurn = vi.fn(async (p: ToolTurnParams): Promise<ToolTurnResult> => {
  script.seen.push(structuredClone(p));
  const next = script.turns.shift();
  if (!next) throw new Error("the script ran out of turns");
  const r = typeof next === "function" ? await next(p) : next;
  return { text: "", calls: [], stop: "end_turn", servedModel: MODEL.providerModelId, usage: { inputTokens: 1000, outputTokens: 100, estimated: false }, ...r };
});
const generate = vi.fn(async () => ({ text: script.json.shift() ?? "", usage: { inputTokens: 500, outputTokens: 50, estimated: false }, simulated: false }));

vi.mock("@/lib/ai", () => ({
  getProvider: (id: string) => (id === "anthropic" ? { id, toolTurn, generate } : { id, generate }),
  resolveModelChoice: async () => ({ model: script.model, routing: null }),
  withTimeout: () => new AbortController().signal,
}));
vi.mock("@/lib/ai/platform", () => ({ autoIdFor: () => "auto:coding" }));
vi.mock("@/lib/observability", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/env", async (orig) => ({ ...(await orig<typeof import("@/lib/env")>()), serverEnv: () => ({ searchKey: undefined, searchProvider: "none" }) }));
vi.mock("@/lib/connectors/registry", () => ({ connector: () => undefined }));
vi.mock("@/lib/connectors/runtime", () => ({ getConnection: vi.fn(), runTool: vi.fn(), usable: () => false }));
vi.mock("@/lib/search/web", () => ({ webSearch: vi.fn() }));
const releaseUsage = vi.fn(async () => {});
const recordRunLater = vi.fn();
vi.mock("@/lib/usage", async (orig) => ({
  ...(await orig<typeof import("@/lib/usage")>()),
  enforceLimits: vi.fn(async () => ({})),
  planLimits: async () => ({ maxOutputTokens: 1200, historyChars: 60_000, tiers: ["standard"], webSearchesLeft: 0 }),
  recordRunLater: (...a: unknown[]) => recordRunLater(...a),
  releaseUsage: () => releaseUsage(),
}));

// The project and its computer.
let files = new Map<string, string>();
let computerOn = true;
const commands: string[] = [];
let commandOutput: (cmd: string) => { output: string; exitCode: number } = () => ({ output: "", exitCode: 0 });
vi.mock("@/lib/code/server", async (orig) => ({
  ...(await orig<typeof import("@/lib/code/server")>()),
  getProjectRow: async (_a: unknown, id: string) => ({ id, name: "calc", runCommand: "npm start", template: "node", createdAt: "", updatedAt: "" }),
  getFiles: async () => [...files].map(([path, content]) => ({ path, content })).sort((a, b) => a.path.localeCompare(b.path)),
  applyFileChanges: async (_a: unknown, _p: string, cs: { path: string; content: string | null }[]) => {
    for (const c of cs) {
      if (c.content === null) files.delete(c.path);
      else files.set(c.path, c.content);
    }
  },
  optionalBox: async () => (computerOn ? { sandboxId: "box" } : null),
  syncBack: vi.fn(),
}));
const jobs = new Map<string, { output: string; exitCode: number; read: boolean }>();
vi.mock("@/lib/code/workspace", () => ({
  startJob: async (_b: unknown, jobId: string, cmd: string) => {
    commands.push(cmd);
    jobs.set(jobId, { ...commandOutput(cmd), read: false });
  },
  readJob: async (_b: unknown, jobId: string, offset: number) => {
    const j = jobs.get(jobId)!;
    const output = j.read ? "" : j.output;
    j.read = true;
    return { done: true, output, offset: offset + output.length, exitCode: j.exitCode, startedAt: Date.now() };
  },
  killJob: async () => {},
  claimSync: async () => false,
  removeFromWorkspace: async () => {},
  writeToWorkspace: async () => {},
}));

// The database, in memory.
const db = {
  runs: new Map<string, RunRow>(),
  events: [] as (AgentEvent & { runId: string })[],
  changes: [] as (AgentChange & { runId: string })[],
  checkpoints: [] as { id: string; runId: string; label: string; files: Record<string, string | null>; createdAt: string }[],
};
vi.mock("@/lib/code/agent/runs", async (orig) => {
  const real = await orig<typeof import("@/lib/code/agent/runs")>();
  const get = (id: string) => {
    const r = db.runs.get(id);
    if (!r) throw new Error("no run");
    return r;
  };
  return {
    ...real,
    getRun: async (_a: unknown, id: string) => structuredClone(get(id)),
    runStatus: async (_a: unknown, id: string) => get(id).status,
    updateRun: async (_a: unknown, id: string, patch: Partial<RunRow>) => {
      Object.assign(get(id), structuredClone(patch), { updated_at: new Date().toISOString() });
      return structuredClone(get(id));
    },
    lockRun: async (_a: unknown, id: string, statuses: string[], now = Date.now()) => {
      const r = get(id);
      if (!statuses.includes(r.status) || (r.locked_until && Date.parse(r.locked_until) > now)) return null;
      r.locked_until = new Date(now + 300_000).toISOString();
      return structuredClone(r);
    },
    addEvents: async (_a: unknown, runId: string, evs: { kind: AgentEvent["kind"]; title: string; detail?: Record<string, unknown> | null }[]) => {
      for (const e of evs) {
        const seq = db.events.filter((x) => x.runId === runId).length + 1;
        db.events.push({
          runId,
          id: `e${seq}`,
          seq,
          kind: e.kind,
          title: real.scrub(e.title),
          detail: e.detail ? JSON.parse(real.scrub(JSON.stringify(e.detail))) : null,
          createdAt: new Date().toISOString(),
        });
      }
    },
    listEvents: async (_a: unknown, runId: string, after = 0) => db.events.filter((e) => e.runId === runId && e.seq > after),
    listChanges: async (_a: unknown, runId: string) => db.changes.filter((c) => c.runId === runId),
    recordChanges: async (_a: unknown, runId: string, cs: { path: string; before: string | null; after: string | null }[]) => {
      for (const c of cs) {
        const ex = db.changes.find((x) => x.runId === runId && x.path === c.path);
        if (ex) Object.assign(ex, { after: c.after, revertedAt: null });
        else db.changes.push({ runId, id: `c${db.changes.length + 1}`, path: c.path, before: c.before, after: c.after, revertedAt: null, updatedAt: "" });
      }
    },
    markReverted: async () => {},
    listCheckpoints: async (_a: unknown, runId: string) => db.checkpoints.filter((c) => c.runId === runId),
    createCheckpoint: async (_a: unknown, runId: string, label: string, f: Record<string, string | null>) => {
      const cp = { id: `cp${db.checkpoints.length + 1}`, runId, label, files: f, createdAt: new Date().toISOString() };
      db.checkpoints.push(cp);
      return cp;
    },
  };
});

const { stepRun, respondToRun, cancelRun, addUsage } = await import("@/lib/code/agent/engine");
const { scrub } = await import("@/lib/code/agent/runs");

const auth = { mode: "authenticated", userId: "u1" } as never;
const req = () => new Request("https://tryorbis.app/api/code/agent/x/step", { method: "POST" });

let runSeq = 0;
function newRun(o: Partial<RunRow> = {}): string {
  const id = `00000000-0000-4000-8000-${String(++runSeq).padStart(12, "0")}`;
  db.runs.set(id, {
    id,
    project_id: "p1",
    request: "Fix the failing test in sum.js",
    status: "planning",
    options: { approvePlans: true, reviewEdits: false, commands: "safe", modelId: null },
    plan: null,
    pending: null,
    transcript: [],
    summary: null,
    error: null,
    steps: 0,
    step_limit: 20,
    locked_until: null,
    token_budget: 600_000,
    usage: {},
    active_ms: 0,
    time_limit_ms: 1_800_000,
    tests: null,
    recent: [],
    last_edit_at: null,
    report: null,
    created_at: "",
    updated_at: "",
    ...o,
  });
  return id;
}
const run = (id: string) => db.runs.get(id)!;
const events = (id: string) => db.events.filter((e) => e.runId === id);

const FAILING = " ❯ sum.test.js (2 tests | 1 failed)\n   × sum > adds negatives\n      Tests  1 failed | 1 passed (2)\n";
const PASSING = "      Tests  2 passed (2)\n";

beforeEach(() => {
  script.turns = [];
  script.seen = [];
  script.json = [];
  script.model = MODEL;
  toolTurn.mockClear();
  generate.mockClear();
  releaseUsage.mockClear();
  recordRunLater.mockClear();
  files = new Map([
    ["package.json", '{"name":"calc","scripts":{"test":"vitest run"}}'],
    ["sum.js", "export const sum = (a, b) => a - b;\n"],
    ["sum.test.js", "test('adds negatives', () => expect(sum(-1, -2)).toBe(-3));\n"],
  ]);
  computerOn = true;
  commands.length = 0;
  commandOutput = (cmd) => (cmd === "npm test" ? (files.get("sum.js")!.includes("a + b") ? { output: PASSING, exitCode: 0 } : { output: FAILING, exitCode: 1 }) : { output: "", exitCode: 0 });
});

// ---------------------------------------------------------------- the whole loop

describe("a coding task from request to verified report", () => {
  it("inspects, plans, waits for approval, fixes, tests, finishes, and reports what really happened", async () => {
    const id = newRun();
    script.turns.push(
      turn("Looking at the project.", call("inspect_project"), call("read_files", { paths: ["sum.js", "sum.test.js"] }), call("run_tests")),
      turn("sum subtracts. Plan it.", call("propose_plan", { summary: "Make sum add.", steps: ["Change - to +", "Run the tests"] })),
    );
    const first = await stepRun(req(), auth, id, { expectStep: 0 });
    // Before the plan is approved, the agent is read-only: run_tests is refused, nothing ran.
    expect(first.run.status).toBe("awaiting_approval");
    expect(first.run.pending).toEqual({ kind: "plan" });
    expect(commands).toEqual([]);
    const firstResults = run(id).transcript[2]!.results!;
    expect(firstResults.map((r) => r.ok)).toEqual([true, true, false]);
    expect(firstResults[2]!.text).toContain("Not allowed yet");

    await respondToRun(auth, id, { decision: "approve" });
    expect(run(id).status).toBe("running");

    script.turns.push(
      turn("Fixing.", call("edit_file", { path: "sum.js", search: "a - b", replace: "a + b" }), call("inspect_diff")),
      turn("Testing.", call("run_tests")),
      turn("Done.", call("finish", { summary: "sum now adds; the tests pass." })),
    );
    const done = await stepRun(req(), auth, id, { expectStep: 2 });
    expect(done.run.status).toBe("completed");
    expect(files.get("sum.js")).toBe("export const sum = (a, b) => a + b;\n");
    expect(commands).toEqual(["npm test"]);

    const r = run(id);
    expect(r.report).toMatchObject({
      outcome: "completed",
      summary: "sum now adds; the tests pass.",
      files: [{ path: "sum.js", change: "modified", added: 1, removed: 1 }],
      commands: [{ command: "npm test", exitCode: 0, result: "succeeded" }],
      tests: { verdict: "passed", passed: 2, failed: 0, afterLastEdit: true },
      verification: "passed",
      usage: { modelCalls: 5, inputTokens: 5000, outputTokens: 500, steps: 5 },
    });
    // Haiku at $0.10 / $0.50 per million: 5,000 × 0.1 + 500 × 0.5 = $0.00075.
    expect(r.report!.usage.costUsd).toBeCloseTo(0.00075, 8);
    expect(r.tests).toMatchObject({ runs: 1, failuresInRow: 0 });
    expect(events(id).map((e) => e.kind)).toEqual(expect.arrayContaining(["status", "inspect", "plan", "approval", "edit", "command", "summary"]));
    expect(recordRunLater).toHaveBeenCalledTimes(5);
  });

  it("gives the model every tool result, matched to its call, in the next turn", async () => {
    const id = newRun({ status: "running", plan: { summary: "x", steps: ["x"], approved: true } });
    script.turns.push(turn("Reading.", call("read_files", { paths: ["sum.js"] }, "toolu_a"), call("list_files", {}, "toolu_b")), turn("Done.", call("finish", { summary: "ok" })));
    await stepRun(req(), auth, id);
    const second = script.seen[1]!.messages;
    const assistant = second[1]!;
    const results = second[2]!;
    expect(assistant).toMatchObject({ role: "assistant", text: "Reading.", calls: [{ id: "toolu_a" }, { id: "toolu_b" }] });
    expect(results.role === "user" && results.results!.map((r) => r.id)).toEqual(["toolu_a", "toolu_b"]);
    // The tools offered are the run's: commands are on, so run_command and run_tests are there.
    expect(script.seen[0]!.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["read_files", "edit_file", "run_tests", "restore_checkpoint", "finish"]));
  });

  it("works the same with a model that answers in the JSON format", async () => {
    script.model = JSON_MODEL;
    const id = newRun({ status: "running", plan: { summary: "x", steps: ["x"], approved: true } });
    script.json.push(
      '{"thought": "fix", "actions": [{"tool": "edit_file", "args": {"path": "sum.js", "search": "a - b", "replace": "a + b"}}]}',
      '{"thought": "done", "actions": [{"tool": "finish", "args": {"summary": "Fixed."}}]}',
    );
    await stepRun(req(), auth, id);
    expect(files.get("sum.js")).toContain("a + b");
    expect(run(id).status).toBe("completed");
    expect(run(id).transcript[1]!.calls![0]).toMatchObject({ id: "s0a0", tool: "edit_file" });
    // An unpriced model makes the cost unknown rather than zero.
    expect(run(id).report!.usage.costUsd).toBeNull();
    expect(toolTurn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- bounds

describe("bounds", () => {
  const working = () => newRun({ status: "running", plan: { summary: "x", steps: ["x"], approved: true } });

  it("pauses at the step limit and goes on only when the user allows more", async () => {
    const id = working();
    db.runs.get(id)!.step_limit = 1;
    script.turns.push(turn("Look.", call("list_files")));
    const r = await stepRun(req(), auth, id);
    expect(r.run).toMatchObject({ status: "needs_input", pending: { kind: "limit", reason: "steps" } });
    expect(toolTurn).toHaveBeenCalledTimes(1);
    await respondToRun(auth, id, { decision: "continue" });
    expect(run(id).step_limit).toBe(11);
    expect(run(id).status).toBe("running");
  });

  it("pauses when the token budget is used up, before spending more", async () => {
    const id = working();
    db.runs.get(id)!.token_budget = 10_000;
    script.turns.push({ ...turn("Big.", call("list_files")), usage: { inputTokens: 9_500, outputTokens: 600, estimated: false } });
    const r = await stepRun(req(), auth, id);
    expect(r.run.pending).toMatchObject({ kind: "limit", reason: "tokens" });
    expect(r.run.usage.inputTokens + r.run.usage.outputTokens).toBe(10_100);
    expect(toolTurn).toHaveBeenCalledTimes(1);
    await respondToRun(auth, id, { decision: "continue" });
    expect(run(id).token_budget).toBe(310_000);
  });

  it("pauses after the tests fail three times in a row", async () => {
    const id = working();
    // Each attempt edits something (not the bug) and runs the tests again.
    script.turns.push(
      turn("t1", call("run_tests")),
      turn("t2", call("write_file", { path: "notes.txt", content: "try 2" }), call("run_tests")),
      turn("t3", call("write_file", { path: "notes.txt", content: "try 3" }), call("run_tests")),
    );
    const r = await stepRun(req(), auth, id);
    expect(commands).toEqual(["npm test", "npm test", "npm test"]);
    expect(r.run.pending).toMatchObject({ kind: "limit", reason: "tests" });
    expect(r.run.tests).toMatchObject({ failuresInRow: 3, runs: 3, last: { verdict: "failed", failures: ["sum > adds negatives"] } });
    await respondToRun(auth, id, { decision: "continue" });
    expect(run(id).tests!.attemptLimit).toBe(5);
  }, 20_000);

  it("stops an agent repeating the same actions, without running them a third time", async () => {
    const id = working();
    const same = () => turn("Again.", call("read_files", { paths: ["sum.js"] }));
    script.turns.push(same(), same(), same());
    const r = await stepRun(req(), auth, id);
    expect(r.run.pending).toMatchObject({ kind: "limit", reason: "repeat" });
    const reads = events(id).filter((e) => e.kind === "inspect");
    expect(reads).toHaveLength(2);
    expect(run(id).transcript.at(-1)!.results![0]!.text).toContain("same set of actions");
    await respondToRun(auth, id, { decision: "continue" });
    expect(run(id).recent).toEqual([]);
  });

  it("runs none of the actions in a reply cut off at the output limit", async () => {
    const id = working();
    script.turns.push({ text: "", calls: [call("write_file", { path: "big.js", content: "partial" })], stop: "max_tokens" }, turn("ok", call("finish", { summary: "Stopped." })));
    await stepRun(req(), auth, id);
    expect(files.has("big.js")).toBe(false);
    expect(run(id).transcript[2]!.results![0]!.text).toContain("cut off");
    expect(run(id).transcript[2]!.content).toContain("output limit");
  });
});

// ---------------------------------------------------------------- recovery

describe("recovery", () => {
  const working = () => newRun({ status: "running", plan: { summary: "x", steps: ["x"], approved: true } });

  it("never repeats a step when a request is retried", async () => {
    const id = working();
    script.turns.push(turn("Look.", call("list_files")), turn("Done.", call("finish", { summary: "ok" })));
    await stepRun(req(), auth, id, { expectStep: 0 });
    const calls = toolTurn.mock.calls.length;
    const again = await stepRun(req(), auth, id, { expectStep: 0 });
    expect(again.skipped).toBe("not_working");
    const id2 = working();
    db.runs.get(id2)!.step_limit = 1;
    script.turns.push(turn("Look.", call("list_files")));
    await stepRun(req(), auth, id2, { expectStep: 0 });
    db.runs.get(id2)!.status = "running";
    expect((await stepRun(req(), auth, id2, { expectStep: 0 })).skipped).toBe("stale");
    expect(toolTurn.mock.calls.length).toBe(calls + 1);
    expect(run(id2).locked_until).toBeNull();
  });

  it("doesn't run a step while another holds the run", async () => {
    const id = working();
    db.runs.get(id)!.locked_until = new Date(Date.now() + 60_000).toISOString();
    expect((await stepRun(req(), auth, id)).skipped).toBe("busy");
    expect(toolTurn).not.toHaveBeenCalled();
  });

  it("doesn't count a step the model failed to answer, releases the usage hold, and carries on afterwards", async () => {
    const id = working();
    script.turns.push(() => {
      throw new Error("529 overloaded");
    });
    await expect(stepRun(req(), auth, id)).rejects.toMatchObject({ code: "upstream_error" });
    expect(releaseUsage).toHaveBeenCalledTimes(1);
    expect(run(id)).toMatchObject({ steps: 0, status: "running", locked_until: null });
    expect(events(id).at(-1)!.title).toContain("didn't answer");
    script.turns.push(turn("Done.", call("finish", { summary: "ok" })));
    expect((await stepRun(req(), auth, id)).run.status).toBe("completed");
  });

  it("recovers an interrupted step by telling the model which actions may or may not have run", async () => {
    const id = working();
    db.runs.get(id)!.transcript = [
      { role: "user", content: "Request: fix sum" },
      { role: "assistant", content: "Editing.", calls: [{ id: "toolu_x", tool: "edit_file", args: { path: "sum.js", search: "a - b", replace: "a + b" } }] },
    ];
    script.turns.push(turn("Checking first.", call("git_status")), turn("Done.", call("finish", { summary: "ok" })));
    await stepRun(req(), auth, id);
    const sent = script.seen[0]!.messages;
    expect(sent[2]).toMatchObject({ role: "user", results: [{ id: "toolu_x", ok: false }] });
    expect(sent[2]!.role === "user" && sent[2]!.results![0]!.text).toContain("may or may not have run");
    expect(events(id).some((e) => e.title.includes("Recovered from an interrupted step"))).toBe(true);
  });

  it("stops when the user cancels while the model is thinking, without running what it asked for", async () => {
    const id = working();
    script.turns.push(() => {
      db.runs.get(id)!.status = "cancelled";
      return turn("Deleting.", call("delete_file", { path: "sum.js" }));
    });
    const r = await stepRun(req(), auth, id);
    expect(r.run.status).toBe("cancelled");
    expect(files.has("sum.js")).toBe(true);
    expect(run(id).report).toMatchObject({ outcome: "cancelled", verification: "not_run", files: [] });
  });

  it("cancels a run that's waiting, and writes its report", async () => {
    const id = newRun({ status: "awaiting_approval", pending: { kind: "plan" } });
    const v = await cancelRun(auth, id);
    expect(v.status).toBe("cancelled");
    expect(v.report).toMatchObject({ outcome: "cancelled" });
    expect((await stepRun(req(), auth, id)).skipped).toBe("not_working");
  });

  it("ends the run honestly when the model declines the request", async () => {
    const id = working();
    script.turns.push({ text: "", calls: [], stop: "refusal" });
    const r = await stepRun(req(), auth, id);
    expect(r.run).toMatchObject({ status: "failed" });
    expect(r.run.error).toContain("declined");
    expect(r.run.report).toMatchObject({ outcome: "failed", verification: "not_run" });
  });
});

describe("accounting and secrets", () => {
  it("adds up tokens and cost per call, and marks estimates", () => {
    const u1 = addUsage({ inputTokens: 0, outputTokens: 0, costUsd: 0, modelCalls: 0, models: [] }, MODEL, { inputTokens: 2_000_000, outputTokens: 1_000_000, estimated: false }, 0, 0);
    expect(u1).toMatchObject({ inputTokens: 2_000_000, outputTokens: 1_000_000, costUsd: 0.7, modelCalls: 1, models: ["Claude Haiku 5.5"] });
    const u2 = addUsage(u1, MODEL, { inputTokens: null, outputTokens: null, estimated: true }, 4_000, 400);
    expect(u2).toMatchObject({ inputTokens: 2_001_000, outputTokens: 1_000_100, estimated: true });
    expect(addUsage(u2, JSON_MODEL, { inputTokens: 1, outputTokens: 1, estimated: false }, 0, 0).costUsd).toBeNull();
  });

  it("removes credentials from what the activity log keeps", () => {
    const text = scrub("token ghp_abcdefghijklmnopqrstuvwxyz0123456789 and AKIAABCDEFGHIJKLMNOP and sk-ant-api03-abcdefghijklmnopqrstuvwxyz and Bearer abcdefghijklmnopqrstuvwxyz123456");
    expect(text).not.toMatch(/ghp_abc|AKIAABCD|sk-ant-api03-abc|abcdefghijklmnopqrstuvwxyz123456/);
  });
});
