import { z } from "zod";

/**
 * Mimic: learns a task from one demonstration and repeats it. The first supported task is supplier-invoice
 * processing in Demo Books, Mimic's built-in practice ledger (clearly a demonstration environment, not a real
 * accounting system). A demonstration is recorded as structured events (which field was filled from which
 * part of the document), never as screen coordinates, so the learned workflow survives a different layout.
 */

export const FIELDS = ["supplier", "invoiceNumber", "invoiceDate", "dueDate", "net", "tax", "total", "currency"] as const;
export type Field = (typeof FIELDS)[number];

export const FIELD_LABEL: Record<Field, string> = {
  supplier: "Supplier",
  invoiceNumber: "Invoice number",
  invoiceDate: "Invoice date",
  dueDate: "Due date",
  net: "Net amount",
  tax: "Tax",
  total: "Total",
  currency: "Currency",
};

export const AMOUNT_FIELDS = ["net", "tax", "total"] as const satisfies readonly Field[];
export const DATE_FIELDS = ["invoiceDate", "dueDate"] as const satisfies readonly Field[];
/** Without these a draft entry can't be created. */
export const REQUIRED_FIELDS = ["supplier", "invoiceNumber", "invoiceDate", "total", "currency"] as const satisfies readonly Field[];

/** Demo Books' chart of accounts. */
export const CATEGORIES = [
  "6000 Office supplies",
  "6100 Software and subscriptions",
  "6200 Professional services",
  "6300 Rent and utilities",
  "6400 Travel",
  "6500 Meals and entertainment",
  "6600 Marketing",
  "6700 Equipment",
  "6800 Shipping and postage",
  "6900 Other expenses",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const CURRENCIES = ["CHF", "EUR", "USD", "GBP", "SEK", "NOK", "DKK", "PLN", "CAD", "AUD", "JPY"] as const;

const field = z.enum(FIELDS);
const at = z.string().max(40);
const short = (n: number) => z.string().max(n);

/** One recorded action in Teach mode. Values come from the practice desk; never from the screen. */
export const demoEvent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("open_document"), docId: short(64), at }),
  /** A value the user took from the document: `label` is the text before it on the same line ("Invoice no:"). */
  z.object({ kind: z.literal("copy_from_document"), field, value: short(200), label: short(80), at }),
  z.object({ kind: z.literal("type_field"), field, value: short(200), at }),
  z.object({ kind: z.literal("choose_category"), category: z.enum(CATEGORIES), at }),
  z.object({ kind: z.literal("check_duplicates"), found: z.number().int().min(0).max(1000), at }),
  z.object({ kind: z.literal("save_draft"), at }),
  z.object({ kind: z.literal("verify_saved"), at }),
]);
export type DemoEvent = z.infer<typeof demoEvent>;

export const demonstration = z.object({
  docId: short(64),
  startedAt: at,
  endedAt: at,
  events: z.array(demoEvent).min(1).max(300),
});
export type Demonstration = z.infer<typeof demonstration>;

export const STEP_KINDS = ["receive_document", "extract", "check_duplicates", "validate", "categorise", "create_draft", "verify", "log"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export interface Step {
  id: string;
  kind: StepKind;
  title: string;
  detail: string;
  enabled: boolean;
  /** Waits for the user's approval before it runs (supervised mode, or always for the user's chosen steps). */
  requiresApproval: boolean;
  /** "learned": seen in the demonstration; "added": Mimic added it as a safeguard (the user can turn it off unless it's required). */
  origin: "learned" | "added";
  /** Steps that can't be turned off: the safety checks and the record. */
  required: boolean;
}

export type Mode = "assist" | "supervised" | "automatic";
export const MODES: Mode[] = ["assist", "supervised", "automatic"];
export const MODE_LABEL: Record<Mode, string> = { assist: "Assist", supervised: "Supervised", automatic: "Automatic" };
export const MODE_HINT: Record<Mode, string> = {
  assist: "Mimic prepares the entry and explains it; you create it yourself with one click.",
  supervised: "Mimic does the safe steps and asks you before it creates anything.",
  automatic: "Mimic creates drafts on its own when every check passes and the total is under your limit; anything else comes to you.",
};

export type TriggerKind = "manual" | "document_added";
export const TRIGGER_LABEL: Record<TriggerKind, string> = { manual: "When I start it", document_added: "When I add an invoice to Mimic's inbox" };

/** How a value the user typed (not found in the document) is worked out next time. */
export type DerivedRule = { kind: "days_after"; from: "invoiceDate"; days: number } | { kind: "constant"; value: string } | { kind: "ask" };

export interface WorkflowDefinition {
  version: 1;
  objective: string;
  trigger: TriggerKind;
  steps: Step[];
  /** Per field, the labels the user read values next to. Tried before Mimic's generic labels. */
  hints: Partial<Record<Field, string[]>>;
  derived: Partial<Record<Field, DerivedRule>>;
  /** Automatic mode creates a draft only at or under this total, in an expected currency. */
  autoLimit: number;
  currencies: string[];
  /** Seconds the demonstration took, the basis of the time-saved estimate. */
  demoSeconds: number | null;
}

export interface Question {
  id: string;
  text: string;
  options: { id: string; label: string }[];
  answer: string | null;
  /** What the answer changes. */
  about: { kind: "category_rule"; supplier: string; category: Category } | { kind: "derived"; field: Field; days?: number; value?: string } | { kind: "missing_field"; field: Field };
}

export type WorkflowStatus = "draft" | "tested" | "active" | "paused";

export interface ExtractedField {
  value: string | number | null;
  raw: string | null;
  /** The document line the value was read from. */
  evidence: string | null;
  source: "learned_label" | "label" | "layout" | "derived" | "ai" | "missing";
  confidence: "high" | "medium" | "low";
  note?: string;
}
export type Extraction = Record<Field, ExtractedField>;

export interface Check {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

export interface Rule {
  id: string;
  kind: "supplier_category";
  supplier: string;
  category: Category;
  status: "active" | "removed";
  history: { at: string; action: string; detail: string }[];
}

export interface LedgerEntry {
  id: string;
  supplier: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string | null;
  net: number | null;
  tax: number | null;
  total: number;
  currency: string;
  category: Category;
  status: "draft";
  idempotencyKey: string;
  documentId: string | null;
  runId: string | null;
  createdAt: string;
}

export type NewLedgerEntry = Omit<LedgerEntry, "id" | "createdAt" | "status">;

export type RunStatus = "completed" | "dry_run" | "proposal" | "needs_approval" | "needs_attention" | "failed" | "stopped";

export interface StepResult {
  stepId: string;
  kind: StepKind;
  title: string;
  status: "done" | "skipped" | "waiting" | "blocked" | "failed" | "would_do";
  detail: string;
}

export interface Attention {
  kind: "approval" | "category" | "missing" | "duplicate" | "check_failed" | "low_confidence" | "suspicious_content" | "over_limit" | "verify_failed";
  text: string;
}

export interface RunResult {
  status: RunStatus;
  steps: StepResult[];
  extracted: Extraction | null;
  checks: Check[];
  category: { value: Category; source: "rule" | "question" | "correction" } | null;
  proposed: NewLedgerEntry | null;
  attention: Attention[];
  ledgerEntryId: string | null;
  /** True when a draft with this invoice's key already existed, so nothing new was written. */
  alreadyDone: boolean;
  warnings: string[];
}
