import { appearsIn, extractInvoice, normSupplier, suspiciousContent } from "./extract";
import { findDuplicates, invoiceKey, validateInvoice } from "./validate";
import { FIELDS, FIELD_LABEL, type Attention, type Category, type Extraction, type ExtractedField, type Field, type LedgerEntry, type Mode, type NewLedgerEntry, type Rule, type RunResult, type StepResult, type WorkflowDefinition } from "./types";

/**
 * Running a learned workflow on one invoice. Understanding (the definition) is kept apart from execution
 * (this file). The only external effect is creating a draft in Demo Books, and it happens only when:
 * every check passed, the mode allows it (supervised: after approval; automatic: under the limit, with no
 * warnings), the emergency stop is off, and no draft with the same invoice key exists. Anything uncertain
 * stops the run and goes to "Needs my attention". The invoice's text is data: instructions inside it are
 * flagged and never followed.
 */

export interface LedgerPort {
  /** Recent entries, for duplicate checks. */
  list(): Promise<LedgerEntry[]>;
  byKey(key: string): Promise<LedgerEntry | null>;
  /** Create a draft; must refuse a second entry with the same key (a unique index), returning the existing one. */
  insert(entry: NewLedgerEntry): Promise<LedgerEntry>;
  byId(id: string): Promise<LedgerEntry | null>;
}

export interface RunInput {
  workflowId: string;
  definition: WorkflowDefinition;
  mode: Mode;
  document: { id: string | null; text: string };
  rules: Rule[];
  ledger: LedgerPort;
  /** The emergency stop. */
  stopped: boolean;
  dryRun: boolean;
  /** The user approved the draft (supervised/assist), possibly with corrections. */
  approval?: { corrections?: Partial<Record<Field, string | number>>; category?: Category; notDuplicate?: boolean } | null;
  /** Optional: reads fields the labels couldn't. Answers not found in the document are discarded. */
  aiExtract?: (text: string, fields: Field[]) => Promise<Partial<Record<Field, string | number>>>;
  today: string;
  runId?: string | null;
}

const step = (id: string, kind: StepResult["kind"], title: string, status: StepResult["status"], detail: string): StepResult => ({ stepId: id, kind, title, status, detail });

