/**
 * Task history and continuation without a database: the History query is always limited to the
 * signed-in user with filters made safe; deleting a record refuses open and busy tasks; the API
 * returns readable summaries; and the rules for resuming versus continuing.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { RunView } from "@/lib/code/agent/types";

vi.mock("server-only", () => ({}));

/** A stand-in for the Supabase query builder: records every call and resolves with the rows given. */
function fakeSupabase(result: { data: unknown; error: null | { message: string } } | ((calls: [string, unknown[]][]) => { data: unknown; error: null })) {
  const calls: [string, unknown[]][] = [];
  const builder: Record<string, unknown> = {};
  for (const m of ["from", "select", "eq", "in", "or", "order", "range", "delete", "maybeSingle", "limit", "is", "lt"]) {
    builder[m] = (...a: unknown[]) => {
      calls.push([m, a]);
      return builder;
    };
  }
  builder.then = (res: (v: unknown) => unknown) => Promise.resolve(typeof result === "function" ? result(calls) : result).then(res);
  return { supabase: builder, calls };
}
const auth = (supabase: unknown) => ({ mode: "authenticated", user: { id: "u-alice" }, supabase }) as never;

const { listTasks, deleteRun, toRunView } = await import("@/lib/code/agent/runs");
const { continuation, filterQuery, searchPattern, taskTitle, toTaskSummary } = await import("@/lib/code/agent/history");

const row = (o: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  project_id: "22222222-2222-4222-8222-222222222222",
  request: "Add a pricing section\n\nDetails:\n- Purpose: sell more",
  status: "completed",
  options: {},
  plan: null,
  pending: null,
  summary: "Added three plans.",
  error: null,
  steps: 4,
  step_limit: 20,
  locked_until: null,
  token_budget: 600000,
  usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.02, modelCalls: 4, models: ["Claude Haiku 5.5"] },
  active_ms: 1000,
  time_limit_ms: 1800000,
  tests: null,
  checks: null,
  recent: [],
  last_edit_at: null,
  report: null,
  created_at: "2026-10-23T10:00:00Z",
  updated_at: "2026-10-23T10:05:00Z",
  ...o,
});

