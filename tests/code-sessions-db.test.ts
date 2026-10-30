/**
 * The sessions-and-settings migration on PGlite (every real migration applied), through the server code: messages
 * sent while a session works (each taken exactly once, only the owner's, never into an ended session), rewind points,
 * the wider step limit, the user's agent settings for a project, and parallel copies merged back without losing
 * changes made in the original.
 */
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ALICE, ALICE_PROJECT, BOB, asUser, orchDb } from "./helpers/orch-db";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/entitlements", () => ({ entitlementFor: async () => ({ kind: "unlimited" }) }));

const { pushMessage, takeMessages, createCheckpoint, listCheckpoints } = await import("@/lib/code/agent/runs");
const { addRule, getAgentSettings, getOrbisFiles, mcpAddressProblem, publicSettings, saveAgentSettings, sealedServer } = await import("@/lib/code/agent-settings");
const { createCopy, listCopies, mergeCopy, planMerge, contentHash } = await import("@/lib/code/copies");

let db: PGlite;
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
type Auth = Parameters<typeof pushMessage>[0];
const auth = (id: string) => ({ mode: "authenticated" as const, user: { id, email: null, displayName: null }, supabase: asUser(db, id) }) as unknown as Auth;

async function newRun(status = "running") {
  const [{ id }] = await q<{ id: string }>("insert into public.code_agent_runs (user_id, project_id, request, status) values ($1, $2, 'Add login', $3) returning id", [ALICE, ALICE_PROJECT, status]);
  return id;
}

beforeAll(async () => {
  db = await orchDb();
}, 120_000);
afterAll(() => db.close());
beforeEach(async () => {
  await db.exec(`reset role; delete from public.code_agent_runs; delete from public.code_projects where parent_project_id is not null; update public.code_projects set agent_settings = '{}';`);
});

describe("messages sent while a session works", () => {
  it("wait in its inbox and are each taken exactly once", async () => {
    const run = await newRun();
    const a = auth(ALICE);
    expect(await pushMessage(a, run, "use tailwind instead")).toBe(true);
    expect(await pushMessage(a, run, "and keep the old colours")).toBe(true);
    const taken = await takeMessages(a, run);
    expect(taken.map((m) => m.text)).toEqual(["use tailwind instead", "and keep the old colours"]);
    expect(await takeMessages(a, run)).toEqual([]);
    const [{ inbox }] = await q<{ inbox: unknown[] }>("select inbox from public.code_agent_runs where id = $1", [run]);
    expect(inbox).toEqual([]);
  });

  it("can't be sent to someone else's session, to an ended one, or more than 20 at a time", async () => {
    const run = await newRun();
    expect(await pushMessage(auth(BOB), run, "hi")).toBe(false);
    expect(await takeMessages(auth(BOB), run)).toEqual([]);
    for (let i = 0; i < 20; i++) expect(await pushMessage(auth(ALICE), run, `m${i}`)).toBe(true);
    expect(await pushMessage(auth(ALICE), run, "one too many")).toBe(false);
    const done = await newRun("completed");
    expect(await pushMessage(auth(ALICE), done, "late")).toBe(false);
  });

  it("can't be written directly by another user", async () => {
    const run = await newRun();
    await asUser(db, BOB).from("code_agent_runs").update({ inbox: [{ text: "injected", at: "x" }] }).eq("id", run);
    const [{ inbox }] = await q<{ inbox: unknown[] }>("select inbox from public.code_agent_runs where id = $1", [run]);
    expect(inbox).toEqual([]);
  });
});

