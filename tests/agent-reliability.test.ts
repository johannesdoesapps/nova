/**
 * Agent intelligence and reliability (docs/AGENT_PLATFORM.md §15): memory never keeps secrets and gives
 * the model only relevant memories; one outcome vocabulary from each task's records; failures classified,
 * with retries only where they can help and never after the same failure twice; Activity's measured facts
 * (progress, cost, stalled, stop); administrator task limits and agent versions on new tasks; the action
 * risk table matching the code that enforces it; and the admin audit log redacting what it records.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const settings = { taskLimits: {} as { tokenBudget?: number; timeLimitMinutes?: number } };
vi.mock("@/lib/ai/settings", () => ({ getPlatformSettings: async () => ({ pausedAgents: [], taskLimits: settings.taskLimits }) }));

const { findSecrets, redactAll } = await import("@/lib/secrets");
const { addMemory: addUserMemory, selectMemories } = await import("@/lib/memory");
const { addMemory: addProjectNote, updateMemory: updateProjectNote } = await import("@/lib/code/memory-store");
const { codeRunOutcome, researchOutcome, reviewOutcome, securityOutcome, workflowOutcome, OUTCOMES } = await import("@/lib/agent-platform/outcomes");
const { classifyFailure, sameFailure, shouldRetry } = await import("@/lib/agent-platform/failures");
const { newSteps, observe, recover, recoveries, retryAdvice, started, startFailed } = await import("@/lib/agent-platform/workflow");
const { fromCodeRun, fromSecurityRun, fromWorkflow, STALL_MS } = await import("@/lib/agent-platform/activity");
const { resultFromActivity } = await import("@/lib/agent-platform/protocol");
const { ACTION_RISKS } = await import("@/lib/agent-platform/risk");
const { changedKeys, recordAdminAction } = await import("@/lib/admin-audit");
const { platformSettingsSchema } = await import("@/lib/ai/platform");
const { createRun } = await import("@/lib/code/agent/runs");
const { agentDef } = await import("@/lib/agent-platform/registry");

const AT = "2026-10-24T10:00:00.000Z";
const NOW = Date.parse(AT);

/** A Supabase stand-in that records writes and fails the test if a refused write reaches it. */
function fakeDb() {
  const writes: { table: string; op: string; values: unknown }[] = [];
  const chain = (table: string): Record<string, unknown> => {
    const q: Record<string, unknown> = {};
    const self = () => q;
    for (const m of ["select", "eq", "order", "limit", "maybeSingle"]) q[m] = self;
    q.insert = (values: unknown) => {
      writes.push({ table, op: "insert", values });
      return q;
    };
    q.update = (values: unknown) => {
      writes.push({ table, op: "update", values });
      return q;
    };
    q.single = async () => ({ data: { id: "run-1", options: {}, ...((writes.at(-1)?.values as object) ?? {}) }, error: null });
    q.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res);
    return q;
  };
  return { writes, from: (t: string) => chain(t) };
}