describe("the History query", () => {
  it("is always limited to the signed-in user, and applies the outcome, project, search and sort asked for", async () => {
    const { supabase, calls } = fakeSupabase({ data: [row(), row({ id: "x" })], error: null });
    const r = await listTasks(auth(supabase), {
      ...filterQuery("succeeded"),
      pattern: searchPattern("pricing, (page)%"),
      projectId: "22222222-2222-4222-8222-222222222222",
      sort: "oldest",
      offset: 30,
      limit: 1,
    });
    expect(calls).toContainEqual(["eq", ["user_id", "u-alice"]]);
    expect(calls).toContainEqual(["eq", ["project_id", "22222222-2222-4222-8222-222222222222"]]);
    expect(calls).toContainEqual(["in", ["status", ["completed"]]]);
    expect(calls).toContainEqual(["in", ["report->>state", ["verified", "checked"]]]);
    // The search can't add filters of its own: commas, parentheses and wildcards are gone.
    expect(calls).toContainEqual(["or", ["request.ilike.%pricing page%,summary.ilike.%pricing page%"]]);
    expect(calls).toContainEqual(["order", ["created_at", { ascending: true }]]);
    expect(calls).toContainEqual(["range", [30, 31]]);
    expect(r).toMatchObject({ more: true });
    expect(r.rows).toHaveLength(1);
    // The transcript (the agent's working memory) is never read for History.
    expect(String(calls.find((c) => c[0] === "select")![1][0])).not.toContain("transcript");
  });

  it("treats a project id that isn't an id as not found, without querying", async () => {
    const { supabase } = fakeSupabase({ data: [], error: null });
    await expect(listTasks(auth(supabase), { sort: "activity", offset: 0, limit: 30, projectId: "1 or 1=1" })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("deleting a task's record", () => {
  const withRun = (r: Record<string, unknown> | null, deleted: unknown[] = [{ id: "x" }]) =>
    fakeSupabase((calls) => (calls.some((c) => c[0] === "delete") ? { data: deleted, error: null } : { data: r, error: null }));

  it("deletes the user's own finished task, only if no step or check holds it", async () => {
    const { supabase, calls } = withRun(row());
    await deleteRun(auth(supabase), row().id, Date.parse("2026-10-23T11:00:00Z"));
    expect(calls).toContainEqual(["eq", ["user_id", "u-alice"]]);
    expect(calls).toContainEqual(["in", ["status", ["completed", "failed", "cancelled"]]]);
    expect(calls).toContainEqual(["or", ["locked_until.is.null,locked_until.lt.2026-10-23T11:00:00.000Z"]]);
  });

  it("refuses an open task, a busy one, and one that isn't the user's", async () => {
    await expect(deleteRun(auth(withRun(row({ status: "running" })).supabase), row().id)).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("Stop it first") });
    await expect(deleteRun(auth(withRun(row(), []).supabase), row().id)).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("busy") });
    // Row-level security hides another user's run: it reads as not found.
    await expect(deleteRun(auth(withRun(null).supabase), row().id)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("what a task shows and how it's picked up again", () => {
  it("reads the title from the request (without the optional details) and keeps summaries short", () => {
    expect(taskTitle("Add a pricing section\n\nDetails:\n- Purpose: sell more")).toBe("Add a pricing section");
    expect(taskTitle("\n\n  Fix the login bug  \nmore")).toBe("Fix the login bug");
    expect(taskTitle("x".repeat(300))).toHaveLength(118);
    const s = toTaskSummary(toRunView(row({ summary: "y".repeat(1000) }) as never) as RunView, "Shop", 2);
    expect(s).toMatchObject({ title: "Add a pricing section", projectName: "Shop", filesChanged: 2, models: ["Claude Haiku 5.5"], costUsd: 0.02, state: "unverified" });
    expect(s.summary!.length).toBeLessThanOrEqual(400);
  });

  it("tells failed, stopped, open and finished tasks apart, and resumes only open ones", () => {
    const t = (o: Record<string, unknown>) => toTaskSummary(toRunView(row(o) as never) as RunView, "Shop", 0);
    expect(t({ status: "failed", error: "The AI provider rejected the request." })).toMatchObject({
      state: "failed",
      error: "The AI provider rejected the request.",
      continuation: { kind: "follow_up" },
    });
    expect(t({ status: "cancelled" })).toMatchObject({ state: "cancelled", continuation: { kind: "follow_up" } });
    expect(t({ status: "awaiting_approval", pending: { kind: "plan" } })).toMatchObject({ state: "waiting", continuation: { kind: "resume", label: "Resume" } });
    expect(t({ status: "running", steps: 3 })).toMatchObject({ state: "running", continuation: { kind: "resume" } });
    expect(continuation("completed").explain).toContain("earlier commands aren't run again");
    expect(continuation("running").explain).toContain("nothing is replayed");
  });

  it("has no filter for other people's work and makes empty searches no search", () => {
    expect(searchPattern("   ")).toBeNull();
    expect(searchPattern("%_")).toBeNull();
    expect(filterQuery("all")).toEqual({});
    expect(filterQuery("waiting")).toEqual({ statuses: ["awaiting_approval", "needs_input"] });
  });
});

describe("a task in History", () => {
  it("shows the outcome in words, the project, what changed and the right next step", async () => {
    vi.doMock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
    const { TaskRow, taskLinks } = await import("@/components/studio/task-history");
    const done = toTaskSummary(toRunView(row({ status: "failed", error: "Claude Haiku 5.5 failed 3 times in a row." }) as never) as RunView, "Shop", 1);
    const html = renderToStaticMarkup(createElement(TaskRow, { task: done, onDelete: () => {} }));
    expect(html).toContain("Failed");
    expect(html).toContain("Shop");
    expect(html).toContain("Claude Haiku 5.5 failed 3 times in a row.");
    expect(html).toContain("1 file changed");
    expect(html).toContain(`/code/${row().project_id}?continue=${row().id}`);
    const open = toTaskSummary(toRunView(row({ status: "needs_input", pending: { kind: "question", question: "?", options: [] } }) as never) as RunView, "Shop", 0);
    expect(taskLinks(open)).toEqual({ open: `/code/${row().project_id}?run=${row().id}`, next: `/code/${row().project_id}?run=${row().id}` });
    const openHtml = renderToStaticMarkup(createElement(TaskRow, { task: open, onDelete: () => {} }));
    expect(openHtml).toContain("Resume");
    // An open task can't be deleted from History (stop it first).
    expect(openHtml).not.toContain("More for");
  });
});
