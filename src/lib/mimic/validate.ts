import { normSupplier } from "./extract";
import { REQUIRED_FIELDS, FIELD_LABEL, type Check, type Extraction, type LedgerEntry } from "./types";

/** The key that makes an invoice's draft unique: the same supplier and invoice number is the same invoice, whichever workflow sees it. */
export function invoiceKey(supplier: string, invoiceNumber: string): string {
  return `${normSupplier(supplier)}|${invoiceNumber.toLowerCase().replace(/\s+/g, "")}`;
}

export interface DuplicateResult {
  confirmed: LedgerEntry[];
  probable: LedgerEntry[];
}

/** Confirmed: same supplier and invoice number. Probable: same supplier, total and invoice date under another number. */
export function findDuplicates(x: Extraction, ledger: LedgerEntry[]): DuplicateResult {
  const supplier = typeof x.supplier.value === "string" ? normSupplier(x.supplier.value) : null;
  if (!supplier) return { confirmed: [], probable: [] };
  const key = typeof x.invoiceNumber.value === "string" ? invoiceKey(x.supplier.value as string, x.invoiceNumber.value) : null;
  const same = ledger.filter((e) => normSupplier(e.supplier) === supplier);
  const confirmed = key ? same.filter((e) => e.idempotencyKey === key) : [];
  const probable = same.filter((e) => !confirmed.includes(e) && e.total === x.total.value && e.invoiceDate === x.invoiceDate.value);
  return { confirmed, probable };
}

const cents = (n: number) => Math.round(n * 100);

/**
 * The checks every invoice passes before Mimic prepares a draft. "fail" stops the run and asks the user;
 * "warn" lets supervised runs continue (the user sees it before approving) but stops automatic ones.
 */
export function validateInvoice(x: Extraction, opts: { currencies: string[]; today: string }): Check[] {
  const checks: Check[] = [];
  const missing = REQUIRED_FIELDS.filter((f) => x[f].value === null);
  checks.push(
    missing.length
      ? { id: "required", label: "Required details", status: "fail", detail: `Missing: ${missing.map((f) => FIELD_LABEL[f]).join(", ")}.` }
      : { id: "required", label: "Required details", status: "pass", detail: "Supplier, invoice number, date, total and currency were all found." },
  );

  const { net, tax, total } = { net: x.net.value as number | null, tax: x.tax.value as number | null, total: x.total.value as number | null };
  if (total !== null && total <= 0) checks.push({ id: "total_positive", label: "Total", status: "fail", detail: `The total is ${total}. Credit notes and zero invoices aren't supported yet.` });
  if (net !== null && tax !== null && total !== null) {
    const ok = Math.abs(cents(net) + cents(tax) - cents(total)) <= 1;
    checks.push(
      ok
        ? { id: "arithmetic", label: "Net + tax = total", status: "pass", detail: `${net.toFixed(2)} + ${tax.toFixed(2)} = ${total.toFixed(2)}` }
        : { id: "arithmetic", label: "Net + tax = total", status: "fail", detail: `${net.toFixed(2)} + ${tax.toFixed(2)} = ${(net + tax).toFixed(2)}, but the total reads ${total.toFixed(2)}. One of the amounts was probably read wrongly.` },
    );
  } else if (total !== null) checks.push({ id: "arithmetic", label: "Net + tax = total", status: "warn", detail: "The net amount or tax wasn't found, so the total couldn't be cross-checked." });

  const inv = x.invoiceDate.value as string | null;
  const due = x.dueDate.value as string | null;
  if (inv && inv > opts.today) checks.push({ id: "date_future", label: "Invoice date", status: "warn", detail: `The invoice is dated ${inv}, which is in the future.` });
  if (inv && due && due < inv) checks.push({ id: "due_order", label: "Due date", status: "fail", detail: `The due date (${due}) is before the invoice date (${inv}).` });
  const unsure = (["invoiceDate", "dueDate", "supplier", "currency"] as const).filter((f) => x[f].value !== null && x[f].confidence === "low");
  if (unsure.length) checks.push({ id: "confidence", label: "Reading confidence", status: "warn", detail: unsure.map((f) => `${FIELD_LABEL[f]}: ${x[f].note ?? "read without a clear label"}`).join(" ") });

  const cur = x.currency.value as string | null;
  if (cur && opts.currencies.length && !opts.currencies.includes(cur))
    checks.push({ id: "currency", label: "Currency", status: "fail", detail: `This invoice is in ${cur}; this workflow expects ${opts.currencies.join(" or ")}. Mimic won't convert currencies.` });
  else if (cur) checks.push({ id: "currency", label: "Currency", status: "pass", detail: `${cur}, as expected.` });
  else if (x.currency.note) checks.push({ id: "currency", label: "Currency", status: "fail", detail: x.currency.note });
  return checks;
}