describe("memory: no secrets, and only what's relevant", () => {
  it("recognises credentials, and leaves ordinary sentences about passwords alone", () => {
    expect(findSecrets(`key ${"sk-" + "ant-"}abcdefghijklmnopqrstuvwx`)).toContain("Anthropic API key");
    expect(findSecrets("postgres://app:hunter22@db.internal/app")).toContain("connection string with a password");
    expect(findSecrets("Passwords must be at least 12 characters")).toEqual([]);
    expect(redactAll(`token=${"gh" + "p_"}abcdefghijklmnopqrstuvwxyz0123456789AB and more`)).not.toContain("ghp_");
  });

  it("chat memory refuses a secret without saving anything", async () => {
    const db = fakeDb();
    const r = await addUserMemory(db as never, "u1", `my AWS key is ${"AK" + "IA"}ABCDEFGHIJKLMNOP`, "chat");
    expect(r).toEqual({ ok: false, reason: "secret" });
    expect(db.writes).toEqual([]);
  });

  it("project memory refuses a secret from the user or the agent, on add and on edit", async () => {
    const db = fakeDb();
    const auth = { supabase: db } as never;
    await expect(addProjectNote(auth, "p1", { kind: "instruction", title: "Deploy", content: "Use API_KEY=abcd1234efgh5678 for staging" })).rejects.toThrow(/looks like it contains a secret/);
    await expect(addProjectNote(auth, "p1", { kind: "decision", title: `${"gh" + "p_"}abcdefghijklmnopqrstuvwxyz0123456789AB`, content: "x", source: "agent", status: "proposed" })).rejects.toThrow(
      /secret/,
    );
    await expect(updateProjectNote(auth, "p1", "m1", { content: "password: correcthorsebattery" })).rejects.toThrow(/secret/);
    expect(db.writes).toEqual([]);
  });

  it("gives every memory while they're short, and only the relevant ones (then the newest) when they're long", () => {
    const short = [{ content: "I live in Lisbon" }, { content: "I prefer metric units" }];
    expect(selectMemories(short, "What's the weather like?")).toEqual(short);
    const long = [
      { content: `I'm vegetarian and cook at home most days ${"x".repeat(500)}` },
      { content: `My company sells handmade ceramics online ${"y".repeat(500)}` },
      { content: `I live in Lisbon, Portugal ${"z".repeat(500)}` },
      { content: `I run marathons and train early ${"w".repeat(500)}` },
    ];
    const picked = selectMemories(long, "Suggest a vegetarian dinner I can cook", 1200);
    expect(picked[0]!.content).toMatch(/vegetarian/);
    expect(picked.length).toBe(2);
    // Kept in their original (newest first) order.
    expect(long.indexOf(picked[0]!)).toBeLessThan(long.indexOf(picked[1]!));
  });
});

describe("evidence-based outcomes", () => {
  it("coding tasks: from the report's verdict, never from the agent's words", () => {
    expect(OUTCOMES).toEqual(["verified", "completed", "partial", "blocked", "failed", "unverified"]);
    expect(codeRunOutcome({ status: "completed", state: "verified" }).outcome).toBe("verified");
    expect(codeRunOutcome({ status: "completed", state: "checked" }).outcome).toBe("completed");
    expect(codeRunOutcome({ status: "completed", state: "warnings" }).outcome).toBe("partial");
    expect(codeRunOutcome({ status: "completed", state: "unverified" }).outcome).toBe("unverified");
    expect(codeRunOutcome({ status: "completed" }).outcome).toBe("unverified");
    expect(codeRunOutcome({ status: "completed", verification: "passed" }).outcome).toBe("completed");
    expect(codeRunOutcome({ status: "needs_input", pendingKind: "limit" }).outcome).toBe("blocked");
    expect(codeRunOutcome({ status: "needs_input", pendingKind: "plan" }).outcome).toBeNull();
    expect(codeRunOutcome({ status: "failed" }).outcome).toBe("failed");
    expect(codeRunOutcome({ status: "cancelled" }).outcome).toBeNull();
  });

  it("research is verified only when every finding cites a source it found", () => {
    expect(researchOutcome({ status: "completed", check: { cited: [1, 2], uncitedParagraphs: 0, invalidRemoved: 0 } }).outcome).toBe("verified");
    expect(researchOutcome({ status: "completed", check: { cited: [1], uncitedParagraphs: 2, invalidRemoved: 0 } })).toMatchObject({
      outcome: "completed",
      note: expect.stringMatching(/2 finding paragraphs without a source/),
    });
    expect(researchOutcome({ status: "completed", check: { cited: [], uncitedParagraphs: 0 } }).outcome).toBe("unverified");
    expect(researchOutcome({ status: "completed", check: null }).outcome).toBe("unverified");
  });

  it("reviews, scans and workflows", () => {
    expect(reviewOutcome({ status: "completed" }).outcome).toBe("completed");
    expect(securityOutcome({ status: "completed", toolsFailed: 1 }).outcome).toBe("partial");
    const steps = (test: string, review: string) => [
      { key: "fix", status: "done" },
      { key: "test", status: test },
      { key: "review", status: review },
      { key: "approve", status: "done" },
    ];
    expect(workflowOutcome({ status: "completed", decision: { action: "approve" }, steps: steps("done", "done") }).outcome).toBe("verified");
    expect(workflowOutcome({ status: "completed", decision: { action: "approve" }, steps: steps("skipped", "done") }).outcome).toBe("partial");
    expect(workflowOutcome({ status: "completed", decision: { action: "reject" }, steps: steps("done", "done") }).note).toMatch(/undone/);
  });
});

