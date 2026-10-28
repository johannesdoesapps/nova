/**
 * The usage-estimate and inbox migration on PGlite (every real migration applied): the all-accounts estimate only
 * returns aggregates and only when enough people ran a task; the inbox keeps each user's updates to themselves,
 * lets them change only the read mark, keeps links inside Orbis, and records each update once. The server code
 * (lib/inbox.ts) runs against it through the Supabase stub, with email replaced by a recorder.
 */
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ALICE, BOB, CAROL, asService, asUser, orchDb } from "./helpers/orch-db";

vi.mock("server-only", () => ({}));
const emails = vi.hoisted(() => [] as { userId: string; kind: string; key: string; data: Record<string, unknown> }[]);
vi.mock("@/lib/email", () => ({
  sendCustomerEmail: async (userId: string, kind: string, key: string, data: Record<string, unknown>) => {
    emails.push({ userId, kind, key, data });
    return true;
  },
}));

const { inBackground, listInbox, markInboxRead, notifyUser, waitingCount } = await import("@/lib/inbox");

let db: PGlite;
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
const DAVE = "44444444-4444-4444-8444-444444444444";
const auth = (id: string) => ({ mode: "authenticated" as const, user: { id }, supabase: asUser(db, id) }) as unknown as Parameters<typeof notifyUser>[0];

/** As a signed-in user, straight SQL (the function is called the way PostgREST calls it). */
async function asRole<T>(id: string, sql: string, params: unknown[] = []): Promise<T[]> {
  await db.exec(`select set_config('request.jwt.claim.sub', '${id}', false); set role authenticated;`);
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec("reset role");
  }
}

/** One run: `units` spread over `parts` usage records a minute apart, starting `minutesAgo` minutes ago. */
async function run(user: string, minutesAgo: number, units: number, parts = 2, purpose = "deep_research", entitlement: string | null = "pro") {
  for (let i = 0; i < parts; i++) {
    const [{ id }] = await q<{ id: string }>("insert into public.model_runs (user_id, model_id, status, purpose, units, entitlement) values ($1, 'anthropic:claude-haiku', 'success', $2, $3, $4) returning id", [user, purpose, units / parts, entitlement]);
    // Records are stamped with the real time on insert (no backdating); the test moves them back afterwards.
    await q("update public.model_runs set created_at = now() - ($2::text || ' minutes')::interval where id = $1", [id, String(minutesAgo - i)]);
  }
}

beforeAll(async () => {
  db = await orchDb();
  await db.exec(`insert into auth.users (id, email) values ('${DAVE}', 'dave@x.test')`);
}, 120_000);
afterAll(() => db.close());
beforeEach(async () => {
  emails.length = 0;
  await db.exec("reset role; delete from public.model_runs; delete from public.user_notifications; delete from public.code_agent_runs;");
});

describe("what a task typically uses, across all accounts", () => {
  const typical = () => asRole<{ typical: string; low: string; high: string; runs: number }>(BOB, "select * from public.usage_typical_run(array['deep_research'])");

  it("returns nothing until at least three accounts and five runs (nobody's own pattern can be read back)", async () => {
    await run(ALICE, 600, 40);
    await run(ALICE, 300, 60);
    await run(CAROL, 500, 50);
    await run(CAROL, 200, 70);
    await run(CAROL, 100, 30);
    expect(await typical()).toEqual([]); // five runs, but only two accounts
    await run(DAVE, 50, 20);
    const [r] = await typical();
    expect(r).toMatchObject({ runs: 6 });
    expect(Number(r!.typical)).toBe(45); // median of 20, 30, 40, 50, 60, 70
    expect(Number(r!.low)).toBeLessThan(Number(r!.typical));
    expect(Number(r!.high)).toBeGreaterThan(Number(r!.typical));
  });

  it("counts records within 15 minutes of each other as one run, and leaves out other tasks and unlimited accounts", async () => {
    // Three records 1 minute apart: one run of 90.
    await run(ALICE, 600, 90, 3);
    await run(ALICE, 300, 10);
    await run(CAROL, 500, 10);
    await run(CAROL, 200, 10);
    await run(DAVE, 50, 10);
    await run(DAVE, 40, 999, 1, "chat"); // another feature
    await run(BOB, 30, 999, 2, "deep_research", "admin_unlimited"); // not counted
    const [r] = await typical();
    expect(r).toMatchObject({ runs: 5 });
    expect(Number(r!.high)).toBeLessThanOrEqual(90);
  });

  it("can't be called without signing in", async () => {
    await db.exec("set role anon");
    try {
      await expect(db.query("select * from public.usage_typical_run(array['deep_research'])")).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec("reset role");
    }
  });
});

