/**
 * The coding agent's task lifecycle, end to end through the engine with an
 * in-memory database, project and computer, and a scripted model: a full
 * inspect → plan → approve → edit → test → finish run; the native tool
 * conversation staying consistent; and the bounds and recovery paths —
 * step, token and test-attempt limits, repeated actions, a retried request,
 * a provider failure, an interrupted step, cancellation, refusals and
 * replies cut off at the output limit. Commands take one poll (1.5 s).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const script: { turns: Turn[]; seen: ToolTurnParams[]; json: string[]; model: ModelInfo; needs?: string[]; requested: string[]; streamed: { messages: { role: string; content: string }[] }[]; replies: (string | Error | ((p: { messages: { role: string; content: string }[] }) => string))[] } = {
  turns: [],
  seen: [],
  json: [],
  model: MODEL,
  requested: [],
  streamed: [],
  replies: [],
};
/** Pair coding's streamed replies, in order (an Error is thrown instead). */
async function* stream(p: { messages: { role: string; content: string }[] }) {
  script.streamed.push(structuredClone(p));
  const next = script.replies.shift();
  if (next === undefined) throw new Error("the script ran out of pair replies");
  if (next instanceof Error) throw next;
  const text = typeof next === "function" ? next(p) : next;
  yield { type: "delta" as const, text: text.slice(0, Math.ceil(text.length / 2)) };
  yield { type: "delta" as const, text: text.slice(Math.ceil(text.length / 2)) };
  yield { type: "usage" as const, usage: { inputTokens: 800, outputTokens: 200, estimated: false } };
}
const call = (name: string, args: Record<string, unknown> = {}, id = `toolu_${Math.random().toString(36).slice(2, 8)}`) => ({ id, name, args });
const turn = (text: string, ...calls: ReturnType<typeof call>[]): Partial<ToolTurnResult> => ({ text, calls, stop: calls.length ? "tool_use" : "end_turn" });

/** The time limit given to each model call, in order. */
const timeouts: number[] = [];
const toolTurn = vi.fn(async (p: ToolTurnParams): Promise<ToolTurnResult> => {
  script.seen.push(structuredClone(p));
  const next = script.turns.shift();
  if (!next) throw new Error("the script ran out of turns");
  const r = typeof next === "function" ? await next(p) : next;
  return { text: "", calls: [], stop: "end_turn", servedModel: MODEL.providerModelId, usage: { inputTokens: 1000, outputTokens: 100, estimated: false }, ...r };
});
const generate = vi.fn(async () => ({ text: script.json.shift() ?? "", usage: { inputTokens: 500, outputTokens: 50, estimated: false }, simulated: false }));

// Bastion's controls as stored when an administrator hasn't changed anything (tests/bastion.test.ts covers the rest).
const bastion = vi.hoisted(() => ({ controls: undefined as unknown, workspace: undefined as unknown }));
vi.mock("@/lib/bastion/controls", async () => {
  const { DEFAULT_CONTROLS } = await import("@/lib/bastion/policy");
  return (await import("./stubs/bastion-controls")).defaultBastionControls({
    controls: () => (bastion.controls === undefined ? DEFAULT_CONTROLS : bastion.controls),
    workspace: () => bastion.workspace,
  });
});
vi.mock("@/lib/ai", () => ({
  getProvider: (id: string) => (id === "anthropic" ? { id, toolTurn, generate, stream } : { id, generate, stream }),
  resolveModelChoice: async (id: string, ctx: { needs?: string[] }) => {
    script.needs = ctx.needs ?? [];
    script.requested.push(id);
    return { model: script.model, routing: null };
  },
  withTimeout: (ms: number) => {
    timeouts.push(ms);
    return new AbortController().signal;
  },
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
const runCommands: string[] = [];
let commandOutput: (cmd: string) => { output: string; exitCode: number; running?: boolean } = () => ({ output: "", exitCode: 0 });
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
  setRunCommand: async (_a: unknown, _p: string, cmd: string) => void runCommands.push(cmd),
}));
const jobs = new Map<string, { output: string; exitCode: number; read: boolean; running?: boolean }>();
const killed: string[] = [];
/** Added to Date.now() by tests about long commands: each read of a running command moves the clock on 61 s. */
const clock = { skew: 0 };
vi.mock("@/lib/code/workspace", () => ({
  startJob: async (_b: unknown, jobId: string, cmd: string) => {
    commands.push(cmd);
    jobs.set(jobId, { ...commandOutput(cmd), read: false });
  },
  readJob: async (_b: unknown, jobId: string, offset: number) => {
    const j = jobs.get(jobId)!;
    if (j.running) {
      clock.skew += 61_000;
      return { done: false, output: "", offset, exitCode: null, startedAt: Date.now() };
    }
    const output = j.read ? "" : j.output;
    j.read = true;
    return { done: true, output, offset: offset + output.length, exitCode: j.exitCode, startedAt: Date.now() };
  },
  killJob: async (_b: unknown, jobId: string) => void killed.push(jobId),
  claimSync: async () => false,
  removeFromWorkspace: async () => {},
  writeToWorkspace: async () => {},
}));

// The live preview: the server and the browser check, scripted.
const preview = {
  starts: [] as string[],
  checks: [] as string[],
  problems: [["Phone: the page scrolls sideways by 120px."]] as string[][],
  /** Set to make the server exit at once with this output (a missing dependency, say). */
  exitWith: null as string | null,
  /** Set to make the browser fail to run. */
  checkError: null as string | null,
};
vi.mock("@/lib/code/preview", () => ({
  PREVIEW_START_MS: 90_000,
  startPreview: async (_b: unknown, cmd: string) => {
    preview.starts.push(cmd);
    if (preview.exitWith) return { state: "exited", http: 0, exitCode: 127, log: preview.exitWith, waitedMs: 300, otherPorts: [] };
    return { state: "running", http: 200, exitCode: null, log: "Serving HTTP on 0.0.0.0 port 3000", waitedMs: 1500, otherPorts: [] };
  },
  describeStart: (s: { http: number; state: string; log: string }, cmd: string) =>
    s.state === "running" ? `The preview server is running: \`${cmd}\` answered with HTTP ${s.http}.` : `The preview server stopped: \`${cmd}\` exited.\nServer output (end):\n${s.log}`,
  runPreviewCheck: async (_b: unknown, path: string) => {
    preview.checks.push(path);
    if (preview.checkError) return { url: path, viewports: [], links: [], error: preview.checkError };
    const problems = preview.problems.shift() ?? [];
    return {
      url: path,
      viewports: [
        {
          name: "desktop",
          width: 1280,
          height: 800,
          status: 200,
          title: "Nova",
          consoleErrors: [],
          pageErrors: [],
          failedRequests: [],
          external: [],
          overflowX: 0,
          wide: [],
          page: { headings: ["h1: Nova"], nav: [], buttons: [], images: 0, imagesWithoutAlt: 0, brokenImages: [], brokenAnchors: [], placeholders: [], forms: [], height: 900, textLength: 900, viewportMeta: true, lang: "en" },
        },
        {
          name: "phone",
          width: 390,
          height: 844,
          status: 200,
          title: "Nova",
          consoleErrors: [],
          pageErrors: [],
          failedRequests: [],
          external: [],
          overflowX: problems.length ? 120 : 0,
          wide: problems.length ? ["div.hero"] : [],
          page: { headings: ["h1: Nova"], nav: [], buttons: [], images: 0, imagesWithoutAlt: 0, brokenImages: [], brokenAnchors: [], placeholders: [], forms: [], height: 1400, textLength: 900, viewportMeta: true, lang: "en" },
        },
      ],
      links: [],
      shots: [{ name: "phone", data: "SU1H", caption: "phone, first screen" }],
      error: null,
    };
  },
}));

// The database, in memory.
const db = {
  runs: new Map<string, RunRow>(),
  events: [] as (AgentEvent & { runId: string })[],
  changes: [] as (AgentChange & { runId: string })[],
  checkpoints: [] as { id: string; runId: string; label: string; files: Record<string, string | null>; createdAt: string }[],
  /** Set to make the user's Stop land just before the next write to a run (between the engine's read and its write). */
  stopBeforeNextWrite: false,
  /** Earlier sessions are listed (for follow-ups) only in tests that turn this on, so other tests' runs don't leak in. */
  history: false,
};
vi.mock("@/lib/code/agent/runs", async (orig) => {
  const real = await orig<typeof import("@/lib/code/agent/runs")>();
  const get = (id: string) => {
    const r = db.runs.get(id);
    if (!r) throw new Error("no run");
    return r;
  };
  const stopIfDue = (id: string) => {
    if (db.stopBeforeNextWrite) Object.assign(get(id), { status: "cancelled", pending: null });
    db.stopBeforeNextWrite = false;
  };
  return {
    ...real,
    getRun: async (_a: unknown, id: string) => structuredClone(get(id)),
    runStatus: async (_a: unknown, id: string) => get(id).status,
    updateRun: async (_a: unknown, id: string, patch: Partial<RunRow>) => {
      stopIfDue(id);
      Object.assign(get(id), structuredClone(patch), { updated_at: new Date().toISOString() });
      return structuredClone(get(id));
    },
    updateRunIfNotCancelled: async (_a: unknown, id: string, patch: Partial<RunRow>) => {
      stopIfDue(id);
      if (get(id).status === "cancelled") return null;
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
      const seqs: number[] = [];
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
        seqs.push(seq);
      }
      return seqs;
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
    listRuns: async (_a: unknown, projectId: string, limit = 8) => (db.history ? [...db.runs.values()].filter((r) => r.project_id === projectId).reverse().slice(0, limit).map((r) => structuredClone(r)) : []),
    openRun: async (_a: unknown, projectId: string) => {
      const open = [...db.runs.values()].find((r) => r.project_id === projectId && !["completed", "failed", "cancelled"].includes(r.status));
      return open ? real.toRunView(open) : null;
    },
    listCheckpoints: async (_a: unknown, runId: string) => db.checkpoints.filter((c) => c.runId === runId),
    createCheckpoint: async (_a: unknown, runId: string, label: string, f: Record<string, string | null>) => {
      const cp = { id: `cp${db.checkpoints.length + 1}`, runId, label, files: f, createdAt: new Date().toISOString() };
      db.checkpoints.push(cp);
      return cp;
    },
  };
});