describe("failure recovery", () => {
  it("classifies by the recorded failure kind first, then the error", () => {
    expect(classifyFailure("anything", "provider_unavailable")).toMatchObject({ class: "transient", retryable: true });
    expect(classifyFailure("Bug Fixing isn't included in your plan.")).toMatchObject({ class: "permission", retryable: false });
    expect(classifyFailure("Project not found.")).toMatchObject({ class: "invalid_input", retryable: false });
    expect(classifyFailure(null)).toMatchObject({ class: "unknown", retryable: true });
  });

  it("treats errors that differ only in numbers, ids or quoted names as the same failure", () => {
    expect(sameFailure("Tests still fail (2 failing) in “cart.test.js”", "Tests still fail (5 failing) in “order.test.js”")).toBe(true);
    expect(sameFailure("Tests still fail", "The request timed out")).toBe(false);
    expect(shouldRetry(["timeout", "timeout"], 2, 3).retry).toBe(false);
  });

  it("a workflow step isn't offered a retry that can't help: permission problems, or the same failure twice", () => {
    const fresh = { status: "running" as const, current: 0, steps: newSteps("fix_and_verify"), log: [], error: null };
    const denied = startFailed(fresh, "fix", "Bug Fixing isn't included in your plan. Upgrade to Pro.", AT);
    expect(recoveries(denied)).toEqual([]);
    expect(retryAdvice(denied.steps[0]!)).toMatchObject({ retry: false, failure: { class: "permission" } });

    let w = started(fresh, "fix", "fix-1", AT);
    w = observe(w, "fix", { state: "failed", error: "Tests still fail (2 failing)" }, AT);
    expect(recoveries(w)).toEqual(["retry"]);
    w = started(recover(w, "retry", AT)!, "fix", "fix-2", AT);
    w = observe(w, "fix", { state: "failed", error: "Tests still fail (3 failing)" }, AT);
    expect(w.steps[0]!.errors).toHaveLength(2);
    expect(recoveries(w)).toEqual([]);
    expect(retryAdvice(w.steps[0]!).reason).toMatch(/same way twice/);
  });
});

describe("live observability: measured, never estimated", () => {
  const run = {
    id: "r1",
    project_id: "p1",
    request: "Add a gallery",
    status: "running",
    options: {},
    pending: null,
    error: null,
    report: null,
    steps: 4,
    step_limit: 20,
    cost: "0.0421",
    created_at: AT,
    updated_at: AT,
  };

  it("coding tasks show steps taken of the limit, recorded cost, and a stop link while open", () => {
    const i = fromCodeRun(run, NOW + 1000);
    expect(i).toMatchObject({ progress: { done: 4, limit: 20, unit: "steps" }, costUsd: 0.0421, cancelUrl: "/api/code/agent/r1/cancel", stalled: false, outcome: null });
    expect(fromCodeRun({ ...run, cost: null }, NOW).costUsd).toBeNull();
  });

  it("an open task with nothing recorded for a while is flagged as not moving (no invented progress)", () => {
    expect(fromCodeRun(run, NOW + STALL_MS + 1).stalled).toBe(true);
    expect(fromCodeRun({ ...run, status: "awaiting_approval" }, NOW + STALL_MS + 1).stalled).toBe(false);
  });

  it("a failed task carries its failure class and what to do; the result's next step is that advice", () => {
    const i = fromCodeRun({ ...run, status: "failed", error: "Too many requests: rate limited", report: { failure: undefined } }, NOW);
    expect(i.failure).toMatchObject({ class: "limit" });
    expect(i.cancelUrl).toBeNull();
    expect(resultFromActivity(i).next).toBe(i.failure!.advice);
  });

  it("security scans and workflows join the list, with their own outcomes", () => {
    const scan = fromSecurityRun(
      {
        id: "s1",
        agent: "sentinel",
        action: "scan_site",
        status: "completed",
        asset: "shop.example",
        error: null,
        tools: [
          { tool: "headers", status: "ok" },
          { tool: "tls", status: "failed" },
        ],
        started_at: AT,
        finished_at: AT,
      },
      NOW,
    );
    expect(scan).toMatchObject({ kind: "security", agent: "security", outcome: "partial", href: "/agents/security/runs/s1", cancelUrl: null });
    const wf = fromWorkflow({ id: "w1", title: "Fix and verify: cart", status: "needs_approval", error: null, decision: null, steps: [], created_at: AT, updated_at: AT }, NOW);
    expect(wf).toMatchObject({ kind: "workflow", status: "awaiting_approval", detail: "Your decision", cancelUrl: "/api/workflows/w1/cancel" });
  });
});

