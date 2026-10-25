import { appearsIn, extractInvoice, labelFor, normLabel, TOP_OF_DOCUMENT } from "./extract";
import { FIELDS, FIELD_LABEL, REQUIRED_FIELDS, type Category, type Demonstration, type DerivedRule, type Field, type Question, type Step, type WorkflowDefinition } from "./types";

/**
 * Turning one demonstration into a workflow. Mimic learns the procedure, not the clicks: which value went
 * into which field and which label it sat next to, whether the user checked for duplicates, which category
 * they chose, that they saved a draft and looked at the result. What one demonstration can't settle (a
 * value that isn't in the document, whether a category applies to every invoice from the supplier) becomes
 * a question, not an assumption.
 */

export class DemonstrationError extends Error {}

const stepDefs = (): Record<Step["kind"], Omit<Step, "enabled" | "origin">> => ({
  receive_document: { id: "receive", kind: "receive_document", title: "Receive the invoice", detail: "Take the invoice from Mimic's inbox.", requiresApproval: false, required: true },
  extract: { id: "extract", kind: "extract", title: "Read the invoice details", detail: "Supplier, invoice number, dates, net, tax, total and currency, each with the line it came from.", requiresApproval: false, required: true },
  check_duplicates: { id: "duplicates", kind: "check_duplicates", title: "Check for duplicates", detail: "Look in Demo Books for the same supplier and invoice number, or the same supplier, total and date.", requiresApproval: false, required: true },
  validate: { id: "validate", kind: "validate", title: "Validate the details", detail: "Required fields present, net + tax = total, dates in order, currency as expected.", requiresApproval: false, required: true },
  categorise: { id: "categorise", kind: "categorise", title: "Choose the expense category", detail: "Use an approved rule for this supplier; with no rule, ask you.", requiresApproval: false, required: true },
  create_draft: { id: "create", kind: "create_draft", title: "Create a draft in Demo Books", detail: "A draft transaction, never a posted one. Skipped when the same invoice is already there.", requiresApproval: true, required: false },
  verify: { id: "verify", kind: "verify", title: "Verify the saved draft", detail: "Read the draft back and compare every field with what was meant to be saved.", requiresApproval: false, required: true },
  log: { id: "log", kind: "log", title: "Record what happened", detail: "Add the run to Activity history with every step's result.", requiresApproval: false, required: true },
});

export interface Learned {
  name: string;
  definition: WorkflowDefinition;
  questions: Question[];
  /** What the demonstration showed, in plain words, for the review screen. */
  observed: string[];
}