// Attachments: an in-memory stand-in for the table.
const attachmentRows = { list: [] as { id: string; name: string; kind: "text" | "image"; mediaType: string; size: number; content: string }[] };
vi.mock("@/lib/code/attachments-store", () => ({ runAttachments: async () => structuredClone(attachmentRows.list) }));

// Project memory: an in-memory stand-in for the table.
const memory = { notes: [] as import("@/lib/code/memory").MemoryEntry[], added: [] as Record<string, unknown>[] };
vi.mock("@/lib/code/memory-store", () => ({
  listMemory: async () => structuredClone(memory.notes),
  addMemory: async (_a: unknown, _p: string, e: Record<string, unknown>) => {
    memory.added.push(e);
    return { id: `mem${memory.added.length}`, always: false, status: "active", source: "user", runId: null, createdAt: "", updatedAt: "", ...e };
  },
}));

const { stepRun, respondToRun, cancelRun, addUsage, reverifyRun } = await import("@/lib/code/agent/engine");
const { taskState, checklistOf, fixRequest, assessReport } = await import("@/lib/code/agent/verdict");
const { toRunView } = await import("@/lib/code/agent/runs");
const { scrub } = await import("@/lib/code/agent/runs");
const real = await vi.importActual<typeof import("@/lib/code/agent/runs")>("@/lib/code/agent/runs");

const auth = { mode: "authenticated", userId: "u1", user: { id: "u1" }, supabase: null } as never;
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
    checks: null,
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
  bastion.controls = undefined;
  bastion.workspace = undefined;
  attachmentRows.list = [];
  memory.notes = [];
  memory.added = [];
  script.turns = [];
  script.seen = [];
  script.json = [];
  script.model = MODEL;
  script.requested = [];
  script.streamed = [];
  script.replies = [];
  toolTurn.mockClear();
  timeouts.length = 0;
  generate.mockClear();
  releaseUsage.mockClear();
  recordRunLater.mockClear();
  db.stopBeforeNextWrite = false;
  db.history = false;
  preview.exitWith = null;
  preview.checkError = null;
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

describe("building a website", () => {
  it("writes the site, starts the preview, checks it in a browser, fixes what the check found, and reports the checks that really ran", async () => {
    files = new Map([["index.html", "<h1>Hello from Orbis</h1>\n"]]);
    preview.problems = [["overflow"], []];
    const id = newRun({ status: "running", request: "Build a landing page for Nova", options: { approvePlans: false, reviewEdits: false, commands: "safe", modelId: null, web: true } });
    const page = "<!doctype html>\n<html lang=\"en\"><main><h1>Nova</h1><div class=\"hero\">…</div></main></html>\n".repeat(40);
    script.turns.push(
      turn("Writing the page.", call("write_file", { path: "index.html", content: page }), call("start_preview", { command: "python3 -m http.server 3000" })),
      turn("Checking it.", call("check_preview", {})),
      (p) => {
        // The check's screenshot reaches the model with its results.
        const last = p.messages[p.messages.length - 1]!;
        expect(last.role === "user" && last.results?.[0]?.images).toEqual([{ mediaType: "image/jpeg", data: "SU1H" }]);
        return turn("The hero is too wide on phones; fixing.", call("edit_file", { path: "index.html", search: '<div class="hero">', replace: '<div class="hero" style="max-width:100%">' }));
      },
      turn("Checking again.", call("check_preview", {})),
      turn("Done.", call("finish", { summary: "Built the Nova landing page; the browser check passes at desktop and phone sizes." })),
    );
    const r = await stepRun(req(), auth, id);
    expect(r.run.status).toBe("completed");
    expect(preview.starts).toEqual(["python3 -m http.server 3000"]);
    expect(runCommands).toEqual(["python3 -m http.server 3000"]);
    expect(preview.checks).toEqual(["/", "/"]);
    // A whole page fits in one step: the agent gets far more output room than a chat reply.
    expect(script.seen.every((p) => p.maxOutputTokens >= 12_000)).toBe(true);
    expect(script.seen[0]!.system).toContain("Building or changing a website");
    expect(script.seen[0]!.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["start_preview", "check_preview"]));
    // Earlier writes are kept out of later turns (the file is saved; the agent can read it).
    expect(JSON.stringify(script.seen[3]!.messages)).not.toContain(page);
    expect(run(id).report?.checks).toMatchObject({
      server: { command: "python3 -m http.server 3000", state: "running", http: 200 },
      preview: { verdict: "passed", problems: [], freshness: "current" },
      build: null,
    });
    expect(events(id).filter((e) => e.title.startsWith("Screenshot:"))).toHaveLength(2);
    // The stored list of recent steps stays small however big the files are.
    expect(JSON.stringify(run(id).recent).length).toBeLessThan(400);
  });
});

