/**
 * Mimic: learning a workflow from one demonstration and running it safely. Covers the brief's scenarios: a
 * successful and an incomplete demonstration, a changed layout, missing fields, wrong amounts, duplicates,
 * an unexpected currency, an ambiguous category, repeated triggers, partial failures, the approval and
 * automatic limits, the emergency stop, instructions hidden in a document, and resuming after an interruption.
 */
import { describe, expect, it } from "vitest";
import { appearsIn, extractInvoice, parseAmount, parseDate, suspiciousContent } from "@/lib/mimic/extract";
import { answerQuestion, DemonstrationError, learnFromDemonstration } from "@/lib/mimic/learn";
import { memoryLedger, runWorkflow, type RunInput } from "@/lib/mimic/engine";
import { sampleById, SAMPLE_INVOICES } from "@/lib/mimic/samples";
import type { Demonstration, Rule } from "@/lib/mimic/types";

const teach = sampleById("sample-paper-0412")!;
const t = (s: number) => new Date(Date.UTC(2026, 9, 25, 10, 0, s)).toISOString();

/** What a user does on the practice desk with the first sample. */
const demo = (over: Partial<Demonstration> = {}): Demonstration => ({
  docId: teach.id,
  startedAt: t(0),
  endedAt: t(54),
  events: [
    { kind: "open_document", docId: teach.id, at: t(1) },
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
    { kind: "verify_saved", at: t(52) },
  ],
  ...over,
});

const rule: Rule = { id: "r1", kind: "supplier_category", supplier: "Paper & Co. AG", category: "6000 Office supplies", status: "active", history: [] };

function input(over: Partial<RunInput> & { sample?: string } = {}): RunInput {
  const learned = learnFromDemonstration(demo(), teach.text);
  const doc = sampleById(over.sample ?? "sample-paper-0457")!;
  return {
    workflowId: "w1",
    definition: learned.definition,
    mode: "supervised",
    document: { id: doc.id, text: doc.text },
    rules: [rule],
    ledger: memoryLedger(),
    stopped: false,
    dryRun: false,
    today: "2026-10-25",
    ...over,
  };
}

describe("reading invoices", () => {
  it("parses amounts and dates in common formats, and flags ambiguous dates", () => {
    expect(parseAmount("CHF 1'234.50")).toBe(1234.5);
    expect(parseAmount("1.234,50 EUR")).toBe(1234.5);
    expect(parseAmount("VAT 8.1%: CHF 18.51")).toBe(18.51);
    expect(parseAmount("CHE-123.456.789")).toBeNull();
    expect(parseDate("02.10.2026")).toEqual({ iso: "2026-10-02", ambiguous: false });
    expect(parseDate("October 5, 2026")).toEqual({ iso: "2026-10-05", ambiguous: false });
    expect(parseDate("03/04/2026")).toEqual({ iso: "2026-04-03", ambiguous: true });
    expect(parseDate("31.02.2026")).toBeNull();
  });

  it("doesn't read a VAT number as a tax amount, and keeps the evidence line", () => {
    const x = extractInvoice(teach.text);
    expect(x.tax.value).toBe(18.51);
    expect(x.tax.evidence).toBe("VAT 8.1%: CHF 18.51");
    expect(x.total.value).toBe(247.01);
    expect(x.currency.value).toBe("CHF");
  });

  it("needs the demonstration to read labels it has never seen ('Issued:')", () => {
    expect(extractInvoice(teach.text).invoiceDate.value).toBeNull();
    const { definition } = learnFromDemonstration(demo(), teach.text);
    expect(extractInvoice(teach.text, definition.hints).invoiceDate.value).toBe("2026-10-02");
  });

  it("flags instructions hidden in a document", () => {
    expect(suspiciousContent(sampleById("sample-brightline-901")!.text)).toMatch(/ignore previous instructions/i);
    expect(SAMPLE_INVOICES.filter((s) => suspiciousContent(s.text)).map((s) => s.id)).toEqual(["sample-brightline-901"]);
  });

  it("only accepts values that are literally in the document", () => {
    expect(appearsIn(teach.text, "total", 247.01)).toBe(true);
    expect(appearsIn(teach.text, "total", 999.99)).toBe(false);
    expect(appearsIn(teach.text, "invoiceDate", "2026-10-02")).toBe(true);
  });
});

