/**
 * Attachments for coding tasks: what can be attached (checked in the browser
 * and again on the server from the contents), how they reach the model
 * (text in the first message, images only to models that can see them), and
 * the table's rules in the real migrations on PGlite.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { attachmentInput, isTextName, looksBinary, rejectReason, sniffImage } from "@/lib/code/attachments";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/ai", () => ({}));

const { checkAttachment } = await import("@/lib/code/attachments-store");
const { attachmentsBlock, toToolMessages } = await import("@/lib/code/agent/protocol");
const { toAnthropicToolMessages } = await import("@/lib/ai/providers/anthropic");
const { toOpenAIToolMessages } = await import("@/lib/ai/providers/openai-compatible");

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]).toString("base64");

describe("what can be attached", () => {
  it("takes source, text and config files and common images", () => {
    for (const n of ["app.tsx", "main.py", "README.md", "Dockerfile", "config.yaml", ".gitignore", "styles.scss", "schema.sql", "notes.txt", "data.csv"]) expect(isTextName(n)).toBe(true);
    expect(rejectReason({ name: "shot.png", type: "image/png", size: 5_000_000 })).toBeNull();
    expect(rejectReason({ name: "app.ts", type: "", size: 1000 })).toBeNull();
  });

  it("explains what it can't take", () => {
    expect(rejectReason({ name: ".env", type: "", size: 10 })).toMatch(/secrets/);
    expect(rejectReason({ name: "deploy/id_rsa", type: "", size: 10 })).toMatch(/secrets/);
    expect(rejectReason({ name: ".env.example", type: "", size: 10 })).toBeNull();
    expect(rejectReason({ name: "spec.pdf", type: "application/pdf", size: 10 })).toMatch(/PDF and Office files can't be read yet/);
    expect(rejectReason({ name: "pic.bmp", type: "image/bmp", size: 10 })).toMatch(/only PNG, JPEG, WebP and GIF/);
    expect(rejectReason({ name: "app.exe", type: "application/octet-stream", size: 10 })).toMatch(/only text and source files/);
    expect(rejectReason({ name: "big.json", type: "application/json", size: 300_000 })).toMatch(/larger than 200 KB/);
  });

  it("refuses names that could escape a folder", () => {
    const ok = (name: string) => attachmentInput.safeParse({ kind: "text", name, content: "x" }).success;
    expect(ok("src/app.ts")).toBe(true);
    expect(ok("../etc/passwd")).toBe(false);
    expect(ok("/etc/passwd")).toBe(false);
    expect(ok("a\\b.ts")).toBe(false);
    expect(ok("a\nb.ts")).toBe(false);
    expect(attachmentInput.safeParse({ kind: "image", name: "a.png", mediaType: "image/gif", data: PNG }).success).toBe(false);
    expect(attachmentInput.safeParse({ kind: "image", name: "a.png", mediaType: "image/png", data: "not base64!" }).success).toBe(false);
  });

  it("knows binary from text, and images from their bytes", () => {
    expect(looksBinary("hello\u0000world")).toBe(true);
    expect(looksBinary("plain text, café")).toBe(false);
    expect(sniffImage(Buffer.from(PNG, "base64"))).toBe("image/png");
    expect(sniffImage(Buffer.from(JPEG, "base64"))).toBe("image/jpeg");
    expect(sniffImage(Buffer.from("GIF89a"))).toBeNull();
  });
});

describe("the server's checks (from the contents, not the name)", () => {
  it("accepts real text and real images", () => {
    expect(checkAttachment({ kind: "text", name: "a.ts", content: "const a = 1;" })).toMatchObject({ kind: "text", mediaType: "text/plain", size: 12 });
    expect(checkAttachment({ kind: "image", name: "a.png", mediaType: "image/png", data: PNG })).toMatchObject({ kind: "image", mediaType: "image/png", size: Buffer.from(PNG, "base64").length });
  });

  it("refuses binary dressed as text, fake images, wrong types and secrets", () => {
    expect(() => checkAttachment({ kind: "text", name: "a.ts", content: "\u0000\u0001ELF" })).toThrow(/isn't a text file/);
    expect(() => checkAttachment({ kind: "image", name: "a.png", mediaType: "image/png", data: Buffer.from("<script>alert(1)</script>").toString("base64") })).toThrow(/isn't a PNG or JPEG/);
    expect(() => checkAttachment({ kind: "image", name: "a.png", mediaType: "image/png", data: JPEG })).toThrow(/isn't the image type it says/);
    expect(() => checkAttachment({ kind: "text", name: "config/.env.production", content: "KEY=1" })).toThrow(/secrets/);
    expect(() => checkAttachment({ kind: "image", name: "a.png", mediaType: "image/png", data: Buffer.concat([Buffer.from(PNG, "base64"), Buffer.alloc(2_600_000)]).toString("base64") })).toThrow(
      /at most 2.5 MB/,
    );
  });
});

describe("how attachments reach the model", () => {
  const items = [
    { name: "a.ts", kind: "text" as const, size: 10, content: "AAA-CONTENT" },
    { name: "big.log", kind: "text" as const, size: 50, content: "x".repeat(50) },
    { name: "shot.png", kind: "image" as const, size: 68, content: PNG },
  ];

  it("puts text in the first message within a budget, and lists the rest to read", () => {
    const block = attachmentsBlock(items, true, 20);
    expect(block).toContain('<attachment name="a.ts">');
    expect(block).toContain("AAA-CONTENT");
    expect(block).toContain("Attached file big.log (50 characters): not shown here; read it with read_attachment.");
    expect(block).toContain("Attached images (shown with this message, in this order): shot.png");
    expect(block).toMatch(/data from the user/);
  });

  it("never claims the model saw images it can't see", () => {
    const block = attachmentsBlock(items, false);
    expect(block).toContain("can't view images, so you have NOT seen them");
    expect(block).not.toContain("shown with this message");
    expect(attachmentsBlock([], true)).toBe("");
  });

  it("goes with the first message only, as image blocks for Claude and image parts for GPT", () => {
    const msgs = toToolMessages(
      [
        { role: "user", content: "Request: recreate this" },
        { role: "assistant", content: "ok", calls: [{ id: "c1", tool: "list_files", args: {} }] },
        { role: "user", content: "", results: [{ id: "c1", tool: "list_files", ok: true, text: "a.ts" }] },
      ],
      new Map(),
      [{ mediaType: "image/png", data: PNG }],
    );
    expect(msgs[0]).toMatchObject({ role: "user", images: [{ mediaType: "image/png", data: PNG }] });
    expect(msgs[2]).not.toHaveProperty("images");
    const claude = toAnthropicToolMessages(msgs);
    expect(claude[0]!.content).toEqual([
      { type: "text", text: "Request: recreate this" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
    ]);
    const gpt = toOpenAIToolMessages(msgs);
    expect(gpt[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Request: recreate this" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } },
      ],
    });
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
const newRun = (user: string, project: string) =>
  as(user, async () => (await q<{ id: string }>("insert into public.code_agent_runs (project_id, request, status, options) values ($1, 'Do it', 'running', '{}') returning id", [project]))[0]!.id);
const attach = (user: string, project: string, name = "a.ts", kind = "text", media = "text/plain", content = "x") =>
  as(
    user,
    async () =>
      (
        await q<{ id: string }>("insert into public.code_agent_attachments (project_id, name, kind, media_type, size, content) values ($1, $2, $3, $4, 1, $5) returning id", [
          project,
          name,
          kind,
          media,
          content,
        ])
      )[0]!.id,
  );

describe("the attachments table", () => {
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

  it("is visible to the uploader only, on their own project", async () => {
    const p = await newProject(ALICE);
    await attach(ALICE, p);
    expect(await as(BOB, () => q("select * from public.code_agent_attachments"))).toEqual([]);
    await expect(attach(BOB, p)).rejects.toThrow(/row-level security/);
    expect(await as(ALICE, () => q("select name from public.code_agent_attachments"))).toEqual([{ name: "a.ts" }]);
  });

  it("can be tied only to the uploader's own run on the same project; contents never change", async () => {
    const p = await newProject(ALICE);
    const p2 = await newProject(ALICE, "Other");
    const runP2 = await newRun(ALICE, p2);
    const bobProject = await newProject(BOB);
    const bobRun = await newRun(BOB, bobProject);
    const a = await attach(ALICE, p);
    await expect(as(ALICE, () => q("update public.code_agent_attachments set run_id = $1 where id = $2", [runP2, a]))).rejects.toThrow(/row-level security/);
    await expect(as(ALICE, () => q("update public.code_agent_attachments set run_id = $1 where id = $2", [bobRun, a]))).rejects.toThrow(/row-level security/);
    await expect(as(ALICE, () => q("update public.code_agent_attachments set content = 'changed' where id = $1", [a]))).rejects.toThrow(/permission denied/);
    await expect(as(ALICE, () => q("update public.code_agent_attachments set project_id = $1 where id = $2", [p2, a]))).rejects.toThrow(/permission denied/);
    const run = await newRun(ALICE, p);
    await as(ALICE, () => q("update public.code_agent_attachments set run_id = $1 where id = $2", [run, a]));
  });

  it("checks names, kinds and sizes", async () => {
    const p = await newProject(ALICE);
    await expect(attach(ALICE, p, "../x.ts")).rejects.toThrow(/check constraint/);
    await expect(attach(ALICE, p, "a.png", "image", "image/gif", "x")).rejects.toThrow(/check constraint/);
    await expect(attach(ALICE, p, "a.ts", "text", "image/png", "x")).rejects.toThrow(/check constraint/);
    await expect(attach(ALICE, p, "a.ts", "text", "text/plain", "x".repeat(204_801))).rejects.toThrow(/check constraint/);
  });

  it("keeps at most 40 waiting per user and 20 per task", async () => {
    const p = await newProject(ALICE);
    await as(ALICE, () =>
      q("insert into public.code_agent_attachments (project_id, name, kind, media_type, size, content) select $1, 'f' || g || '.ts', 'text', 'text/plain', 1, 'x' from generate_series(1, 40) g", [p]),
    );
    await expect(attach(ALICE, p)).rejects.toThrow(/Too many attachments waiting/);
    const run = await newRun(ALICE, p);
    await as(ALICE, () => q("update public.code_agent_attachments set run_id = $1 where name in (select 'f' || g || '.ts' from generate_series(1, 20) g)", [run]));
    await expect(as(ALICE, () => q("update public.code_agent_attachments set run_id = $1 where name = 'f21.ts'", [run]))).rejects.toThrow(/at most 20 attachments/);
  });

  it("goes with its project", async () => {
    const p = await newProject(ALICE);
    await attach(ALICE, p);
    await as(ALICE, () => q("delete from public.code_projects where id = $1", [p]));
    expect(await q("select * from public.code_agent_attachments")).toEqual([]);
  });
});