describe("rewind points and longer sessions", () => {
  it("are kept apart from the agent's own checkpoints", async () => {
    const run = await newRun();
    const a = auth(ALICE);
    await createCheckpoint(a, run, "Before: add login", {}, { transcriptLen: 0, message: "add login" });
    await createCheckpoint(a, run, "before refactor", { "src/app.ts": "x" });
    expect((await listCheckpoints(a, run, "turn")).map((c) => [c.kind, c.transcriptLen, c.message])).toEqual([["turn", 0, "add login"]]);
    expect((await listCheckpoints(a, run)).map((c) => c.label)).toEqual(["before refactor"]);
  });

  it("allow up to 2,000 steps", async () => {
    const run = await newRun();
    await q("update public.code_agent_runs set step_limit = 1500 where id = $1", [run]);
    await expect(q("update public.code_agent_runs set step_limit = 2500 where id = $1", [run])).rejects.toThrow();
  });
});

describe("the user's agent settings for a project", () => {
  it("are kept per project, cleaned on save, and only the owner's", async () => {
    const a = auth(ALICE);
    await saveAgentSettings(a, ALICE_PROJECT, { rules: { allow: ["bash(npm test*)", "junk"], deny: [] } });
    await addRule(a, ALICE_PROJECT, "allow", "bash(npm run lint*)");
    await addRule(a, ALICE_PROJECT, "allow", "bash(npm run lint*)");
    expect((await getAgentSettings(a, ALICE_PROJECT)).rules).toEqual({ allow: ["bash(npm test*)", "bash(npm run lint*)"], deny: [] });
    await expect(getAgentSettings(auth(BOB), ALICE_PROJECT)).rejects.toMatchObject({ code: "not_found" });
    await asUser(db, BOB).from("code_projects").update({ agent_settings: { rules: { allow: ["bash"], deny: [] } } }).eq("id", ALICE_PROJECT);
    expect((await getAgentSettings(a, ALICE_PROJECT)).rules?.allow).not.toContain("bash");
  });

  it("never send an MCP server's token back to the page", async () => {
    process.env.ORBIS_CONNECTOR_KEY = Buffer.alloc(32, 7).toString("base64");
    const a = auth(ALICE);
    const server = sealedServer(a, ALICE_PROJECT, { name: "github", url: "https://mcp.example.com", token: "secret-token-123" });
    expect(server.token).toBeTruthy();
    expect(server.token).not.toContain("secret-token-123");
    await saveAgentSettings(a, ALICE_PROJECT, { mcp: [server] });
    expect(publicSettings(await getAgentSettings(a, ALICE_PROJECT)).mcp).toEqual([{ name: "github", url: "https://mcp.example.com", hasToken: true }]);
    expect(() => sealedServer(a, ALICE_PROJECT, { name: "x", url: "http://localhost:3000" })).toThrow(/https/);
  });

  it("read the project's agent files without loading the whole project", async () => {
    await q("insert into public.code_files (project_id, path, content) values ($1, '.orbis/settings.json', '{}'), ($1, 'ORBIS.md', '# notes') on conflict do nothing", [ALICE_PROJECT]);
    expect((await getOrbisFiles(auth(ALICE), ALICE_PROJECT)).map((f) => f.path).sort()).toEqual([".orbis/settings.json", "ORBIS.md"]);
    expect(await getOrbisFiles(auth(BOB), ALICE_PROJECT)).toEqual([]);
  });
});