describe("learning from a demonstration", () => {
  it("learns labels, keeps the safety steps, and asks instead of assuming", () => {
    const l = learnFromDemonstration(demo(), teach.text);
    expect(l.definition.hints.invoiceDate).toEqual(["issued"]);
    expect(l.definition.hints.supplier).toEqual(["(top of document)"]);
    expect(l.definition.currencies).toEqual(["CHF"]);
    expect(l.definition.demoSeconds).toBe(54);
    expect(l.definition.steps.map((s) => [s.kind, s.origin])).toEqual([
      ["receive_document", "learned"],
      ["extract", "learned"],
      ["check_duplicates", "learned"],
      ["validate", "added"],
      ["categorise", "learned"],
      ["create_draft", "learned"],
      ["verify", "learned"],
      ["log", "learned"],
    ]);
    expect(l.definition.steps.find((s) => s.kind === "create_draft")!.requiresApproval).toBe(true);
    expect(l.questions.map((q) => q.id)).toEqual(["category"]);
  });

  it("asks where a typed value came from, and turns a due date into a rule only when the user agrees", () => {
    const events = demo().events.map((e) => (e.kind === "copy_from_document" && e.field === "dueDate" ? { kind: "type_field" as const, field: "dueDate" as const, value: "16.11.2026", at: e.at } : e));
    const l = learnFromDemonstration(demo({ events }), teach.text);
    const q = l.questions.find((x) => x.id === "due")!;
    expect(q.text).toMatch(/45 days after the invoice date/);
    const yes = answerQuestion(l.definition, q, "days");
    expect(yes.definition.derived.dueDate).toEqual({ kind: "days_after", from: "invoiceDate", days: 45 });
    expect(answerQuestion(l.definition, q, "ask").definition.derived.dueDate).toEqual({ kind: "ask" });
  });

  it("a category becomes a rule only when the user says 'always'", () => {
    const l = learnFromDemonstration(demo(), teach.text);
    const q = l.questions.find((x) => x.id === "category")!;
    expect(answerQuestion(l.definition, q, "always").rule).toEqual({ supplier: "Paper & Co. AG", category: "6000 Office supplies" });
    expect(answerQuestion(l.definition, q, "ask").rule).toBeNull();
  });

  it("rejects an incomplete demonstration", () => {
    expect(() => learnFromDemonstration(demo({ events: demo().events.filter((e) => e.kind !== "save_draft") }), teach.text)).toThrow(DemonstrationError);
    expect(() => learnFromDemonstration(demo({ events: demo().events.filter((e) => !(e.kind === "copy_from_document" && e.field === "total")) }), teach.text)).toThrow(/without total/);
  });
});