describe("builds that wait for the computer", () => {
  it("records a production build that ran once the user started the computer", async () => {
    computerOn = false;
    const id = newRun({ status: "running", options: { approvePlans: false, reviewEdits: false, commands: "safe", modelId: null, web: true } });
    script.turns.push(turn("Building.", call("run_command", { command: "npm install && npm run build" })));
    const r = await stepRun(req(), auth, id);
    expect(r.run.pending).toMatchObject({ kind: "computer", command: "npm install && npm run build" });
    computerOn = true;
    await respondToRun(auth, id, { decision: "continue" });
    expect(commands).toEqual(["npm install && npm run build"]);
    expect(run(id).checks?.build).toMatchObject({ command: "npm install && npm run build", exitCode: 0, passed: true });
  });
});

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

  it("stops the run at once when the provider rejects the request, with its reason", async () => {
    const { ApiError } = await import("@/lib/http");
    const id = working();
    script.turns.push(() => {
      throw new ApiError("bad_request", "GPT-5.6 Luna couldn't process this request (error 400).");
    });
    const r = await stepRun(req(), auth, id);
    expect(r.run.status).toBe("failed");
    expect(r.run.error).toContain("couldn't process this request (error 400)");
    expect(r.run.report).toMatchObject({ outcome: "failed", failure: "provider_rejected", usage: { retries: 1 } });
    expect(releaseUsage).toHaveBeenCalledTimes(1);
  });

  it("stops after three failed model calls in a row, and logs the start only once", async () => {
    const id = newRun({ status: "running", plan: { summary: "x", steps: ["x"], approved: true } });
    const busy = () => {
      throw new Error("529 overloaded");
    };
    script.turns.push(busy, busy, busy);
    await expect(stepRun(req(), auth, id)).rejects.toMatchObject({ code: "upstream_error" });
    await expect(stepRun(req(), auth, id)).rejects.toMatchObject({ code: "upstream_error" });
    const third = await stepRun(req(), auth, id);
    expect(third.run.status).toBe("failed");
    expect(third.run.error).toContain("failed 3 times in a row");
    expect(third.run.report).toMatchObject({ failure: "provider_unavailable", usage: { retries: 3 } });
    expect(events(id).filter((e) => e.title.startsWith("Started with"))).toHaveLength(1);
  });

  it("resets the failure count after a model call succeeds", async () => {
    const id = working();
    script.turns.push(() => {
      throw new Error("timeout");
    });
    await expect(stepRun(req(), auth, id)).rejects.toMatchObject({ code: "upstream_error" });
    expect(run(id).usage).toMatchObject({ modelFailuresInRow: 1 });
    script.turns.push(turn("Done.", call("finish", { summary: "ok" })));
    await stepRun(req(), auth, id);
    expect(run(id).usage).toMatchObject({ modelFailuresInRow: 0 });
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

  it("keeps a run stopped mid-step stopped: no further edits, commands or model turns", async () => {
    const id = working();
    // The user presses Stop while the first command runs.
    commandOutput = () => {
      db.runs.get(id)!.status = "cancelled";
      return { output: "", exitCode: 0 };
    };
    script.turns.push(
      turn("Check, then fix.", call("run_command", { command: "npm test" }), call("edit_file", { path: "sum.js", search: "a - b", replace: "a + b" }), call("run_tests")),
      turn("Done.", call("finish", { summary: "ok" })),
    );
    const r = await stepRun(req(), auth, id);
    expect(r.run.status).toBe("cancelled");
    expect(run(id).status).toBe("cancelled");
    expect(files.get("sum.js")).toContain("a - b");
    expect(commands).toEqual(["npm test"]);
    expect(toolTurn).toHaveBeenCalledTimes(1);
    expect(run(id).locked_until).toBeNull();
    expect((await stepRun(req(), auth, id)).skipped).toBe("not_working");
  });

  it("doesn't let the end of a step overwrite a Stop that lands while it's saving", async () => {
    const id = working();
    commandOutput = () => {
      db.stopBeforeNextWrite = true;
      return { output: "", exitCode: 0 };
    };
    script.turns.push(
      turn("Look first.", call("run_command", { command: "ls" })),
      turn("Fix.", call("edit_file", { path: "sum.js", search: "a - b", replace: "a + b" })),
    );
    const r = await stepRun(req(), auth, id);
    expect(run(id).status).toBe("cancelled");
    expect(r.run.status).toBe("cancelled");
    expect(toolTurn).toHaveBeenCalledTimes(1);
    expect(files.get("sum.js")).toContain("a - b");
    expect(run(id).locked_until).toBeNull();
    expect(run(id).report).toMatchObject({ outcome: "cancelled" });
  });

  it("cancels a run that's waiting, and writes its report", async () => {
    const id = newRun({ status: "awaiting_approval", pending: { kind: "plan" } });
    const v = await cancelRun(auth, id);
    expect(v.status).toBe("cancelled");
    expect(v.report).toMatchObject({ outcome: "cancelled" });
    expect((await stepRun(req(), auth, id)).skipped).toBe("not_working");
  });

  describe("a command longer than a step", () => {
    const realNow = Date.now.bind(Date);
    beforeEach(() => {
      clock.skew = 0;
      killed.length = 0;
      vi.spyOn(Date, "now").mockImplementation(() => realNow() + clock.skew);
      commandOutput = (cmd) => (cmd === "npm ci" ? { output: "added 812 packages\n", exitCode: 0, running: true } : { output: "", exitCode: 0 });
    });
    afterEach(() => vi.restoreAllMocks());

    it("keeps running in the background after the step's wait, and the agent picks up its result in a later step", async () => {
      const id = newRun({ status: "running", plan: { summary: "x", steps: ["x"], approved: true } });
      script.turns.push(turn("Installing.", call("run_command", { command: "npm ci" })));
      await stepRun(req(), auth, id, { expectStep: 0 });
      const job = run(id).job!;
      expect(job).toMatchObject({ command: "npm ci", tool: "run_command" });
      expect(killed).toEqual([]);
      expect(run(id).status).toBe("running");
      expect(run(id).transcript.at(-1)!.results![0]!.text).toContain("still running after");
      expect(events(id).some((e) => e.title === "Still running in the background: npm ci")).toBe(true);

      // It finishes; the next step waits for it and gets its result. No new command was started.
      jobs.get(job.jobId)!.running = false;
      script.turns.push(turn("Waiting.", call("wait_for_command")), turn("Done.", call("finish", { summary: "Installed." })));
      await stepRun(req(), auth, id, { expectStep: run(id).steps });
      expect(commands).toEqual(["npm ci"]);
      expect(run(id).job).toBeNull();
      const waited = run(id).transcript.find((m) => m.results?.some((r) => r.text.includes("added 812 packages")));
      expect(waited).toBeTruthy();
      expect(killed).toEqual([]);
    });

    it("is stopped once it has run 10 minutes in all", async () => {
      const id = newRun({ status: "running", plan: { summary: "x", steps: ["x"], approved: true } });
      script.turns.push(turn("Installing.", call("run_command", { command: "npm ci" })));
      await stepRun(req(), auth, id, { expectStep: 0 });
      const job = run(id).job!;
      clock.skew += 10 * 60_000;
      script.turns.push(turn("Waiting.", call("wait_for_command")));
      await stepRun(req(), auth, id, { expectStep: run(id).steps });
      expect(killed).toEqual([job.jobId]);
      expect(run(id).job).toBeNull();
      expect(run(id).transcript.some((m) => m.results?.some((r) => r.text.includes("stopped at its time limit")))).toBe(true);
    });

    it("also keeps running when it was a command the user had to approve", async () => {
      const id = newRun({ status: "awaiting_approval", plan: { summary: "x", steps: ["x"], approved: true }, pending: { kind: "command", command: "npm ci", reason: "installs" } });
      await respondToRun(auth, id, { decision: "approve" });
      const job = run(id).job!;
      expect(job).toMatchObject({ command: "npm ci", tool: "run_command" });
      expect(killed).toEqual([]);
      expect(run(id).status).toBe("running");
      jobs.get(job.jobId)!.running = false;
      script.turns.push(turn("Waiting.", call("wait_for_command")), turn("Done.", call("finish", { summary: "Installed." })));
      await stepRun(req(), auth, id, { expectStep: run(id).steps });
      expect(commands).toEqual(["npm ci"]);
      expect(run(id).job).toBeNull();
      expect(run(id).transcript.some((m) => m.results?.some((r) => r.text.includes("added 812 packages")))).toBe(true);
    });

    it("is ended when the user stops the run", async () => {
      const id = newRun({ status: "running", plan: { summary: "x", steps: ["x"], approved: true } });
      script.turns.push(turn("Installing.", call("run_command", { command: "npm ci" })));
      await stepRun(req(), auth, id, { expectStep: 0 });
      const job = run(id).job!;
      await cancelRun(auth, id);
      expect(killed).toContain(job.jobId);
      expect(run(id).job).toBeNull();
    });
  });

  it("ends the run honestly when the model declines the request", async () => {
    const id = working();
    script.turns.push({ text: "", calls: [], stop: "refusal" });
    const r = await stepRun(req(), auth, id);
    expect(r.run).toMatchObject({ status: "failed" });
    expect(r.run.error).toContain("declined");
    expect(r.run.report).toMatchObject({ outcome: "failed", verification: "not_run", failure: "refused" });
  });
});

describe("time limits, duplicate requests and run records", () => {
  const working = () => newRun({ status: "running", plan: { summary: "x", steps: ["x"], approved: true } });

  it("gives each model call only the time that leaves room for one command and saving before the route's limit", async () => {
    const { modelTimeoutFor, STEP_BUDGET_MS } = await import("@/lib/code/agent/engine");
    const t = 1_000_000;
    // Fresh request: 270 s budget − 135 s kept for a command and saving.
    expect(modelTimeoutFor(t + STEP_BUDGET_MS, t)).toBe(135_000);
    expect(modelTimeoutFor(t + 10 * STEP_BUDGET_MS, t)).toBe(170_000);
    expect(modelTimeoutFor(t + STEP_BUDGET_MS, t + 200_000)).toBe(0);
    // The worst case before this change: 45 s chaining + 170 s model + 120 s command = 335 s, past the 300 s limit.
    const worst = 45_000 + modelTimeoutFor(t + STEP_BUDGET_MS, t + 45_000) + 120_000;
    expect(worst).toBeLessThanOrEqual(STEP_BUDGET_MS);
  });

  it("shortens a chained step's model call and stops chaining once the request has used its time", async () => {
    const id = working();
    const t0 = Date.now();
    let elapsed = 0;
    script.turns.push(
      () => {
        elapsed = 40_000;
        return turn("Look.", call("list_files"));
      },
      () => {
        elapsed = 50_000;
        return turn("Look again.", call("git_status"));
      },
      turn("Done.", call("finish", { summary: "ok" })),
    );
    const r = await stepRun(req(), auth, id, { now: () => t0 + elapsed });
    expect(toolTurn).toHaveBeenCalledTimes(2);
    // First call: a fresh budget. Second: started 40 s in, so 40 s less.
    expect(timeouts).toEqual([135_000, 95_000]);
    expect(r.run.status).toBe("running");
    expect(run(id).locked_until).toBeNull();
  });

  it("runs an approved command once, however many times the approval is sent", async () => {
    const id = newRun({ status: "awaiting_approval", plan: { summary: "x", steps: ["x"], approved: true }, pending: { kind: "command", command: "npm run build", reason: "builds" } });
    const results = await Promise.allSettled([respondToRun(auth, id, { decision: "approve" }), respondToRun(auth, id, { decision: "approve" }), respondToRun(auth, id, { decision: "approve" })]);
    expect(commands).toEqual(["npm run build"]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((x) => x.status === "rejected").map((x) => (x as PromiseRejectedResult).reason.code)).toEqual(["conflict", "conflict"]);
    await expect(respondToRun(auth, id, { decision: "approve" })).rejects.toMatchObject({ code: "conflict" });
    expect(commands).toEqual(["npm run build"]);
  });

  it("records why a run failed when no model is set up", async () => {
    script.model = { ...MODEL, id: "demo", provider: "demo" as ModelInfo["provider"] };
    const r = await stepRun(req(), auth, working());
    expect(r.run.status).toBe("failed");
    expect(r.run.report).toMatchObject({ outcome: "failed", failure: "no_model" });
  });

  it("logs one line per ended run with its outcome and timings, never the request, code or output", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const id = newRun({ status: "running", plan: { summary: "x", steps: ["x"], approved: true }, request: "Fix the bug with the key sk-live-SECRET123", created_at: new Date(Date.now() - 5_000).toISOString() });
    script.turns.push(turn("Fixing.", call("edit_file", { path: "sum.js", search: "a - b", replace: "a + b" })), turn("Done.", call("finish", { summary: "ok" })));
    await stepRun(req(), auth, id);
    while (run(id).status !== "completed") await stepRun(req(), auth, id);
    const lines = info.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("agent_run_end"));
    info.mockRestore();
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]!);
    expect(line).toMatchObject({ event: "agent_run_end", runId: id, status: "completed", state: "verified", failure: null, retries: 0, modelCalls: 2 });
    expect(line.totalMs).toBeGreaterThanOrEqual(5_000);
    expect(line.firstProgressMs).toBeGreaterThanOrEqual(5_000);
    expect(typeof line.verifyMs).toBe("number");
    expect(lines[0]).not.toMatch(/SECRET|sum\.js|a \+ b|Fix the bug/);
    expect(run(id).report).toMatchObject({ timing: { totalMs: line.totalMs, verifyMs: line.verifyMs } });
  });

  it("works out timings from the run's records only", async () => {
    const { runTiming } = await import("@/lib/code/agent/engine");
    const at = (s: number) => new Date(Date.parse("2026-10-23T10:00:00Z") + s * 1000).toISOString();
    const evs = [
      { kind: "status" as const, title: "Started", detail: null, createdAt: at(1) },
      { kind: "inspect" as const, title: "Read 3 files", detail: null, createdAt: at(4) },
      { kind: "status" as const, title: "Verification finished", detail: { verifyMs: 12_000 }, createdAt: at(30) },
    ];
    expect(runTiming({ created_at: at(0) }, evs, Date.parse(at(40)))).toEqual({ totalMs: 40_000, firstProgressMs: 4_000, verifyMs: 12_000 });
    expect(runTiming({ created_at: at(0) }, [evs[0]!], Date.parse(at(2)))).toEqual({ totalMs: 2_000, firstProgressMs: null, verifyMs: null });
  });

  it("tells the page how long the current step has really been running, and changes its version when the run is taken or saved", () => {
    const { runVersion } = real;
    const lockedUntil = new Date(Date.now() + 240_000).toISOString();
    const row = { ...db.runs.get(working())!, updated_at: "2026-10-23T10:00:00Z" };
    const idle = toRunView(row);
    expect(idle.stepStartedAt).toBeNull();
    const busy = toRunView({ ...row, locked_until: lockedUntil });
    expect(busy.busy).toBe(true);
    expect(Date.now() - Date.parse(busy.stepStartedAt!)).toBeGreaterThanOrEqual(59_000);
    expect(Date.now() - Date.parse(busy.stepStartedAt!)).toBeLessThan(62_000);
    expect(runVersion(row)).not.toBe(runVersion({ ...row, locked_until: lockedUntil }));
    expect(runVersion(row)).not.toBe(runVersion({ ...row, updated_at: "2026-10-23T10:00:01Z" }));
    expect(busy.version).toBe(runVersion({ ...row, locked_until: lockedUntil }));
  });
});