/** `docText` is the practice invoice the user worked on. */
export function learnFromDemonstration(demo: Demonstration, docText: string): Learned {
  const events = demo.events;
  if (!events.some((e) => e.kind === "save_draft")) throw new DemonstrationError("The demonstration ended before a draft was saved, so Mimic can't tell what the result should be. Record it again and finish with Save draft.");

  // The last value given to each field wins (the user may have corrected themselves).
  const finalValue = new Map<Field, { value: string; label: string | null; how: "copy" | "type" }>();
  for (const e of events) {
    if (e.kind === "copy_from_document") finalValue.set(e.field, { value: e.value, label: normLabel(e.label) || null, how: "copy" });
    if (e.kind === "type_field") finalValue.set(e.field, { value: e.value, label: null, how: "type" });
  }
  const missingRequired = REQUIRED_FIELDS.filter((f) => !finalValue.get(f)?.value.trim());
  if (missingRequired.length) throw new DemonstrationError(`The demonstration saved a draft without ${missingRequired.map((f) => FIELD_LABEL[f].toLowerCase()).join(", ")}. Fill every required field so Mimic can learn where it comes from.`);

  const hints: Partial<Record<Field, string[]>> = {};
  const derived: Partial<Record<Field, DerivedRule>> = {};
  const questions: Question[] = [];
  const observed: string[] = [];

  for (const f of FIELDS) {
    const v = finalValue.get(f);
    if (!v || !v.value.trim()) continue;
    // A typed value that is in the document counts as read from it; find the label it sits next to.
    const label = v.label ?? (appearsIn(docText, f, v.value) ? labelFor(docText, v.value) : null);
    if (label) {
      hints[f] = [label];
      observed.push(`${FIELD_LABEL[f]}: read next to "${label}".`);
      continue;
    }
    if (f === "supplier" && docText.split(/\r?\n/).find((l) => l.trim())?.trim().toLowerCase() === v.value.trim().toLowerCase()) {
      hints.supplier = [TOP_OF_DOCUMENT];
      observed.push("Supplier: taken from the letterhead at the top of the invoice.");
      continue;
    }
    if (appearsIn(docText, f, v.value)) {
      observed.push(`${FIELD_LABEL[f]}: found in the document without a label; Mimic will use its general labels.`);
      continue;
    }
    // Not in the document: ask how to work it out next time.
    if (f === "dueDate") {
      const invoice = finalValue.get("invoiceDate");
      const inv = invoice ? extractInvoice(`Invoice date: ${invoice.value}`).invoiceDate.value : null;
      const due = extractInvoice(`Due date: ${v.value}`).dueDate.value;
      if (typeof inv === "string" && typeof due === "string") {
        const days = Math.round((Date.parse(due) - Date.parse(inv)) / 86_400_000);
        if (days >= 0 && days <= 180) {
          derived.dueDate = { kind: "days_after", from: "invoiceDate", days };
          questions.push({
            id: "due",
            text: `The due date you entered (${v.value}) isn't on the invoice. It's ${days} days after the invoice date. How should Mimic set it?`,
            options: [
              { id: "days", label: `Invoice date + ${days} days, when the invoice has no due date` },
              { id: "ask", label: "Ask me each time" },
            ],
            answer: null,
            about: { kind: "derived", field: "dueDate", days },
          });
          observed.push(`Due date: not on the invoice; you entered ${days} days after the invoice date.`);
          continue;
        }
      }
    }
    derived[f] = { kind: "ask" };
    questions.push({
      id: `value-${f}`,
      text: `You typed "${v.value}" for ${FIELD_LABEL[f].toLowerCase()}, but it isn't in the invoice. Where does it come from?`,
      options: [
        { id: "constant", label: `Always use "${v.value}"` },
        { id: "ask", label: "Ask me each time" },
      ],
      answer: null,
      about: { kind: "derived", field: f, value: v.value },
    });
    observed.push(`${FIELD_LABEL[f]}: typed by you, not found in the invoice.`);
  }

  const supplier = finalValue.get("supplier")!.value.trim();
  const chosen = [...events].reverse().find((e) => e.kind === "choose_category");
  if (chosen && chosen.kind === "choose_category") {
    questions.push({
      id: "category",
      text: `You chose "${chosen.category}" for ${supplier}. Should Mimic use it for every invoice from ${supplier}?`,
      options: [
        { id: "always", label: `Yes, always for ${supplier}` },
        { id: "ask", label: "No, ask me each time" },
      ],
      answer: null,
      about: { kind: "category_rule", supplier, category: chosen.category as Category },
    });
    observed.push(`Category: you chose ${chosen.category}.`);
  }

  const did = (k: string) => events.some((e) => e.kind === k);
  const defs = stepDefs();
  const steps: Step[] = (Object.keys(defs) as Step["kind"][]).map((k) => {
    const d = defs[k];
    const learned = k === "receive_document" || k === "extract" || k === "create_draft" || k === "log" || (k === "check_duplicates" && did("check_duplicates")) || (k === "categorise" && !!chosen) || (k === "verify" && did("verify_saved"));
    return { ...d, enabled: true, origin: learned ? "learned" : "added" };
  });
  if (!did("check_duplicates")) observed.push("You didn't check for duplicates; Mimic will, every time.");
  else observed.push("You checked Demo Books for duplicates before saving.");
  if (!did("verify_saved")) observed.push("You didn't open the saved draft; Mimic will read it back to verify.");

  const currency = finalValue.get("currency")!.value.trim().toUpperCase();
  const seconds = Math.round((Date.parse(demo.endedAt) - Date.parse(demo.startedAt)) / 1000);

  return {
    name: "Process supplier invoices",
    observed,
    questions,
    definition: {
      version: 1,
      objective: "Turn a supplier invoice into a checked draft transaction in Demo Books, asking when anything is uncertain.",
      trigger: "manual",
      steps,
      hints,
      derived,
      autoLimit: 1000,
      currencies: [currency],
      demoSeconds: Number.isFinite(seconds) && seconds > 0 && seconds < 3600 ? seconds : null,
    },
  };
}

/** Apply the user's answer to a question. Returns the changed definition and, for a category rule, the rule to save. */
export function answerQuestion(def: WorkflowDefinition, q: Question, answer: string): { definition: WorkflowDefinition; rule: { supplier: string; category: Category } | null } {
  const next = structuredClone(def);
  if (q.about.kind === "derived") {
    if (q.about.days !== undefined) next.derived[q.about.field] = answer === "days" ? { kind: "days_after", from: "invoiceDate", days: q.about.days } : { kind: "ask" };
    else next.derived[q.about.field] = answer === "constant" && q.about.value ? { kind: "constant", value: q.about.value } : { kind: "ask" };
    return { definition: next, rule: null };
  }
  if (q.about.kind === "category_rule" && answer === "always") return { definition: next, rule: { supplier: q.about.supplier, category: q.about.category } };
  return { definition: next, rule: null };
}