describe("resources, versions and approvals", () => {
  beforeEach(() => {
    settings.taskLimits = {};
  });

  it("administrator task limits are validated", () => {
    expect(platformSettingsSchema.parse({}).taskLimits).toEqual({});
    expect(() => platformSettingsSchema.parse({ taskLimits: { tokenBudget: 5 } })).toThrow();
    expect(() => platformSettingsSchema.parse({ taskLimits: { timeLimitMinutes: 600 } })).toThrow();
    expect(platformSettingsSchema.parse({ taskLimits: { tokenBudget: 200_000, timeLimitMinutes: 15 } }).taskLimits).toEqual({ tokenBudget: 200_000, timeLimitMinutes: 15 });
  });

  it("a new task records its agent's version, and gets the administrator's limits when set", async () => {
    const db = fakeDb();
    await createRun({ supabase: db } as never, {
      projectId: "p1",
      request: "Fix it",
      options: { modelId: null, approvePlans: true, reviewEdits: false, commands: "safe", readOnly: false, agent: "bug_fixer" },
      stepLimit: 25,
    });
    expect(db.writes[0]).toMatchObject({ op: "insert", values: { options: { agentVersion: agentDef("bug_fixer")!.version } } });
    expect(db.writes).toHaveLength(1);

    settings.taskLimits = { tokenBudget: 200_000, timeLimitMinutes: 15 };
    const db2 = fakeDb();
    await createRun({ supabase: db2 } as never, {
      projectId: "p1",
      request: "Build",
      options: { modelId: null, approvePlans: true, reviewEdits: false, commands: "safe", readOnly: false, web: true },
      stepLimit: 20,
    });
    expect(db2.writes[0]).toMatchObject({ values: { options: { agentVersion: agentDef("website_builder")!.version } } });
    expect(db2.writes[1]).toEqual({ table: "code_agent_runs", op: "update", values: { token_budget: 200_000, time_limit_ms: 900_000 } });
  });

  it("every entry in the action risk table points at code that really enforces it", () => {
    expect(ACTION_RISKS.length).toBeGreaterThanOrEqual(12);
    for (const a of ACTION_RISKS) expect(readFileSync(join(process.cwd(), a.enforcedIn), "utf8"), `${a.id}: ${a.anchor}`).toContain(a.anchor);
    // Irreversible actions are never automatic.
    for (const a of ACTION_RISKS.filter((x) => x.reversible === "no")) expect(["always", "never_allowed"], a.id).toContain(a.approval);
  });

  it("the admin audit log records which settings changed, with secrets removed, and never throws", async () => {
    expect(changedKeys({ autoEnabled: true, pausedAgents: [] }, { autoEnabled: false, pausedAgents: [] })).toEqual(["autoEnabled"]);
    const db = fakeDb();
    await recordAdminAction(db as never, "settings.save", null, { note: `rotated ${"sk-" + "ant-"}abcdefghijklmnopqrstuvwx` });
    expect(JSON.stringify(db.writes[0]!.values)).not.toContain("sk-ant-");
    const broken = { from: () => ({ insert: () => Promise.reject(new Error("down")) }) };
    await expect(recordAdminAction(broken as never, "agent.pause", "engineer")).resolves.toBe(false);
  });
});