describe("running a workflow", () => {
  it("handles a changed layout from the same supplier and waits for approval in supervised mode", async () => {
    const r = await runWorkflow(input());
    expect(r.status).toBe("needs_approval");
    expect(r.proposed).toMatchObject({ supplier: "Paper & Co. AG", invoiceNumber: "PC-2026-0457", invoiceDate: "2026-10-16", total: 54.05, currency: "CHF", category: "6000 Office supplies" });
    expect(r.checks.every((c) => c.status === "pass")).toBe(true);
  });

  it("creates and verifies the draft once approved, and a repeated trigger doesn't create it twice", async () => {
    const ledger = memoryLedger();
    const first = await runWorkflow(input({ ledger, approval: {} }));
    expect(first.status).toBe("completed");
    expect(ledger.entries).toHaveLength(1);
    expect(first.steps.find((s) => s.kind === "verify")!.detail).toBe("Every field matches.");
    const again = await runWorkflow(input({ ledger, approval: {} }));
    expect(again.status).toBe("needs_attention");
    expect(again.attention[0]!.kind).toBe("duplicate");
    expect(ledger.entries).toHaveLength(1);
  });

  it("a test run shows what would happen and saves nothing", async () => {
    const ledger = memoryLedger();
    const r = await runWorkflow(input({ ledger, dryRun: true }));
    expect(r.status).toBe("dry_run");
    expect(r.steps.find((s) => s.kind === "create_draft")!.status).toBe("would_do");
    expect(ledger.entries).toHaveLength(0);
  });

  it("stops on a duplicate, an unexpected currency, wrong amounts and a missing category", async () => {
    const ledger = memoryLedger();
    await runWorkflow(input({ ledger, sample: "sample-paper-0412", approval: {} }));
    const dup = await runWorkflow(input({ ledger, sample: "sample-paper-0412-resent", approval: {} }));
    expect(dup.status).toBe("needs_attention");
    expect(dup.attention.map((a) => a.kind)).toContain("duplicate");

    const eur = await runWorkflow(input({ sample: "sample-nimbus-7731" }));
    expect(eur.status).toBe("needs_attention");
    expect(eur.checks.find((c) => c.id === "currency")!.status).toBe("fail");

    const sums = await runWorkflow(input({ sample: "sample-alpen-118" }));
    expect(sums.checks.find((c) => c.id === "arithmetic")!.detail).toMatch(/420\.66, but the total reads 402\.66/);

    const newSupplier = await runWorkflow(input({ sample: "sample-swiftship-5520" }));
    expect(newSupplier.status).toBe("needs_attention");
    expect(newSupplier.attention.map((a) => a.kind)).toEqual(["category"]);
    const answered = await runWorkflow(input({ sample: "sample-swiftship-5520", approval: { category: "6800 Shipping and postage" } }));
    expect(answered.status).toBe("completed");
  });

  it("reports a missing field and accepts a correction", async () => {
    const text = sampleById("sample-swiftship-5520")!.text.replace("Invoice number: SS-5520\n", "");
    const r = await runWorkflow(input({ document: { id: null, text }, rules: [{ ...rule, supplier: "SwiftShip Logistics AG", category: "6800 Shipping and postage" }] }));
    expect(r.status).toBe("needs_attention");
    expect(r.attention[0]!.text).toMatch(/Missing: Invoice number/);
    const fixed = await runWorkflow(input({ document: { id: null, text }, rules: [{ ...rule, supplier: "SwiftShip Logistics AG", category: "6800 Shipping and postage" }], approval: { corrections: { invoiceNumber: "SS-5520" } } }));
    expect(fixed.status).toBe("completed");
  });

  it("treats instructions in a document as data: flagged, never followed, even in automatic mode", async () => {
    const def = input().definition;
    def.steps = def.steps.map((s) => (s.kind === "create_draft" ? { ...s, requiresApproval: false } : s));
    const ledger = memoryLedger();
    const r = await runWorkflow(input({ ledger, mode: "automatic", definition: def, sample: "sample-brightline-901", rules: [{ ...rule, supplier: "Brightline Consulting GmbH", category: "6200 Professional services" }] }));
    expect(r.status).toBe("needs_approval");
    expect(r.attention.map((a) => a.kind)).toEqual(expect.arrayContaining(["suspicious_content", "approval"]));
    expect(ledger.entries).toHaveLength(0);
  });

  it("automatic mode creates drafts only under the limit, and the emergency stop blocks everything", async () => {
    const def = input().definition;
    def.steps = def.steps.map((s) => (s.kind === "create_draft" ? { ...s, requiresApproval: false } : s));
    const ledger = memoryLedger();
    expect((await runWorkflow(input({ ledger, mode: "automatic", definition: def }))).status).toBe("completed");
    const big = await runWorkflow(input({ ledger, mode: "automatic", definition: { ...def, autoLimit: 50 }, sample: "sample-paper-0412" }));
    expect(big.status).toBe("needs_approval");
    expect(big.attention.map((a) => a.kind)).toContain("over_limit");
    const stopped = await runWorkflow(input({ ledger, mode: "automatic", definition: def, sample: "sample-paper-0412", stopped: true }));
    expect(stopped.status).toBe("stopped");
    expect(ledger.entries).toHaveLength(1);
  });

  it("asks before writing even in automatic mode when the step says 'always ask'", async () => {
    expect((await runWorkflow(input({ mode: "automatic" }))).status).toBe("needs_approval");
  });

  it("assist mode only proposes", async () => {
    const ledger = memoryLedger();
    expect((await runWorkflow(input({ ledger, mode: "assist" }))).status).toBe("proposal");
    expect(ledger.entries).toHaveLength(0);
  });

  it("reports partial failures honestly and recovers after an interruption without duplicating", async () => {
    const broken = memoryLedger([], { failInsert: true });
    const r = await runWorkflow(input({ ledger: broken, approval: {} }));
    expect(r.status).toBe("failed");
    expect(r.steps.find((s) => s.kind === "create_draft")!.detail).toMatch(/connection lost/);

    const corrupt = memoryLedger([], { corruptRead: true });
    const v = await runWorkflow(input({ ledger: corrupt, approval: {} }));
    expect(v.status).toBe("failed");
    expect(v.attention.map((a) => a.kind)).toContain("verify_failed");

    // The insert succeeded but the run was interrupted before it was recorded: the retry finds the draft and doesn't duplicate.
    const ledger = memoryLedger();
    const first = await runWorkflow(input({ ledger, approval: {} }));
    const key = first.proposed!.idempotencyKey;
    const resumed = await runWorkflow(input({ ledger: { ...ledger, list: async () => [] }, approval: {} }));
    expect(resumed.status).toBe("completed");
    expect(resumed.alreadyDone).toBe(true);
    expect(ledger.entries.filter((e) => e.idempotencyKey === key)).toHaveLength(1);
  });

  it("discards AI readings that aren't in the document", async () => {
    const text = sampleById("sample-swiftship-5520")!.text.replace("Invoice number: SS-5520", "Ref SS-5520");
    const r = await runWorkflow(
      input({
        document: { id: null, text },
        rules: [{ ...rule, supplier: "SwiftShip Logistics AG", category: "6800 Shipping and postage" }],
        aiExtract: async () => ({ invoiceNumber: "SS-9999" }),
      }),
    );
    expect(r.warnings.join(" ")).toMatch(/isn't in the document; it was discarded/);
    expect(r.status).toBe("needs_attention");
    const ok = await runWorkflow(input({ document: { id: null, text }, rules: [{ ...rule, supplier: "SwiftShip Logistics AG", category: "6800 Shipping and postage" }], aiExtract: async () => ({ invoiceNumber: "SS-5520" }) }));
    expect(ok.extracted!.invoiceNumber).toMatchObject({ value: "SS-5520", source: "ai" });
    expect(ok.status).toBe("needs_approval");
  });
});