export async function runWorkflow(input: RunInput): Promise<RunResult> {
  const def = input.definition;
  const enabled = (k: string) => def.steps.find((s) => s.kind === k)?.enabled !== false;
  const titleOf = (k: string) => def.steps.find((s) => s.kind === k)?.title ?? k;
  const steps: StepResult[] = [];
  const attention: Attention[] = [];
  const warnings: string[] = [];
  const result = (status: RunResult["status"], extra: Partial<RunResult> = {}): RunResult => ({
    status,
    steps,
    extracted: null,
    checks: [],
    category: null,
    proposed: null,
    attention,
    ledgerEntryId: null,
    alreadyDone: false,
    warnings,
    ...extra,
  });

  if (input.stopped && !input.dryRun) {
    steps.push(step("receive", "receive_document", titleOf("receive_document"), "blocked", "The emergency stop is on. Nothing was done."));
    return result("stopped");
  }
  const text = input.document.text;
  if (!text.trim()) {
    steps.push(step("receive", "receive_document", titleOf("receive_document"), "failed", "The document is empty."));
    attention.push({ kind: "missing", text: "The invoice has no readable text." });
    return result("needs_attention");
  }
  steps.push(step("receive", "receive_document", titleOf("receive_document"), "done", `${text.length.toLocaleString("en")} characters of text.`));

  // Read the details. Instructions inside the document are noted and ignored.
  const injected = suspiciousContent(text);
  if (injected) {
    warnings.push(`The invoice contains text that reads like an instruction ("${injected}"). Mimic treated it as part of the document and didn't act on it.`);
    attention.push({ kind: "suspicious_content", text: `The invoice contains an instruction-like phrase ("${injected}"). Check it's genuine before approving.` });
  }
  const x: Extraction = extractInvoice(text, def.hints, def.derived);
  if (input.approval?.corrections)
    for (const [f, v] of Object.entries(input.approval.corrections) as [Field, string | number][]) {
      const parsed = FIELDS.includes(f) ? extractInvoice(`${FIELD_LABEL[f]}: ${v}`)[f] : null;
      if (parsed && parsed.value !== null) x[f] = { ...parsed, source: "derived", confidence: "high", evidence: null, note: "Corrected by you." };
    }
  const unread = FIELDS.filter((f) => x[f].value === null && def.derived[f]?.kind !== "ask");
  if (unread.length && input.aiExtract) {
    try {
      const ai = await input.aiExtract(text, unread);
      for (const f of unread) {
        const v = ai[f];
        if (v === undefined || v === null || v === "") continue;
        // Only accept what is literally in the document: an AI answer that isn't there is discarded.
        if (!appearsIn(text, f, v)) {
          warnings.push(`The AI suggested a ${FIELD_LABEL[f].toLowerCase()} that isn't in the document; it was discarded.`);
          continue;
        }
        const parsed = extractInvoice(`${FIELD_LABEL[f]}: ${v}`)[f];
        if (parsed.value !== null) x[f] = { ...parsed, source: "ai", confidence: "medium", evidence: null, note: "Read by AI and found in the document." } as ExtractedField;
      }
    } catch {
      warnings.push("The AI reader wasn't available; only label-based reading was used.");
    }
  }
  const found = FIELDS.filter((f) => x[f].value !== null).length;
  steps.push(step("extract", "extract", titleOf("extract"), "done", `${found} of ${FIELDS.length} details read.`));

  // Duplicates and validation.
  const ledger = await input.ledger.list();
  const dup = findDuplicates(x, ledger);
  if (enabled("check_duplicates")) {
    if (dup.confirmed.length) {
      steps.push(step("duplicates", "check_duplicates", titleOf("check_duplicates"), "blocked", `Already in Demo Books (draft from ${dup.confirmed[0]!.createdAt.slice(0, 10)}).`));
      attention.push({ kind: "duplicate", text: `${x.supplier.value} invoice ${x.invoiceNumber.value} is already in Demo Books. Mimic won't create it twice.` });
    } else if (dup.probable.length && !input.approval?.notDuplicate) {
      steps.push(step("duplicates", "check_duplicates", titleOf("check_duplicates"), "blocked", `A draft with the same supplier, total and date exists (invoice ${dup.probable[0]!.invoiceNumber}).`));
      attention.push({ kind: "duplicate", text: `This may duplicate ${x.supplier.value} invoice ${dup.probable[0]!.invoiceNumber} (same total and date). Confirm it's a different invoice.` });
    } else steps.push(step("duplicates", "check_duplicates", titleOf("check_duplicates"), "done", "No duplicate found."));
  }
  const checks = validateInvoice(x, { currencies: def.currencies, today: input.today });
  const failed = checks.filter((c) => c.status === "fail");
  const warned = checks.filter((c) => c.status === "warn");
  steps.push(step("validate", "validate", titleOf("validate"), failed.length ? "blocked" : "done", failed.length ? failed.map((c) => c.detail).join(" ") : warned.length ? `Passed with ${warned.length} note(s).` : "All checks passed."));
  for (const c of failed) attention.push({ kind: c.id === "required" ? "missing" : "check_failed", text: c.detail });

  // Category: an approved rule, the user's choice on approval, or a question. Never a guess.
  let category: RunResult["category"] = null;
  const supplier = typeof x.supplier.value === "string" ? x.supplier.value : null;
  if (input.approval?.category) category = { value: input.approval.category, source: "correction" };
  else if (supplier) {
    const rule = input.rules.find((r) => r.status === "active" && normSupplier(r.supplier) === normSupplier(supplier));
    if (rule) category = { value: rule.category, source: "rule" };
  }
  if (enabled("categorise")) {
    if (category) steps.push(step("categorise", "categorise", titleOf("categorise"), "done", `${category.value} (${category.source === "rule" ? "your rule for this supplier" : "chosen by you"}).`));
    else {
      steps.push(step("categorise", "categorise", titleOf("categorise"), "blocked", "No approved rule for this supplier."));
      attention.push({ kind: "category", text: `Which category should ${supplier ?? "this supplier"}'s invoice use?` });
    }
  }

  const ready = x.supplier.value !== null && x.invoiceNumber.value !== null && x.invoiceDate.value !== null && x.total.value !== null && x.currency.value !== null;
  const proposed: NewLedgerEntry | null =
    ready && (category || !enabled("categorise"))
      ? {
          supplier: String(x.supplier.value),
          invoiceNumber: String(x.invoiceNumber.value),
          invoiceDate: String(x.invoiceDate.value),
          dueDate: x.dueDate.value === null ? null : String(x.dueDate.value),
          net: x.net.value as number | null,
          tax: x.tax.value as number | null,
          total: x.total.value as number,
          currency: String(x.currency.value),
          category: category?.value ?? "6900 Other expenses",
          idempotencyKey: invoiceKey(String(x.supplier.value), String(x.invoiceNumber.value)),
          documentId: input.document.id,
          runId: input.runId ?? null,
        }
      : null;
  const base = { extracted: x, checks, category, proposed };
  const blocked = attention.some((a) => a.kind !== "suspicious_content") || !proposed;
  const createTitle = titleOf("create_draft");

  if (blocked) {
    steps.push(step("create", "create_draft", createTitle, "skipped", "Not created: the problems above need you first."));
    steps.push(step("log", "log", titleOf("log"), "done", "Recorded in Activity history."));
    return result("needs_attention", base);
  }
  if (input.dryRun) {
    steps.push(step("create", "create_draft", createTitle, "would_do", `Would create a draft: ${proposed.supplier}, ${proposed.invoiceNumber}, ${proposed.currency} ${proposed.total.toFixed(2)}, ${proposed.category}. Test run: nothing was saved.`));
    steps.push(step("verify", "verify", titleOf("verify"), "would_do", "Would read the draft back and compare every field."));
    steps.push(step("log", "log", titleOf("log"), "done", "Recorded as a test run."));
    return result("dry_run", base);
  }

  // Whether the draft may be created now.
  const approved = !!input.approval;
  const createStep = def.steps.find((s) => s.kind === "create_draft");
  if (createStep && !createStep.enabled) {
    steps.push(step("create", "create_draft", createTitle, "skipped", "This step is turned off in the workflow."));
    steps.push(step("log", "log", titleOf("log"), "done", "Recorded in Activity history."));
    return result("completed", base);
  }
  if (!approved) {
    if (input.mode === "assist") {
      steps.push(step("create", "create_draft", createTitle, "waiting", "Assist mode: Mimic prepared the draft; create it yourself with one click."));
      return result("proposal", base);
    }
    // Automatic mode creates drafts on its own unless the step is marked "always ask me".
    const autoOk = input.mode === "automatic" && !createStep?.requiresApproval;
    const overLimit = proposed.total > def.autoLimit;
    const suspicious = attention.some((a) => a.kind === "suspicious_content");
    if (!(autoOk && !overLimit && !warned.length && !suspicious)) {
      if (input.mode === "automatic") {
        if (overLimit) attention.push({ kind: "over_limit", text: `The total (${proposed.currency} ${proposed.total.toFixed(2)}) is over this workflow's automatic limit of ${def.autoLimit.toFixed(2)}.` });
        if (warned.length) attention.push({ kind: "low_confidence", text: `Automatic mode stops on notes: ${warned.map((c) => c.detail).join(" ")}` });
      }
      attention.push({ kind: "approval", text: `Approve creating a draft for ${proposed.supplier} ${proposed.invoiceNumber} (${proposed.currency} ${proposed.total.toFixed(2)}).` });
      steps.push(step("create", "create_draft", createTitle, "waiting", "Waiting for your approval."));
      return result("needs_approval", base);
    }
  }

  // Create the draft, safely: a draft with this invoice's key means an earlier attempt already succeeded.
  const existing = await input.ledger.byKey(proposed.idempotencyKey);
  let entry: LedgerEntry;
  let alreadyDone = false;
  if (existing) {
    entry = existing;
    alreadyDone = true;
    steps.push(step("create", "create_draft", createTitle, "done", "A draft for this invoice already existed (an earlier attempt succeeded), so nothing new was created."));
  } else {
    try {
      entry = await input.ledger.insert(proposed);
    } catch (err) {
      steps.push(step("create", "create_draft", createTitle, "failed", `Demo Books didn't accept the draft: ${(err as Error).message}`));
      attention.push({ kind: "check_failed", text: "Creating the draft failed. You can retry; Mimic checks first so it can't create it twice." });
      return result("failed", base);
    }
    steps.push(step("create", "create_draft", createTitle, "done", `Draft created in Demo Books.`));
  }

  // Verify by reading it back.
  const saved = await input.ledger.byId(entry.id);
  const mismatched = saved ? (["supplier", "invoiceNumber", "invoiceDate", "total", "currency", "category"] as const).filter((k) => String(saved[k]) !== String(proposed[k])) : ["everything"];
  if (mismatched.length && !alreadyDone) {
    steps.push(step("verify", "verify", titleOf("verify"), "failed", saved ? `The saved draft differs in: ${mismatched.join(", ")}.` : "The draft couldn't be read back."));
    attention.push({ kind: "verify_failed", text: "The saved draft doesn't match what Mimic meant to save. Check it in Demo Books." });
    steps.push(step("log", "log", titleOf("log"), "done", "Recorded in Activity history."));
    return result("failed", { ...base, ledgerEntryId: entry.id, alreadyDone });
  }
  steps.push(step("verify", "verify", titleOf("verify"), "done", alreadyDone ? "The existing draft was found." : "Every field matches."));
  steps.push(step("log", "log", titleOf("log"), "done", "Recorded in Activity history."));
  return result("completed", { ...base, ledgerEntryId: entry.id, alreadyDone });
}

/** A memory ledger for tests and the practice desk's preview. */
export function memoryLedger(initial: LedgerEntry[] = [], opts: { failInsert?: boolean; corruptRead?: boolean } = {}): LedgerPort & { entries: LedgerEntry[] } {
  const entries = [...initial];
  return {
    entries,
    async list() {
      return entries;
    },
    async byKey(key) {
      return entries.find((e) => e.idempotencyKey === key) ?? null;
    },
    async insert(e) {
      if (opts.failInsert) throw new Error("connection lost");
      const dupe = entries.find((x) => x.idempotencyKey === e.idempotencyKey);
      if (dupe) return dupe;
      const row: LedgerEntry = { ...e, id: `l${entries.length + 1}`, status: "draft", createdAt: new Date().toISOString() };
      entries.push(row);
      return row;
    },
    async byId(id) {
      const e = entries.find((x) => x.id === id) ?? null;
      return e && opts.corruptRead ? { ...e, total: e.total + 1 } : e;
    },
  };
}
