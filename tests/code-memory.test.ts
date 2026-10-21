/**
 * Project memory: choosing which notes a task gets, the agent's memory tools
 * (suggestions wait for approval), and the table's rules in the real
 * migrations on PGlite (owner only, limits, columns that can't change).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryBlock, memoryInput, memoryPatch, relevance, searchMemory, selectMemory, terms, workflowRequest, type MemoryEntry } from "@/lib/code/memory";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/ai", () => ({}));

const { runActions } = await import("@/lib/code/agent/tools");
const { toolSchemas } = await import("@/lib/code/agent/tool-specs");
const { initialMessage, systemPrompt } = await import("@/lib/code/agent/protocol");

let n = 0;
const note = (over: Partial<MemoryEntry>): MemoryEntry => ({
  id: `m${++n}`,
  kind: "decision",
  title: "Note",
  content: "Something",
  always: false,
  status: "active",
  source: "user",
  runId: null,
  createdAt: "2026-10-20T00:00:00Z",
  updatedAt: `2026-10-20T00:00:${String(n).padStart(2, "0")}Z`,
  ...over,
});

describe("choosing notes for a task", () => {
  const notes = [
    note({ kind: "instruction", title: "Tests", content: "Run npm test before finishing." }),
    note({ kind: "preference", title: "Styling", content: "Use Tailwind classes, never inline styles.", always: true }),
    note({ kind: "architecture", title: "Payments module", content: "Stripe webhooks live in src/payments/webhook.ts." }),
    note({ kind: "decision", title: "Database", content: "We chose SQLite for the prototype; don't switch to Postgres." }),
    note({ kind: "decision", title: "Payments retries", content: "Webhook retries are idempotent by event id.", status: "proposed", source: "agent" }),
  ];

  it("always includes instructions and every-task notes, adds relevant ones and leaves out the rest", () => {
    const got = selectMemory(notes, "Fix the Stripe webhook in the payments module").map((x) => x.title);
    expect(got.slice(0, 2).sort()).toEqual(["Styling", "Tests"]);
    expect(got).toContain("Payments module");
    expect(got).not.toContain("Database");
  });

  it("never gives the agent a suggestion the user hasn't approved", () => {
    expect(selectMemory(notes, "payments webhook retries idempotent").map((x) => x.title)).not.toContain("Payments retries");
    expect(searchMemory(notes, "retries").map((x) => x.title)).not.toContain("Payments retries");
  });

  it("stays within its budget", () => {
    const big = Array.from({ length: 10 }, (_, i) => note({ kind: "instruction", title: `Rule ${i}`, content: "x".repeat(900) }));
    const got = selectMemory(big, "anything", 3_000);
    expect(got.length).toBe(3);
    expect(got.reduce((s, e) => s + e.content.length, 0)).toBeLessThanOrEqual(3_000);
  });

  it("matches on shared words, titles counting double, and ignores filler", () => {
    expect(terms("Please fix the login page and add tests")).toEqual(["login", "page", "tests"]);
    expect(relevance({ title: "Login", content: "Uses sessions" }, ["login"])).toBe(2);
    expect(relevance({ title: "Other", content: "login form" }, ["login"])).toBe(1);
    expect(relevance({ title: "Other", content: "nothing" }, [])).toBe(0);
  });

  it("describes what was given and what wasn't", () => {
    const used = selectMemory(notes, "Fix the Stripe webhook");
    const block = memoryBlock(used, 4);
    expect(block).toContain("Project memory (written or approved by the user");
    expect(block).toContain("[Instruction] Tests: Run npm test before finishing.");
    expect(block).toContain("search_memory");
    expect(memoryBlock([], 3)).toMatch(/3 notes saved, none matched/);
    expect(memoryBlock([], 0)).toBe("");
  });

  it("puts memory into the task's first message and the rules into the system prompt", () => {
    const msg = initialMessage("Do it", [], { projectName: "P", runCommand: "", computer: false, memory: "Project memory (written or approved by the user…)" });
    expect(msg.indexOf("Project memory")).toBeGreaterThan(msg.indexOf("Request:"));
    expect(msg.indexOf("Project memory")).toBeLessThan(msg.indexOf("Files:"));
    const sys = systemPrompt({ commands: "safe", docs: false, github: false, approvePlans: false, memory: true, planning: false, reviewEdits: false, native: true });
    expect(sys).toContain("propose_memory");
    expect(systemPrompt({ commands: "safe", docs: false, github: false, approvePlans: false, planning: false, reviewEdits: false, native: true })).not.toContain("propose_memory");
  });

  it("validates notes strictly", () => {
    expect(memoryInput.safeParse({ kind: "instruction", title: "T", content: "C" }).success).toBe(true);
    expect(memoryInput.safeParse({ kind: "instruction", title: "T", content: "C", status: "active" }).success).toBe(false);
    expect(memoryInput.safeParse({ kind: "secret", title: "T", content: "C" }).success).toBe(false);
    expect(memoryInput.safeParse({ kind: "instruction", title: " ", content: "C" }).success).toBe(false);
    expect(memoryPatch.safeParse({}).success).toBe(false);
    expect(memoryPatch.safeParse({ status: "proposed" }).success).toBe(false);
    expect(memoryPatch.safeParse({ status: "active" }).success).toBe(true);
    expect(workflowRequest({ title: "Release", content: "Bump the version.\nRun tests." })).toBe("Release\n\nBump the version.\nRun tests.");
  });
});

describe("the agent's memory tools", () => {
  const state = { planApproved: true, approvePlans: false, reviewEdits: false, commands: "safe" as const };
  const env = (proposed: { kind: string; title: string; content: string }[]) => ({
    files: async () => [],
    save: async () => {},
    computer: async () => false,
    exec: async () => ({ exitCode: 0, output: "", durationMs: 0, timedOut: false, cancelled: false, changed: [], skipped: [] }),
    changes: async () => [],
    checkpoints: { list: async () => [], create: async () => ({ id: "c", label: "", createdAt: "", files: [] }) },
    memory: {
      search: async (q: string) => searchMemory([note({ title: "Deploy", content: "We deploy with Vercel." })], q),
      propose: async (x: { kind: string; title: string; content: string }) => {
        proposed.push(x);
        return note({ ...(x as Partial<MemoryEntry>), status: "proposed", source: "agent" });
      },
    },
  });

  it("are offered only when memory is on", () => {
    const names = (memory: boolean) => toolSchemas({ commands: "safe", docs: false, github: false, approvePlans: false, memory }).map((t) => t.name);
    expect(names(true)).toEqual(expect.arrayContaining(["search_memory", "propose_memory"]));
    expect(names(false)).not.toContain("propose_memory");
  });

  it("search finds approved notes", async () => {
    const out = await runActions({ thought: "", actions: [{ id: "1", tool: "search_memory", args: { query: "deploy" } }] }, state, env([]) as never);
    expect(out.results[0]).toMatchObject({ ok: true });
    expect(out.results[0]!.text).toContain("We deploy with Vercel.");
  });

  it("suggestions are saved for approval, logged, and capped per step", async () => {
    const proposed: { kind: string; title: string; content: string }[] = [];
    const ask = (i: number) => ({ id: String(i), tool: "propose_memory", args: { kind: "instruction", title: `Rule ${i}`, content: "Run lint.", reason: "The user said so." } });
    const out = await runActions({ thought: "", actions: [ask(1), ask(2), ask(3)] }, state, env(proposed) as never);
    expect(proposed.map((p) => p.title)).toEqual(["Rule 1", "Rule 2"]);
    expect(out.results.map((r) => r.ok)).toEqual([true, true, false]);
    expect(out.results[0]!.text).toMatch(/approves it before it's used/);
    expect(out.events.filter((e) => e.kind === "note").map((e) => e.title)).toEqual(["Suggested a note for project memory: Rule 1", "Suggested a note for project memory: Rule 2"]);
  });

  it("rejects invalid suggestions", async () => {
    const out = await runActions({ thought: "", actions: [{ id: "1", tool: "propose_memory", args: { kind: "instruction", title: "", content: "x", reason: "y" } }] }, state, env([]) as never);
    expect(out.results[0]).toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------- database rules

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
let db: PGlite;

async function as<T>(user: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${user}', false); set role authenticated;`);
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}
const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.query<T>(sql, params).then((r) => r.rows);
const newProject = (user: string, name = "P") => as(user, async () => (await q<{ id: string }>("insert into public.code_projects (name, template) values ($1, 'blank') returning id", [name]))[0]!.id);
const addNote = (user: string, project: string, status = "active", title = "T") =>
  as(
    user,
    async () =>
      (await q<{ id: string }>("insert into public.code_project_memory (project_id, kind, title, content, status) values ($1, 'instruction', $2, 'C', $3) returning id", [project, title, status]))[0]!
        .id,
  );

describe("the memory table", () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create schema auth;
      create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$;
      grant usage on schema auth to anon, authenticated;
      grant execute on function auth.uid() to anon, authenticated;
      grant usage on schema public to anon, authenticated;
      alter default privileges in schema public grant all on tables to anon, authenticated;
    `);
    const migrations = join(__dirname, "..", "supabase", "migrations");
    for (const f of readdirSync(migrations)
      .filter((f) => f.endsWith(".sql"))
      .sort())
      await db.exec(readFileSync(join(migrations, f), "utf8"));
    await db.exec(`insert into auth.users (id, email) values ('${ALICE}', 'alice@example.com'), ('${BOB}', 'bob@example.com');`);
  }, 60_000);
  afterAll(() => db.close());
  beforeEach(async () => {
    await db.exec("reset role; delete from public.code_projects;");
  });

  it("is visible and changeable by the project's owner only", async () => {
    const p = await newProject(ALICE);
    const id = await addNote(ALICE, p);
    expect(await as(BOB, () => q("select * from public.code_project_memory"))).toEqual([]);
    await expect(addNote(BOB, p)).rejects.toThrow(/row-level security/);
    await as(BOB, () => q("update public.code_project_memory set content = 'hacked'"));
    await as(BOB, () => q("delete from public.code_project_memory"));
    expect(await as(ALICE, () => q("select content from public.code_project_memory where id = $1", [id]))).toEqual([{ content: "C" }]);
    expect(await as(ALICE, () => q("select content from public.code_project_memory"))).toHaveLength(1);
  });

  it("can't be moved to another project or owner, and checks its fields", async () => {
    const p = await newProject(ALICE);
    const p2 = await newProject(ALICE, "Other");
    const id = await addNote(ALICE, p);
    await expect(as(ALICE, () => q("update public.code_project_memory set project_id = $1 where id = $2", [p2, id]))).rejects.toThrow(/permission denied/);
    await expect(as(ALICE, () => q(`update public.code_project_memory set user_id = '${BOB}' where id = $1`, [id]))).rejects.toThrow(/permission denied/);
    await expect(as(ALICE, () => q("update public.code_project_memory set kind = 'secret' where id = $1", [id]))).rejects.toThrow(/check constraint/);
    await expect(as(ALICE, () => q("update public.code_project_memory set title = '   ' where id = $1", [id]))).rejects.toThrow(/check constraint/);
    await as(ALICE, () => q("update public.code_project_memory set status = 'active', always = true where id = $1", [id]));
  });

  it("keeps at most 100 notes per project and 20 suggestions waiting", async () => {
    const p = await newProject(ALICE);
    await as(ALICE, () => q("insert into public.code_project_memory (project_id, kind, title, content, status) select $1, 'decision', 'n' || g, 'c', 'proposed' from generate_series(1, 20) g", [p]));
    await expect(addNote(ALICE, p, "proposed")).rejects.toThrow(/20 suggested notes/);
    await as(ALICE, () => q("insert into public.code_project_memory (project_id, kind, title, content) select $1, 'decision', 'a' || g, 'c' from generate_series(1, 80) g", [p]));
    await expect(addNote(ALICE, p)).rejects.toThrow(/at most 100/);
    // Approving a suggestion doesn't count as a new note.
    await as(ALICE, () => q("update public.code_project_memory set status = 'active' where title = 'n1' and project_id = $1", [p]));
  });

  it("goes with its project", async () => {
    const p = await newProject(ALICE);
    await addNote(ALICE, p);
    await as(ALICE, () => q("delete from public.code_projects where id = $1", [p]));
    expect(await q("select * from public.code_project_memory")).toEqual([]);
  });
});