describe("parallel copies", () => {
  it("plan a merge: copy-only changes apply, both-sides changes are conflicts", () => {
    const base = { "a.ts": contentHash("a"), "b.ts": contentHash("b"), "c.ts": contentHash("c"), "gone.ts": contentHash("g") };
    const copy = { "a.ts": "a2", "b.ts": "b2", "c.ts": "c", "new.ts": "n" }; // gone.ts deleted in the copy
    const original = { "a.ts": contentHash("a"), "b.ts": contentHash("b-original"), "c.ts": contentHash("c-original"), "gone.ts": contentHash("g") };
    const plan = planMerge(base, copy, original);
    expect(plan.apply).toEqual([
      { path: "a.ts", content: "a2" },
      { path: "gone.ts", content: null },
      { path: "new.ts", content: "n" },
    ]);
    expect(plan.conflicts).toEqual(["b.ts"]);
  });

  it("are made from a project, listed with it, and merged back", async () => {
    const a = auth(ALICE);
    const copy = await createCopy(a, ALICE_PROJECT, "add dark mode");
    expect(copy).toMatchObject({ parentProjectId: ALICE_PROJECT, copyTask: "add dark mode" });
    expect((await listCopies(a, ALICE_PROJECT)).map((c) => c.id)).toEqual([copy.id]);
    // Work in the copy, and an unrelated change in the original meanwhile.
    await q("update public.code_files set content = 'export const add = (a: number, b: number) => a + b;\\n' where project_id = $1 and path = 'src/app.ts'", [copy.id]);
    await q("insert into public.code_files (project_id, path, content) values ($1, 'src/theme.ts', 'dark')", [copy.id]);
    await q("insert into public.code_files (project_id, path, content) values ($1, 'NOTES.md', 'original only')", [ALICE_PROJECT]);
    const r = await mergeCopy(a, copy.id);
    expect(r).toMatchObject({ ok: true, applied: ["src/app.ts", "src/theme.ts"], conflicts: [] });
    const files = await q<{ path: string; content: string }>("select path, content from public.code_files where project_id = $1 order by path", [ALICE_PROJECT]);
    expect(files.find((f) => f.path === "src/app.ts")!.content).toContain("a + b");
    expect(files.map((f) => f.path)).toContain("NOTES.md");
    // Merging again brings nothing new.
    expect((await mergeCopy(a, copy.id)).applied).toEqual([]);
  });

  it("stop at files changed in both, unless the copy's version is chosen", async () => {
    const a = auth(ALICE);
    const copy = await createCopy(a, ALICE_PROJECT, "rename add");
    await q("update public.code_files set content = 'copy version' where project_id = $1 and path = 'src/app.ts'", [copy.id]);
    await q("update public.code_files set content = 'original version' where project_id = $1 and path = 'src/app.ts'", [ALICE_PROJECT]);
    const r = await mergeCopy(a, copy.id);
    expect(r).toMatchObject({ ok: false, conflicts: ["src/app.ts"], applied: [] });
    expect((await q<{ content: string }>("select content from public.code_files where project_id = $1 and path = 'src/app.ts'", [ALICE_PROJECT]))[0]!.content).toBe("original version");
    expect((await mergeCopy(a, copy.id, { force: true })).applied).toEqual(["src/app.ts"]);
    expect((await q<{ content: string }>("select content from public.code_files where project_id = $1 and path = 'src/app.ts'", [ALICE_PROJECT]))[0]!.content).toBe("copy version");
  });

  it("can't be merged by someone else or into a project with a session working", async () => {
    const a = auth(ALICE);
    const copy = await createCopy(a, ALICE_PROJECT, "x");
    await expect(mergeCopy(auth(BOB), copy.id)).rejects.toMatchObject({ code: "not_found" });
    await newRun("running");
    await expect(mergeCopy(a, copy.id)).rejects.toMatchObject({ code: "conflict" });
    await expect(createCopy(a, copy.id, "copy of a copy")).rejects.toMatchObject({ code: "bad_request" });
  });
});

describe("adding an MCP server", () => {
  it("refuses addresses Orbis could never connect to, when they're added", () => {
    for (const url of ["https://127.0.0.1/mcp", "https://10.1.2.3/mcp", "https://169.254.169.254/", "https://[::1]/mcp", "https://localhost/mcp", "https://box.internal/mcp", "https://printer.local/mcp", "https://localhost./mcp", "https://box.internal./mcp"])
      expect(mcpAddressProblem(url), url).toMatch(/private or internal/);
    expect(mcpAddressProblem("https://mcp.example.com:8443/mcp")).toMatch(/port \(443\)/);
    expect(mcpAddressProblem("https://mcp.example.com/mcp")).toBeNull();
    expect(mcpAddressProblem("https://mcp.example.com:443/mcp")).toBeNull();
    expect(() => sealedServer(auth(ALICE) as never, ALICE_PROJECT, { name: "local", url: "https://127.0.0.1/mcp" })).toThrow(/private or internal/);
  });
});