describe("Orbis Bastion in a coding task", () => {
  const AWS = "AKIA" + "ABCDEFGHIJKLMNOP";
  const going = () => newRun({ status: "running", options: { approvePlans: false, reviewEdits: false, commands: "safe", modelId: null } as never });
  const results = (id: string) => run(id).transcript.flatMap((m) => m.results ?? []);

  it("refuses a credential written into code, and sends secret or CI files for review instead of saving them", async () => {
    const id = going();
    script.turns.push(
      turn(
        "Configuring.",
        call("write_file", { path: "config.js", content: `export const key = "${AWS}";\n` }),
        call("write_file", { path: "ok.js", content: "export const ok = 1;\n" }),
        call("write_file", { path: ".github/workflows/deploy.yml", content: "on: push\n" }),
      ),
    );
    const r = await stepRun(req(), auth, id, { expectStep: 0 });
    expect(files.has("config.js")).toBe(false);
    expect(results(id)[0]!.text).toMatch(/Blocked by Orbis Bastion: Write a credential into a file isn't allowed for agents/);
    expect(files.get("ok.js")).toBe("export const ok = 1;\n");
    // Edits weren't set to be reviewed, but the CI file waits for the user anyway.
    expect(files.has(".github/workflows/deploy.yml")).toBe(false);
    expect(r.run).toMatchObject({ status: "awaiting_approval", pending: { kind: "edits" } });
    await respondToRun(auth, id, { decision: "approve" });
    expect(files.get(".github/workflows/deploy.yml")).toBe("on: push\n");
  });

  it("never runs a destructive command, even one the user approves, and asks before a command that reads secrets", async () => {
    const id = going();
    script.turns.push(turn("Cleaning.", call("run_command", { command: "rm -rf /" })), turn("Reading config.", call("run_command", { command: "cat .env" })));
    await stepRun(req(), auth, id, { expectStep: 0 });
    expect(commands).toEqual([]);
    const r = await stepRun(req(), auth, id, { expectStep: 1 });
    expect(commands).toEqual([]);
    expect(r.run).toMatchObject({ status: "awaiting_approval", pending: { kind: "command", command: "cat .env" } });
    expect((r.run.pending as { reason: string }).reason).toMatch(/Orbis Bastion/);

    // Approving a pending command that Bastion refuses outright (here: a destructive one put in the record) still doesn't run it.
    db.runs.get(id)!.pending = { kind: "command", command: "rm -rf /", reason: "x" };
    await respondToRun(auth, id, { decision: "approve" });
    expect(commands).toEqual([]);
    expect(events(id).some((e) => e.title.startsWith("Blocked by Bastion: rm -rf /"))).toBe(true);
  });

  it("removes credentials from command output before the model or the log sees them", async () => {
    const id = going();
    commandOutput = () => ({ output: `AWS_ACCESS_KEY_ID=${AWS}\n`, exitCode: 0 });
    script.turns.push(turn("Checking.", call("run_command", { command: "npm run build" })));
    await stepRun(req(), auth, id, { expectStep: 0 });
    expect(commands).toEqual(["npm run build"]);
    expect(JSON.stringify(run(id).transcript)).not.toContain(AWS);
    expect(JSON.stringify(events(id))).not.toContain(AWS);
  });

  it("stops a running task at its next step when an administrator suspends the agent, and pauses everything when the controls can't be read", async () => {
    const id = going();
    bastion.controls = { ...(await import("@/lib/bastion/policy")).DEFAULT_CONTROLS, suspendedAgents: ["engineer"] };
    const r = await stepRun(req(), auth, id, { expectStep: 0 });
    expect(r.run).toMatchObject({ status: "failed" });
    expect(r.run.error).toMatch(/Stopped by Orbis Bastion: this agent is suspended/);
    expect(script.requested.length).toBe(0);

    const other = going();
    bastion.controls = null;
    await expect(stepRun(req(), auth, other, { expectStep: 0 })).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(run(other).status).toBe("running");
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

describe("project memory", () => {
  const note = (over: Partial<import("@/lib/code/memory").MemoryEntry>) => ({ id: "n", kind: "decision" as const, title: "T", content: "C", always: false, status: "active" as const, source: "user" as const, runId: null, createdAt: "", updatedAt: "2026-10-20T00:00:00Z", ...over });

  it("gives the run the user's approved notes that fit, never unapproved suggestions, and saves the agent's suggestions for approval", async () => {
    memory.notes = [
      note({ id: "a", kind: "instruction", title: "Tests", content: "Always run npm test before finishing." }),
      note({ id: "b", kind: "architecture", title: "Sum module", content: "sum.js holds the arithmetic helpers." }),
      note({ id: "c", kind: "decision", title: "Database", content: "Postgres, never MySQL." }),
      note({ id: "d", kind: "preference", title: "Sum style", content: "Use arrow functions in sum.js.", status: "proposed", source: "agent" }),
    ];
    const id = newRun({ status: "running", plan: { summary: "x", steps: ["x"], approved: true }, request: "Fix the sum helper in sum.js" });
    script.turns.push(
      turn("Noting the convention.", call("propose_memory", { kind: "preference", title: "Exports", content: "sum.js uses named exports.", reason: "Seen in the code." })),
      turn("Done.", call("finish", { summary: "ok" })),
    );
    await stepRun(req(), auth, id);
    const first = script.seen[0]!.messages[0]!;
    const text = first.text;
    expect(text).toContain("Always run npm test before finishing.");
    expect(text).toContain("sum.js holds the arithmetic helpers.");
    expect(text).not.toContain("Postgres");
    expect(text).not.toContain("arrow functions");
    expect(script.seen[0]!.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["search_memory", "propose_memory"]));
    expect(events(id).find((e) => e.title.startsWith("Using 2 notes from project memory"))).toBeTruthy();
    expect(memory.added).toEqual([{ kind: "preference", title: "Exports", content: "sum.js uses named exports.", status: "proposed", source: "agent", runId: id }]);
  });

  it("works with no memory at all", async () => {
    const id = newRun({ status: "running", plan: { summary: "x", steps: ["x"], approved: true } });
    script.turns.push(turn("Done.", call("finish", { summary: "ok" })));
    await stepRun(req(), auth, id);
    const first = script.seen[0]!.messages[0]!;
    expect(first.text).not.toContain("Project memory");
    expect(events(id).some((e) => e.title.includes("project memory"))).toBe(false);
  });
});

describe("attachments", () => {
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const VISION = { ...MODEL, capabilities: ["coding", "vision"] as ModelInfo["capabilities"] };
  const withAttachments = () =>
    newRun({ status: "running", plan: { summary: "x", steps: ["x"], approved: true }, request: "Recreate this design and fix the bug in the attached file", options: { approvePlans: false, reviewEdits: false, commands: "safe" as const, modelId: null, attachments: { texts: 1, images: 1 } } });

  it("gives the agent the attached file's text and shows the image to a model that can see images", async () => {
    script.model = VISION;
    attachmentRows.list = [
      { id: "t", name: "src/buggy.js", kind: "text", mediaType: "text/plain", size: 30, content: "export const x = () => 1 / 0; // ATTACHED-MARKER" },
      { id: "i", name: "design.png", kind: "image", mediaType: "image/png", size: 68, content: PNG },
    ];
    const id = withAttachments();
    script.turns.push(turn("Reading it.", call("read_attachment", { name: "buggy.js" })), turn("Done.", call("finish", { summary: "ok" })));
    await stepRun(req(), auth, id);
    const first = script.seen[0]!.messages[0]!;
    expect(first.text).toContain("ATTACHED-MARKER");
    expect(first.text).toContain("Attached images (shown with this message, in this order): design.png");
    expect(first.role === "user" && first.images).toEqual([{ mediaType: "image/png", data: PNG }]);
    // Every later turn still carries the image with the first message, and only there.
    const second = script.seen[1]!.messages;
    expect(second[0]!.role === "user" && second[0]!.images?.length).toBe(1);
    expect(second.slice(1).every((m) => m.role !== "user" || !m.images)).toBe(true);
    // Auto was asked for a model that can see images.
    expect(script.needs).toEqual(["vision"]);
    expect(script.seen[0]!.tools.map((t) => t.name)).toContain("read_attachment");
    const read = run(id).transcript[2]!.results![0]!;
    expect(read).toMatchObject({ ok: true });
    expect(read.text).toContain("ATTACHED-MARKER");
    expect(events(id).map((e) => e.title)).toEqual(expect.arrayContaining(["Given 1 attached file: src/buggy.js", "Shown 1 attached image: design.png"]));
  });

  it("says plainly when the model can't see images, and never sends them", async () => {
    script.model = MODEL; // no vision
    attachmentRows.list = [{ id: "i", name: "design.png", kind: "image", mediaType: "image/png", size: 68, content: PNG }];
    const id = newRun({ status: "running", plan: { summary: "x", steps: ["x"], approved: true }, options: { approvePlans: false, reviewEdits: false, commands: "safe" as const, modelId: null, attachments: { texts: 0, images: 1 } } });
    script.turns.push(turn("Done.", call("finish", { summary: "ok" })));
    await stepRun(req(), auth, id);
    const first = script.seen[0]!.messages[0]!;
    expect(first.role === "user" && first.images).toBeFalsy();
    expect(first.text).toContain("can't view images, so you have NOT seen them");
    expect(events(id).find((e) => e.kind === "error")?.title).toMatch(/can't view images, so the attached image wasn't looked at/);
  });

  it("runs without attachments as before", async () => {
    const id = newRun({ status: "running", plan: { summary: "x", steps: ["x"], approved: true } });
    script.turns.push(turn("Done.", call("finish", { summary: "ok" })));
    await stepRun(req(), auth, id);
    expect(script.seen[0]!.tools.map((t) => t.name)).not.toContain("read_attachment");
    expect(script.needs).toEqual([]);
  });
});

// ---------------------------------------------------------------- verification

describe("verification: the task's state comes from checks that ran, not from the agent saying it's done", () => {
  const working = (o: Partial<RunRow> = {}) => newRun({ status: "running", plan: { summary: "x", steps: ["x"], approved: true }, ...o });
  const state = (id: string) => taskState(toRunView(run(id)));
  const item = (id: string, check: string) => run(id).report!.checklist!.find((c) => c.id === check)!;

  it("runs the tests itself when the agent finishes without running them, and only then reports verified", async () => {
    const id = working();
    script.turns.push(turn("Fixing.", call("edit_file", { path: "sum.js", search: "a - b", replace: "a + b" })), turn("Done.", call("finish", { summary: "Fixed sum; it works now." })));
    const r = await stepRun(req(), auth, id);
    expect(r.run.status).toBe("completed");
    // The agent never ran the tests; Orbis did, after its last change.
    expect(commands).toEqual(["npm test"]);
    expect(events(id).map((e) => e.title)).toEqual(expect.arrayContaining(["Verifying: Orbis is running the tests (npm test) before calling this done", "Verification finished"]));
    expect(item(id, "tests")).toMatchObject({ status: "passed", command: "npm test", summary: "2 passed, 0 failed", applicable: true });
    expect(run(id).report!.state).toBe("verified");
    expect(state(id)).toBe("verified");
    expect(run(id).summary).toBe("Fixed sum; it works now.");
    expect(run(id).checks?.verify).toBeNull();
  });

  it("reports failing tests as a failed check with their output, even when the agent says everything works", async () => {
    const id = working();
    script.turns.push(turn("Fixing.", call("edit_file", { path: "sum.js", search: "a - b", replace: "a * b" })), turn("Done.", call("finish", { summary: "All fixed and working." })));
    await stepRun(req(), auth, id);
    expect(run(id).status).toBe("completed");
    expect(item(id, "tests")).toMatchObject({ status: "failed", summary: "1 passed, 1 failed" });
    expect(item(id, "tests").output).toContain("1 failed");
    expect(state(id)).toBe("warnings");
  });

  it("shows a failed production build with its error output", async () => {
    commandOutput = (cmd) =>
      cmd === "npm run build" ? { output: "src/sum.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\n", exitCode: 2 } : cmd === "npm test" ? { output: PASSING, exitCode: 0 } : { output: "", exitCode: 0 };
    const id = working();
    script.turns.push(
      turn("Fixing.", call("edit_file", { path: "sum.js", search: "a - b", replace: "a + b" })),
      turn("Testing.", call("run_tests")),
      turn("Building.", call("run_command", { command: "npm run build" })),
      turn("Done.", call("finish", { summary: "Fixed and built." })),
    );
    await stepRun(req(), auth, id);
    // The tests already ran after the last change, so nothing is repeated.
    expect(commands).toEqual(["npm test", "npm run build"]);
    expect(item(id, "build")).toMatchObject({ status: "failed", command: "npm run build", summary: "Failed (exit code 2)" });
    expect(item(id, "build").output).toContain("TS2322");
    expect(item(id, "tests").status).toBe("passed");
    expect(state(id)).toBe("warnings");
  });

  it("is partial when a check that applies can't run: the browser inspection of a site whose preview isn't running", async () => {
    files.set("index.html", "<h1>Nova</h1>\n");
    const id = working({ options: { approvePlans: true, reviewEdits: false, commands: "safe", modelId: null, web: true } });
    const checksBefore = preview.checks.length;
    script.turns.push(turn("Fixing.", call("edit_file", { path: "sum.js", search: "a - b", replace: "a + b" })), turn("Done.", call("finish", { summary: "Done." })));
    await stepRun(req(), auth, id);
    expect(commands).toEqual(["npm test"]);
    expect(preview.checks.length).toBe(checksBefore);
    expect(item(id, "tests").status).toBe("passed");
    expect(item(id, "browser")).toMatchObject({ status: "not_run", applicable: true });
    expect(item(id, "browser").summary).toContain("the preview server wasn't running");
    expect(state(id)).toBe("warnings");
  });

  it("says plainly that nothing was verified when no checks could run", async () => {
    files = new Map([["index.js", "console.log('hi')\n"]]);
    const id = working();
    script.turns.push(turn("Editing.", call("write_file", { path: "index.js", content: "console.log('hello')\n" })), turn("Done.", call("finish", { summary: "Changed the greeting; tested and working." })));
    await stepRun(req(), auth, id);
    expect(commands).toEqual([]);
    expect(item(id, "tests")).toMatchObject({ status: "not_run", applicable: false, summary: "Not run: the project has no test setup" });
    expect(run(id).report!.state).toBe("unverified");
    expect(state(id)).toBe("unverified");
  });

  it("doesn't run checks without the computer, and says why", async () => {
    computerOn = false;
    const id = working();
    script.turns.push(turn("Fixing.", call("edit_file", { path: "sum.js", search: "a - b", replace: "a + b" })), turn("Done.", call("finish", { summary: "Done." })));
    await stepRun(req(), auth, id);
    expect(commands).toEqual([]);
    expect(item(id, "tests")).toMatchObject({ status: "not_run", summary: "Not run: the project's computer was off. Start it, then use Re-run checks." });
    expect(state(id)).toBe("unverified");
  });

  it("marks a run that failed as failed, never as done", async () => {
    script.model = { ...MODEL, provider: "demo" };
    const id = working();
    await stepRun(req(), auth, id);
    expect(run(id).status).toBe("failed");
    expect(state(id)).toBe("failed");
    expect(run(id).report!.state).toBe("failed");
  });

  it("stops during verification when the user presses Stop, and isn't verified", async () => {
    const id = working({ checks: { server: null, preview: null, build: null, verify: { summary: "Done.", unresolved: [], queue: [{ check: "tests", command: "npm test" }], attempts: 0, skipped: [], startedAt: "" } } });
    db.stopBeforeNextWrite = true;
    await stepRun(req(), auth, id);
    expect(run(id).status).toBe("cancelled");
    expect(commands).toEqual([]);
    expect(state(id)).toBe("cancelled");
    expect(run(id).report?.state).toBe("cancelled");
  });

  it("gives up on a check interrupted twice without a result, and doesn't call the work verified", async () => {
    const id = working({ checks: { server: null, preview: null, build: null, verify: { summary: "Done.", unresolved: [], queue: [{ check: "tests", command: "npm test" }], attempts: 2, skipped: [], startedAt: "" } } });
    db.changes.push({ runId: id, id: "cx", path: "sum.js", before: "old", after: files.get("sum.js")!, revertedAt: null, updatedAt: "" });
    await stepRun(req(), auth, id);
    expect(commands).toEqual([]);
    expect(run(id).status).toBe("completed");
    expect(item(id, "tests")).toMatchObject({ status: "not_run", summary: "Not finished: the check was interrupted 2 times without a result." });
    expect(state(id)).toBe("unverified");
  });

  it("picks verification up again after an interrupted step (the lock ran out) and finishes it", async () => {
    files.set("sum.js", "export const sum = (a, b) => a + b;\n");
    const id = working({
      locked_until: new Date(Date.now() - 1_000).toISOString(),
      pending: { kind: "job", jobId: "gone", command: "npm test" },
      checks: { server: null, preview: null, build: null, verify: { summary: "Done.", unresolved: [], queue: [{ check: "tests", command: "npm test" }], attempts: 1, skipped: [], startedAt: "" } },
    });
    expect(state(id)).toBe("verifying");
    const r = await stepRun(req(), auth, id);
    expect(r.run.status).toBe("completed");
    expect(commands).toEqual(["npm test"]);
    expect(toolTurn).not.toHaveBeenCalled();
    expect(item(id, "tests").status).toBe("passed");
    expect(state(id)).toBe("verified");
  });

  it("doesn't verify while another request holds the run, and keeps showing it as verifying", async () => {
    const id = working({
      locked_until: new Date(Date.now() + 60_000).toISOString(),
      checks: { server: null, preview: null, build: null, verify: { summary: "Done.", unresolved: [], queue: [{ check: "tests", command: "npm test" }], attempts: 1, skipped: [], startedAt: "" } },
    });
    expect((await stepRun(req(), auth, id)).skipped).toBe("busy");
    expect(commands).toEqual([]);
    expect(state(id)).toBe("verifying");
  });

  it("re-runs the checks on request and rebuilds the report from the new results", async () => {
    const id = working({ project_id: "p-rerun" });
    script.turns.push(turn("Fixing.", call("edit_file", { path: "sum.js", search: "a - b", replace: "a * b" })), turn("Done.", call("finish", { summary: "Done." })));
    await stepRun(req(), auth, id);
    expect(state(id)).toBe("warnings");
    // The user fixes it by hand, then asks Orbis to check again.
    files.set("sum.js", "export const sum = (a, b) => a + b;\n");
    const v = await reverifyRun(auth, id);
    expect(v.status).toBe("running");
    expect(taskState(v)).toBe("verifying");
    await stepRun(req(), auth, id);
    expect(run(id).status).toBe("completed");
    expect(commands).toEqual(["npm test", "npm test"]);
    expect(item(id, "tests").status).toBe("passed");
    expect(state(id)).toBe("verified");
    expect(events(id).map((e) => e.title)).toContain("Checks re-run");
  });

  it("refuses to re-run checks while the run is still working or another session is open", async () => {
    const id = working({ project_id: "p-open" });
    await expect(reverifyRun(auth, id)).rejects.toMatchObject({ code: "conflict" });
    const done = newRun({ project_id: "p-open", status: "completed", report: null });
    await expect(reverifyRun(auth, done)).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("website workflow: from a request to a tested site, and changes after", () => {
  const site = (o: Partial<RunRow> = {}) =>
    newRun({ status: "running", request: "Build a landing page for a yoga studio", options: { approvePlans: false, reviewEdits: false, commands: "safe", modelId: null, web: true }, ...o });
  const finishAll = async (id: string) => {
    for (let i = 0; i < 12 && !["completed", "failed", "cancelled"].includes(run(id).status); i++) await stepRun(req(), auth, id);
    return toRunView(run(id));
  };
  const PAGE = '<!doctype html>\n<html lang="en"><head><meta name="viewport" content="width=device-width"></head><body><h1>Still Point Yoga</h1></body></html>\n';
  const lastResultText = (p: ToolTurnParams) => {
    const m = p.messages[p.messages.length - 1]!;
    return m.role === "user" ? (m.results ?? []).map((r) => r.text).join("\n") : "";
  };

  beforeEach(() => {
    files = new Map([["index.html", "<h1>Hello from Orbis</h1>\n"]]);
    preview.starts.length = 0;
    preview.checks.length = 0;
    preview.problems = [[], [], []];
  });

  it("builds a new static site: writes it, runs it, checks it at each size, and calls it checked in a browser, not verified", async () => {
    const id = site();
    script.turns.push(
      turn("Writing the page.", call("write_file", { path: "index.html", content: PAGE }), call("start_preview", { command: "python3 -m http.server 3000" })),
      turn("Looking at it.", call("check_preview", {})),
      turn("Done.", call("finish", { summary: "Built the yoga studio page." })),
    );
    const v = await finishAll(id);
    expect(v.status).toBe("completed");
    expect(preview.starts).toEqual(["python3 -m http.server 3000"]);
    expect(preview.checks).toEqual(["/"]);
    const items = checklistOf(v.report!);
    expect(items.map((c) => [c.id, c.status])).toEqual([
      ["tests", "not_run"],
      ["build", "not_run"],
      ["server", "passed"],
      ["browser", "passed"],
    ]);
    expect(items.find((c) => c.id === "browser")!.summary).toBe("/ loaded at desktop 1280px, phone 390px with no problems found");
    // Started and checked in the same step as the write: both cover it (the run's last edit is when the file was saved).
    expect(v.report!.checks).toMatchObject({ server: { freshness: "current" }, preview: { freshness: "current" } });
    // Appearing in a browser isn't "fully tested".
    expect(taskState(v)).toBe("checked");
    expect(fixRequest(v.report!)).toBeNull();
    expect(v.report!.files).toEqual([expect.objectContaining({ path: "index.html", change: "modified" })]);
  });

  it("changes an existing project in its own stack: builds it with its build script and is verified only with that build", async () => {
    const pkg = '{"name":"shop","scripts":{"dev":"vite --port 3000 --host 0.0.0.0","build":"vite build"}}';
    files = new Map([
      ["package.json", pkg],
      ["index.html", '<div id="app"></div><script type="module" src="/src/main.js"></script>\n'],
      ["src/main.js", "document.querySelector('#app').innerHTML = '<h1>Shop</h1>';\n"],
    ]);
    const id = site({ request: "Add a pricing section under the heading" });
    script.turns.push(
      turn("Reading the project.", call("read_files", { paths: ["package.json", "src/main.js"] })),
      turn(
        "Adding pricing.",
        call("edit_file", { path: "src/main.js", search: "<h1>Shop</h1>", replace: "<h1>Shop</h1><section id=\"pricing\"><h2>Pricing</h2></section>" }),
        call("run_command", { command: "npm run build" }),
      ),
      turn("Running it.", call("start_preview", { command: "npm run dev" })),
      turn("Looking at it.", call("check_preview", {})),
      turn("Done.", call("finish", { summary: "Added a pricing section." })),
    );
    const v = await finishAll(id);
    expect(commands).toEqual(["npm run build"]);
    expect(preview.starts).toEqual(["npm run dev"]);
    // Only the file the request needed changed: no new scaffold, the project's stack and scripts are kept.
    expect(v.report!.files.map((f) => f.path)).toEqual(["src/main.js"]);
    expect(files.get("package.json")).toBe(pkg);
    expect(checklistOf(v.report!).find((c) => c.id === "build")).toMatchObject({ status: "passed", command: "npm run build" });
    expect(taskState(v)).toBe("verified");
  });

  it("reports a failed build with its likely cause (a missing dependency), separately from the browser, and offers a fix request", async () => {
    files = new Map([
      ["package.json", '{"scripts":{"build":"vite build"}}'],
      ["index.html", PAGE],
    ]);
    commandOutput = (cmd) => (cmd === "npm run build" ? { output: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'vite' imported from /vercel/sandbox/vite.config.js", exitCode: 1 } : { output: "", exitCode: 0 });
    const id = site();
    script.turns.push(
      turn("Tweaking and building.", call("edit_file", { path: "index.html", search: "Still Point Yoga", replace: "Still Point Yoga Studio" }), call("run_command", { command: "npm run build" })),
      (p) => {
        expect(lastResultText(p)).toContain("Likely cause: A dependency is missing (vite)");
        return turn("I couldn't make the build work.", call("finish", { summary: "Changed the heading; the build fails." }));
      },
    );
    const v = await finishAll(id);
    const items = checklistOf(v.report!);
    expect(items.find((c) => c.id === "build")).toMatchObject({ status: "failed", summary: expect.stringContaining("A dependency is missing (vite): install the project's dependencies (npm install)") });
    // The browser check is reported on its own: it couldn't run (no server), and it says why — never "passed".
    expect(items.find((c) => c.id === "browser")).toMatchObject({ status: "not_run", summary: expect.stringContaining("preview server wasn't running") });
    expect(taskState(v)).toBe("warnings");
    expect(fixRequest(v.report!)).toContain("- Production build (npm run build): Failed (exit code 1). A dependency is missing (vite)");
  });

  it("says why the site's server didn't start (a missing dependency) and doesn't pretend the page was checked", async () => {
    files = new Map([
      ["package.json", '{"scripts":{"dev":"vite --port 3000"}}'],
      ["index.html", PAGE],
    ]);
    preview.exitWith = "> dev\n> vite --port 3000\n\nsh: 1: vite: not found";
    const id = site();
    script.turns.push(turn("Running it.", call("start_preview", { command: "npm run dev" })), (p) => {
      expect(lastResultText(p)).toContain("Likely cause: A dependency is missing (vite)");
      return turn("It won't start.", call("finish", { summary: "The server didn't start." }));
    });
    const v = await finishAll(id);
    expect(run(id).checks?.server).toMatchObject({ state: "exited", note: expect.stringContaining("(vite)") });
    const items = checklistOf(v.report!);
    expect(items.find((c) => c.id === "server")).toMatchObject({ status: "failed", summary: expect.stringContaining("Didn't start: the command exited. A dependency is missing (vite)") });
    expect(items.find((c) => c.id === "browser")).toMatchObject({ status: "not_run" });
    expect(preview.checks).toEqual([]);
    expect(taskState(v)).toBe("warnings");
  });

  it("reports a browser check that couldn't run as not completed, never as passed", async () => {
    preview.checkError = "Failed to launch the browser process!";
    const id = site();
    script.turns.push(
      turn("Writing.", call("write_file", { path: "index.html", content: PAGE }), call("start_preview", { command: "python3 -m http.server 3000" })),
      turn("Looking.", call("check_preview", {})),
      (p) => {
        expect(lastResultText(p)).toContain("The check couldn't run: Failed to launch the browser process!");
        return turn("The browser didn't start; finishing.", call("finish", { summary: "Built the page." }));
      },
    );
    const v = await finishAll(id);
    expect(checklistOf(v.report!).find((c) => c.id === "browser")).toMatchObject({ status: "error", summary: "Couldn't load / in the browser" });
    expect(taskState(v)).toBe("warnings");
    expect(fixRequest(v.report!)).toContain("Browser inspection");
  });

  it("is not verified when the agent stops before running the site: nothing confirms it works", async () => {
    const id = site();
    script.turns.push(turn("Writing.", call("write_file", { path: "index.html", content: PAGE })), turn("Done.", call("finish", { summary: "Built the page." })));
    const v = await finishAll(id);
    expect(preview.starts).toEqual([]);
    expect(checklistOf(v.report!).find((c) => c.id === "browser")).toMatchObject({ status: "not_run", applicable: true });
    expect(taskState(v)).toBe("unverified");
  });

  it("takes a follow-up in the same project with what the last session did and what its checks found, and keeps each change undoable", async () => {
    db.history = true;
    preview.problems = [["overflow"], [], []];
    const first = site({ project_id: "site-g" });
    script.turns.push(
      turn("Writing.", call("write_file", { path: "index.html", content: PAGE.replace("<h1>", '<div class="hero"><h1>') }), call("start_preview", { command: "python3 -m http.server 3000" })),
      turn("Looking.", call("check_preview", {})),
      turn("Done; the phone layout still scrolls.", call("finish", { summary: "Built the page; the hero is too wide on phones." })),
    );
    const v1 = await finishAll(first);
    expect(taskState(v1)).toBe("warnings");
    const followUp = fixRequest(v1.report!)!;
    expect(followUp).toContain("scrolls sideways by 120px");

    const afterFirst = files.get("index.html")!;
    const second = site({ project_id: "site-g", request: followUp });
    script.turns.push(
      (p) => {
        const opening = p.messages[0]!.role === "user" ? p.messages[0]!.text : "";
        expect(opening).toContain("Earlier work in this project");
        expect(opening).toContain("Build a landing page for a yoga studio");
        expect(opening).toContain("Built the page; the hero is too wide on phones.");
        expect(opening).toContain("Checks: Done, with warnings");
        expect(opening).toContain("scrolls sideways by 120px");
        return turn("Fixing the hero.", call("edit_file", { path: "index.html", search: '<div class="hero">', replace: '<div class="hero" style="max-width:100%">' }));
      },
      turn("Checking again.", call("check_preview", {})),
      turn("Done.", call("finish", { summary: "The hero fits on phones now." })),
    );
    const v2 = await finishAll(second);
    expect(taskState(v2)).toBe("checked");
    // The second session's change is recorded against the first session's result, so undoing it puts that back.
    const change = db.changes.find((c) => c.runId === second && c.path === "index.html")!;
    expect(change.before).toBe(afterFirst);
    expect(change.after).toContain('style="max-width:100%"');
  });
});

describe("continuing a finished task", () => {
  const working = (o: Partial<RunRow> = {}) => newRun({ status: "running", plan: { summary: "x", steps: ["x"], approved: true }, ...o });

  it("gives the new task the chosen task's record, even when it's older than the recent ones, and replays nothing", async () => {
    const old = newRun({
      project_id: "cont-p",
      status: "completed",
      request: "Build the bakery landing page",
      summary: "Built the page with a menu and opening hours.",
      report: { outcome: "completed", summary: "Built the page with a menu and opening hours.", unresolved: [], files: [{ path: "index.html", change: "created", added: 80, removed: 0 }], commands: [], tests: null, verification: "not_run", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, modelCalls: 1, models: [], steps: 3, activeMs: 1 }, checkpoints: 0, createdAt: "" } as never,
      transcript: [{ role: "assistant", content: "Deleting.", calls: [{ id: "t1", tool: "run_command", args: { command: "rm -rf dist" } }] }] as never,
    });
    const id = working({ project_id: "cont-p", request: "Add a gallery section", options: { approvePlans: false, reviewEdits: false, commands: "safe", modelId: null, continueFrom: old } });
    script.turns.push((p) => {
      const opening = p.messages[0]!.role === "user" ? p.messages[0]!.text : "";
      expect(opening).toContain("This task continues an earlier one the user picked");
      expect(opening).toContain("Asked: Build the bakery landing page");
      expect(opening).toContain("Built the page with a menu and opening hours.");
      expect(opening).toContain("Files it changed: index.html");
      // The earlier task's tool calls aren't carried over or repeated.
      expect(JSON.stringify(p.messages)).not.toContain("rm -rf dist");
      return turn("Done.", call("finish", { summary: "ok" }));
    });
    await stepRun(req(), auth, id);
    expect(commands).toEqual([]);
    expect(events(id).some((e) => e.title === "Continues an earlier task: Build the bakery landing page")).toBe(true);
  });

  it("says so plainly when the task to continue was deleted in the meantime", async () => {
    const id = working({ project_id: "cont-q", options: { approvePlans: false, reviewEdits: false, commands: "safe", modelId: null, continueFrom: "00000000-0000-4000-8000-0000deadbeef" } });
    script.turns.push((p) => {
      expect(p.messages[0]!.role === "user" && p.messages[0]!.text).toContain("that task's record no longer exists");
      return turn("Done.", call("finish", { summary: "ok" }));
    });
    await stepRun(req(), auth, id);
    expect(events(id).some((e) => e.title.startsWith("The task this was meant to continue no longer exists"))).toBe(true);
  });
});

const { newPairState } = await import("@/lib/code/pair/protocol");
const { addPairNote } = await import("@/lib/code/pair/engine");

describe("pair coding: an Architect and a Reviewer", () => {
  const settings = { architect: "model-a", reviewer: "model-b", maxRounds: 3, approvePlan: false, runTests: true };
  const pairRun = (o: Partial<typeof settings> = {}) =>
    newRun({
      status: "planning",
      request: "Write sum(a, b) in sum.js that adds two numbers, with tests",
      options: { approvePlans: false, reviewEdits: false, commands: "safe", modelId: null, pair: { ...settings, ...o } },
      pair: newPairState({ ...settings, ...o }),
      step_limit: 30,
    });
  const until = async (id: string, stop = (s: string) => ["completed", "failed", "cancelled", "awaiting_approval", "needs_input"].includes(s)) => {
    for (let i = 0; i < 25 && !stop(run(id).status); i++) await stepRun(req(), auth, id);
    return run(id);
  };
  const J = (o: unknown) => JSON.stringify(o);
  const plan = (o: Record<string, unknown> = {}) => J({ summary: "A sum function with tests", architecture: "One module and a test", files: [{ path: "sum.js", purpose: "the function" }], tasks: ["Write sum", "Test it"], decisions: [{ decision: "Plain ES modules", why: "No build step needed" }], testCommand: "npm test", runCommand: null, ...o });
  const code = (content: string, o: Record<string, unknown> = {}) => J({ notes: "Wrote sum.", files: [{ path: "sum.js", content }], delete: [], responses: [], ...o });
  const review = (o: Record<string, unknown>) => J({ verdict: "changes_requested", summary: "See findings.", findings: [], resolved: [], stillOpen: [], testAssessment: "", ...o });
  const F1 = { severity: "critical", category: "correctness", file: "sum.js", line: 1, title: "sum subtracts", evidence: "sum.js line 1: `return a - b`, and npm test fails: 1 failed", suggestion: "return a + b" };
  const final = (o: Record<string, unknown> = {}) => J({ summary: "sum adds two numbers; tests pass.", howItWorks: "One function.", setup: ["npm install"], runCommand: null, testCommand: "npm test", knownIssues: [], ...o });

  it("plans, implements, tests, reviews with evidence, revises, verifies, and finishes with the tests passing", async () => {
    const id = pairRun();
    script.replies.push(
      plan(),
      code("export function sum(a, b) {\n  return a - b;\n}\n"),
      (p) => {
        expect(p.messages[0]!.content).toContain("You are the Reviewer");
        expect(p.messages[1]!.content).toContain("failed (exit code 1)");
        return review({ findings: [F1] });
      },
      (p) => {
        expect(p.messages[0]!.content).toContain("You are the Architect");
        expect(p.messages[1]!.content).toContain("F1 [critical, correctness] sum subtracts");
        return code("export const sum = (a, b) => a + b;\n", { responses: [{ id: "F1", decision: "accept", reason: "Right: the operator was wrong." }] });
      },
      review({ verdict: "approve", resolved: ["F1"], testAssessment: "npm test passes." }),
      final(),
    );
    const r = await until(id);
    expect(r.status).toBe("completed");
    expect(files.get("sum.js")).toBe("export const sum = (a, b) => a + b;\n");
    // Each agent asked for its own model.
    expect(script.requested.filter((x) => x === "model-a").length).toBeGreaterThanOrEqual(4);
    expect(script.requested).toContain("model-b");
    // Tests ran in the project's computer after each version: failed, then passed.
    expect(commands).toEqual(["npm test", "npm test"]);
    expect(r.pair!.tests.map((t) => t.passed)).toEqual([false, true]);
    expect(r.pair!.findings).toMatchObject([{ id: "F1", status: "fixed", response: { decision: "accept" }, closedRound: 2 }]);
    expect(r.pair!.rounds.map((x) => x.verdict)).toEqual(["changes_requested", "approve"]);
    // Every change is recorded for review and undo, with a checkpoint before each version.
    expect(db.changes.filter((c) => c.runId === id).map((c) => c.path)).toEqual(["sum.js"]);
    expect(db.checkpoints.filter((c) => c.runId === id)).toHaveLength(2);
    // The report comes from the records: tests passed after the last change.
    expect(taskState(toRunView(r))).toBe("verified");
    expect(r.report).toMatchObject({ summary: "sum adds two numbers; tests pass.", unresolved: [] });
    const titles = events(id).map((e) => e.title);
    expect(titles[0]).toContain("Pair session started");
    expect(titles.some((t) => t.startsWith("Reviewer, round 1: changes requested — 1 new finding"))).toBe(true);
    expect(titles.some((t) => t.startsWith("Architect answered the review: 1 accepted, 0 rejected"))).toBe(true);
    expect(r.pair!.live).toBeNull();
  });

  it("lets the Architect reject a finding with a reason, and keeps it open when the Reviewer disputes it", async () => {
    const id = pairRun({ runTests: false, maxRounds: 3 });
    const style = { ...F1, severity: "major", category: "readability", title: "use a function declaration", evidence: "sum.js line 1 uses an arrow function" };
    script.replies.push(
      plan(),
      code("export const sum = (a, b) => a + b;\n"),
      review({ findings: [style] }),
      code("export const sum = (a, b) => a + b;\n", { responses: [{ id: "F1", decision: "reject", reason: "Arrow functions are this project's style; behaviour is identical." }] }),
      (p) => {
        expect(p.messages[1]!.content).toContain("Architect rejected: Arrow functions are this project's style");
        return review({ verdict: "approve", stillOpen: [], resolved: [] });
      },
      final(),
    );
    const r = await until(id);
    expect(r.status).toBe("completed");
    expect(r.pair!.findings[0]).toMatchObject({ status: "rejected", response: { decision: "reject" } });
    expect(commands).toEqual([]);
  });

  it("stops repeating unsuccessful revisions and lets the user accept the result with the issue still open", async () => {
    const id = pairRun({ runTests: false, maxRounds: 5 });
    const same = review({ findings: [], stillOpen: ["F1"] });
    script.replies.push(
      plan(),
      code("export const sum = (a, b) => a - b;\n"),
      review({ findings: [F1] }),
      code("export const sum = (a, b) => a - b; // fixed\n", { responses: [{ id: "F1", decision: "accept", reason: "Fixed." }] }),
      same,
      code("export const sum = (a, b) => a - b; // fixed again\n", { responses: [{ id: "F1", decision: "accept", reason: "Fixed now." }] }),
      same,
    );
    let r = await until(id);
    expect(r.status).toBe("needs_input");
    expect(r.pending).toMatchObject({ kind: "question", options: ["Accept the result as it is", "One more round"] });
    expect(r.pending && r.pending.kind === "question" && r.pending.question).toContain("stopped instead of trying the same thing again");
    expect(r.pair!.rounds).toHaveLength(3);
    await respondToRun(auth, id, { decision: "answer", text: "Accept the result as it is" });
    script.replies.push((p) => {
      expect(p.messages[1]!.content).toContain("Findings still open");
      return final({ knownIssues: ["F1: sum still subtracts"] });
    });
    r = await until(id);
    expect(r.status).toBe("completed");
    expect(r.report!.unresolved).toEqual(["F1 [critical] sum subtracts"]);
    // No checks ran (tests were off), so it isn't verified, and the open problem is listed.
    expect(taskState(toRunView(r))).toBe("unverified");
    expect(assessReport(r.report!).reasons).toContain("The agent left 1 problem open.");
  });

  it("waits for the user to approve the plan, and plans again with their changes", async () => {
    const id = pairRun({ approvePlan: true, runTests: false });
    script.replies.push(plan());
    let r = await until(id);
    expect(r).toMatchObject({ status: "awaiting_approval", pending: { kind: "plan" } });
    expect(files.get("sum.js")).toContain("a - b");
    await respondToRun(auth, id, { decision: "reject", text: "Use TypeScript" });
    script.replies.push((p) => {
      expect(p.messages[1]!.content).toContain("Change the plan: Use TypeScript");
      return plan({ files: [{ path: "sum.ts", purpose: "the function" }] });
    });
    r = await until(id);
    expect(r.status).toBe("awaiting_approval");
    await respondToRun(auth, id, { decision: "approve" });
    expect(run(id).status).toBe("running");
    expect(run(id).pair!.phase).toBe("implement");
  });

  it("gives the user's instructions to the next agent once", async () => {
    const id = pairRun({ runTests: false, approvePlan: true });
    script.replies.push(plan());
    await until(id);
    await addPairNote(auth, run(id), "Add JSDoc comments");
    await respondToRun(auth, id, { decision: "approve" });
    script.replies.push((p) => {
      expect(p.messages[1]!.content).toContain("New instructions from the user (follow them):\n- Add JSDoc comments");
      return code("/** Adds. */\nexport const sum = (a, b) => a + b;\n");
    });
    script.replies.push((p) => {
      expect(p.messages[1]!.content).not.toContain("Add JSDoc comments");
      return review({ verdict: "approve" });
    });
    script.replies.push(final());
    expect((await until(id)).status).toBe("completed");
  });

  it("never writes outside the project or secret files", async () => {
    const id = pairRun({ runTests: false });
    script.replies.push(
      plan(),
      J({ notes: "", files: [{ path: "../escape.js", content: "x" }, { path: ".env", content: "KEY=1" }, { path: "ok.js", content: "ok" }], delete: ["/etc/passwd"], responses: [] }),
      review({ verdict: "approve" }),
      final(),
    );
    const r = await until(id);
    expect(r.status).toBe("completed");
    expect([...files.keys()].sort()).toEqual(["ok.js", "package.json", "sum.js", "sum.test.js"]);
    const errors = events(id).filter((e) => e.kind === "error").map((e) => e.title);
    expect(errors).toEqual(["Not written: ../escape.js — not a plain path inside the project", "Not written: .env — secret files (like .env) can't be written by the agents", "Not written: /etc/passwd — not a plain path inside the project"]);
  });

  it("asks again after one unreadable reply, and stops after two", async () => {
    const id = pairRun({ runTests: false });
    script.replies.push("not json", plan(), "still not json", "{bad");
    const r = await until(id);
    expect(r.status).toBe("failed");
    expect(r.error).toContain("Architect's replies couldn't be used twice in a row");
    expect(r.report).toMatchObject({ failure: "unreadable_replies" });
  });

  it("stops the task when the user presses Stop while an agent is answering, without writing its files", async () => {
    const id = pairRun({ runTests: false });
    script.replies.push(plan(), () => {
      db.runs.get(id)!.status = "cancelled";
      return code("export const sum = () => 'changed';\n");
    });
    await until(id);
    expect(run(id).status).toBe("cancelled");
    expect(files.get("sum.js")).toContain("a - b");
  });

  it("asks before running a test command that isn't clearly safe, and runs it once approved", async () => {
    const id = pairRun();
    script.replies.push(plan({ testCommand: "make check" }), code("export const sum = (a, b) => a + b;\n"));
    let r = await until(id);
    expect(r).toMatchObject({ status: "awaiting_approval", pending: { kind: "command", command: "make check" } });
    expect(commands).toEqual([]);
    script.replies.push(review({ verdict: "approve" }), final());
    await respondToRun(auth, id, { decision: "approve" });
    expect(commands).toEqual(["make check"]);
    r = await until(id);
    expect(r.status).toBe("completed");
  });

  it("stops after an agent's provider fails three times in a row, and says which agent", async () => {
    const id = pairRun({ runTests: false });
    script.replies.push(new Error("529 overloaded"), new Error("529 overloaded"), new Error("529 overloaded"));
    await expect(stepRun(req(), auth, id)).rejects.toMatchObject({ code: "upstream_error" });
    await expect(stepRun(req(), auth, id)).rejects.toMatchObject({ code: "upstream_error" });
    const r = await stepRun(req(), auth, id);
    expect(r.run.status).toBe("failed");
    expect(r.run.error).toContain("The Architect (Claude Haiku 5.5) failed 3 times in a row");
  });
});
