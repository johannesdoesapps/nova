/**
 * Mimic end to end through its server code, on the real migrations with row-level security (PGlite): teach,
 * answer, test, turn on, run, approve, repeated runs, the inbox trigger, the emergency stop, tenant isolation,
 * the append-only audit log and deleting everything.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POSTGREST_PARSERS, supabaseAs } from "./stubs/pglite-supabase";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/observability", () => ({ reportError: () => {} }));
vi.mock("@/lib/usage", () => ({ planLimits: async () => ({ tiers: [], maxOutputTokens: 1000 }), enforceLimits: async () => ({}), recordRun: async () => {} }));
vi.mock("@/lib/ai", () => ({ resolveModelChoice: async () => ({ model: { provider: "demo" } }), getProvider: () => ({}), withTimeout: () => undefined }));

import { addDocument, createFromDemonstration, decideRun, deleteAllData, overview, startRun, updateSettings, updateWorkflow } from "@/lib/mimic/server";
import { sampleById } from "@/lib/mimic/samples";
import type { Demonstration } from "@/lib/mimic/types";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
let db: PGlite;
const auth = (id: string) => ({ mode: "authenticated", user: { id }, supabase: supabaseAs(db, id) }) as never;
const req = new Request("http://localhost/api/mimic");

beforeAll(async () => {
  db = new PGlite({ parsers: POSTGREST_PARSERS });
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin;
    create schema auth;
    create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    grant usage on schema public to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated;
  `);
  const dir = join(__dirname, "..", "supabase", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) await db.exec(readFileSync(join(dir, f), "utf8"));
  await db.exec(`insert into auth.users (id, email) values ('${ALICE}', 'a@x.test'), ('${BOB}', 'b@x.test');`);
}, 60_000);
afterAll(() => db.close());

const t = (s: number) => new Date(Date.UTC(2026, 9, 25, 10, 0, s)).toISOString();
const demo: Demonstration = {
  docId: "sample-paper-0412",
  startedAt: t(0),
  endedAt: t(60),
  events: [
    { kind: "open_document", docId: "sample-paper-0412", at: t(1) },
    { kind: "copy_from_document", field: "supplier", value: "Paper & Co. AG", label: "", at: t(5) },
    { kind: "copy_from_document", field: "invoiceNumber", value: "PC-2026-0412", label: "Inv. No.:", at: t(9) },
    { kind: "copy_from_document", field: "invoiceDate", value: "02.10.2026", label: "Issued:", at: t(13) },
    { kind: "copy_from_document", field: "dueDate", value: "01.11.2026", label: "Payment due:", at: t(16) },
    { kind: "copy_from_document", field: "net", value: "228.50", label: "Subtotal: CHF", at: t(20) },
    { kind: "copy_from_document", field: "tax", value: "18.51", label: "VAT 8.1%: CHF", at: t(24) },
    { kind: "copy_from_document", field: "total", value: "247.01", label: "Total due: CHF", at: t(28) },
    { kind: "type_field", field: "currency", value: "CHF", at: t(31) },
    { kind: "check_duplicates", found: 0, at: t(36) },
    { kind: "choose_category", category: "6000 Office supplies", at: t(42) },
    { kind: "save_draft", at: t(47) },
  ],
};

describe("Mimic, end to end", () => {
  let wfId = "";
  let runId = "";

  it("learns a workflow and won't turn it on before questions are answered and a test has run", async () => {
    const wf = await createFromDemonstration(auth(ALICE), demo);
    wfId = wf.id;
    expect(wf.status).toBe("draft");
    expect(wf.questions.map((q) => q.id)).toEqual(["category"]);
    await expect(updateWorkflow(auth(ALICE), wfId, { status: "active" })).rejects.toThrow(/Answer the open question first/);
    await updateWorkflow(auth(ALICE), wfId, { answer: { questionId: "category", answer: "always" } });
    await expect(updateWorkflow(auth(ALICE), wfId, { status: "active" })).rejects.toThrow(/Run a test first/);
    const test = await startRun(req, auth(ALICE), wfId, "sample-paper-0457", true);
    expect(test.status).toBe("dry_run");
    expect((await overview(auth(ALICE))).ledger).toHaveLength(0);
    const on = await updateWorkflow(auth(ALICE), wfId, { status: "active" });
    expect(on.status).toBe("active");
    const o = await overview(auth(ALICE));
    expect(o.rules.map((r) => [r.supplier, r.category])).toEqual([["Paper & Co. AG", "6000 Office supplies"]]);
  });

  it("waits for approval, creates the draft once, and refuses a second one for the same invoice", async () => {
    const run = await startRun(req, auth(ALICE), wfId, "sample-paper-0457", false);
    runId = run.id;
    expect(run.status).toBe("needs_approval");
    const done = await decideRun(req, auth(ALICE), runId, { action: "approve" });
    expect(done.status).toBe("completed");
    expect(done.result!.steps.find((s) => s.kind === "verify")!.detail).toBe("Every field matches.");
    const again = await startRun(req, auth(ALICE), wfId, "sample-paper-0457", false);
    expect(again.status).toBe("needs_attention");
    const o = await overview(auth(ALICE));
    expect(o.ledger.map((e) => [e.invoiceNumber, e.total, e.invoiceDate, e.category])).toEqual([["PC-2026-0457", 54.05, "2026-10-16", "6000 Office supplies"]]);
    expect(o.stats.savedMinutes).toBeGreaterThan(0);
    await expect(decideRun(req, auth(ALICE), runId, { action: "approve" })).rejects.toThrow(/doesn't need a decision/);
  });

  it("the database itself refuses a second draft with the same key", async () => {
    const dup = await supabaseAs(db, ALICE)
      .from("mimic_ledger")
      .insert({ supplier: "Paper & Co. AG", invoice_number: "PC-2026-0457", invoice_date: "2026-10-16", total: 54.05, currency: "CHF", category: "6000 Office supplies", idempotency_key: "paper co ag|pc-2026-0457" });
    expect(dup.error?.code).toBe("23505");
  });

  it("runs on invoices added to the inbox, once, and asks about a new supplier", async () => {
    await updateWorkflow(auth(ALICE), wfId, { trigger: "document_added" });
    const added = await addDocument(req, auth(ALICE), { name: "SwiftShip October", text: sampleById("sample-swiftship-5520")!.text, source: "paste" });
    expect(added.runs.map((r) => r.status)).toEqual(["needs_attention"]);
    expect(added.runs[0]!.result!.attention.map((a) => a.kind)).toEqual(["category"]);
    await expect(addDocument(req, auth(ALICE), { name: "again", text: sampleById("sample-swiftship-5520")!.text, source: "paste" })).rejects.toThrow(/already in Mimic's inbox/);
    const fixed = await decideRun(req, auth(ALICE), added.runs[0]!.id, { action: "approve", category: "6800 Shipping and postage", remember: false });
    expect(fixed.status).toBe("completed");
    // "Only this invoice": no rule was saved.
    expect((await overview(auth(ALICE))).rules.map((r) => r.supplier)).toEqual(["Paper & Co. AG"]);
  });

  it("the emergency stop blocks real runs", async () => {
    await updateSettings(auth(ALICE), { stopped: true });
    const r = await startRun(req, auth(ALICE), wfId, "sample-paper-0412", false);
    expect(r.status).toBe("stopped");
    await updateSettings(auth(ALICE), { stopped: false });
  });

  it("keeps each user's Mimic private", async () => {
    const bob = await overview(auth(BOB));
    expect([bob.workflows, bob.runs, bob.ledger, bob.rules, bob.events]).toEqual([[], [], [], [], []]);
    await expect(decideRun(req, auth(BOB), runId, { action: "reject" })).rejects.toThrow(/not found/);
    await expect(startRun(req, auth(BOB), wfId, "sample-paper-0412", true)).rejects.toThrow(/not found/);
  });

  it("the audit log can't be edited", async () => {
    const before = (await overview(auth(ALICE))).events;
    expect(before.length).toBeGreaterThan(5);
    expect(before.map((e) => e.kind)).toEqual(expect.arrayContaining(["workflow", "rule", "test", "proposed", "approved", "failed", "settings", "document"]));
    await supabaseAs(db, ALICE).from("mimic_events").update({ summary: "rewritten" });
    expect((await overview(auth(ALICE))).events.some((e) => e.summary === "rewritten")).toBe(false);
  });

  it("deletes everything on request", async () => {
    await deleteAllData(auth(ALICE));
    const o = await overview(auth(ALICE));
    expect([o.workflows, o.runs, o.ledger, o.rules, o.documents, o.events]).toEqual([[], [], [], [], [], []]);
  });
});