describe("the inbox", () => {
  const note = { kind: "task_done" as const, key: "code_run:r1:completed:4", title: "Add a contact form", body: "Added the form and a test.", href: "/code/p1?run=r1" };

  it("records an update once, for its owner only, and emails it only when nobody was watching", async () => {
    await notifyUser(auth(ALICE), note);
    await notifyUser(auth(ALICE), note); // a repeat save
    expect(emails).toEqual([]); // the page was open
    expect((await listInbox(auth(ALICE))).items).toHaveLength(1);
    expect((await listInbox(auth(BOB))).items).toHaveLength(0);

    await inBackground(() => notifyUser(auth(ALICE), { ...note, key: "code_run:r1:failed:5", kind: "task_failed" }));
    await inBackground(() => notifyUser(auth(ALICE), { ...note, key: "code_run:r1:failed:5", kind: "task_failed" }));
    expect(emails).toEqual([{ userId: ALICE, kind: "task_failed", key: "code_run:r1:failed:5", data: { task: "Add a contact form", detail: "Added the form and a test.", path: "/code/p1?run=r1" } }]);
    expect(await listInbox(auth(ALICE))).toMatchObject({ unread: 2 });
  });

  it("doesn't email someone who turned task emails off", async () => {
    await q("insert into public.profiles (id, preferences) values ($1, '{\"notifyEmail\": false}') on conflict (id) do update set preferences = excluded.preferences", [CAROL]);
    await inBackground(() => notifyUser(auth(CAROL), note));
    expect(emails).toEqual([]);
    expect((await listInbox(auth(CAROL))).items).toHaveLength(1);
  });

  it("marks updates read, one or all, and only the user's own", async () => {
    await notifyUser(auth(ALICE), note);
    await notifyUser(auth(ALICE), { ...note, key: "k2" });
    await notifyUser(auth(BOB), { ...note, key: "k3" });
    const { items } = await listInbox(auth(ALICE));
    await markInboxRead(auth(ALICE), [items[0]!.id]);
    expect(await listInbox(auth(ALICE))).toMatchObject({ unread: 1 });
    await markInboxRead(auth(ALICE), "all");
    expect(await listInbox(auth(ALICE))).toMatchObject({ unread: 0 });
    expect(await listInbox(auth(BOB))).toMatchObject({ unread: 1 });
  });

  it("lets a user change only the read mark, never write for someone else, and keeps links inside Orbis", async () => {
    await notifyUser(auth(ALICE), note);
    const [{ id }] = await q<{ id: number }>("select id from public.user_notifications");
    await expect(asRole(ALICE, "update public.user_notifications set title = 'Changed' where id = $1", [id])).rejects.toThrow(/permission denied/);
    await expect(asRole(ALICE, "insert into public.user_notifications (user_id, kind, dedupe_key, title) values ($1, 'task_done', 'x', 'For Bob')", [BOB])).rejects.toThrow(/row-level security/);
    for (const href of ["https://evil.example/login", "//evil.example", "javascript:alert(1)", "/ok//evil.example"])
      await expect(asRole(ALICE, "insert into public.user_notifications (kind, dedupe_key, title, href) values ('task_done', $1, 't', $2)", [href, href])).rejects.toThrow(/check constraint/);
    // The server drops such links before writing anyway.
    await notifyUser(auth(ALICE), { ...note, key: "k-ext", href: "https://evil.example" });
    expect((await listInbox(auth(ALICE))).items.find((i) => i.title === note.title && i.href === null)).toBeTruthy();
  });

  it("a coding task saved as finished or waiting in the background becomes one update; with its page open, none", async () => {
    const { updateRun } = await import("@/lib/code/agent/runs");
    const [{ id: project }] = await q<{ id: string }>("select id from public.code_projects where user_id = $1 limit 1", [ALICE]);
    const [{ id: runId }] = await q<{ id: string }>("insert into public.code_agent_runs (project_id, user_id, request, status) values ($1, $2, 'Add a contact form', 'running') returning id", [project, ALICE]);
    const a = auth(ALICE) as never;
    await updateRun(a, runId, { status: "awaiting_approval", pending: { kind: "plan" } } as never); // page open
    expect((await listInbox(auth(ALICE))).items).toHaveLength(0);
    await inBackground(() => updateRun(a, runId, { status: "completed", summary: "Added the form." } as never));
    await inBackground(() => updateRun(a, runId, { status: "completed", summary: "Added the form." } as never)); // saved twice
    await inBackground(() => updateRun(a, runId, { summary: "Edited summary" } as never)); // not a status change
    const { items } = await listInbox(auth(ALICE));
    expect(items).toEqual([expect.objectContaining({ kind: "task_done", title: "Add a contact form", body: "Added the form.", href: `/code/${project}?run=${runId}` })]);
    expect(emails.map((e) => e.kind)).toEqual(["task_done"]);
  });

  it("counts the tasks waiting for the user", async () => {
    await asService(db).from("code_projects").select("id").limit(1);
    const [{ id: project }] = await q<{ id: string }>("select id from public.code_projects where user_id = $1 limit 1", [ALICE]);
    await q("insert into public.code_agent_runs (project_id, user_id, request, status) values ($1, $2, 'a', 'awaiting_approval'), ($1, $2, 'b', 'needs_input'), ($1, $2, 'c', 'running')", [project, ALICE]);
    expect(await waitingCount(auth(ALICE))).toBe(2);
    expect(await waitingCount(auth(BOB))).toBe(0);
  });
});
