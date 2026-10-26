"use client";
import { useRef, useState } from "react";
import { Check, Circle, FileText, Loader2, MousePointerClick, Search, Square, Trash2 } from "lucide-react";
import { jsonFetch } from "@/hooks/use-ndjson";
import { normSupplier } from "@/lib/mimic/extract";
import type { SampleInvoice } from "@/lib/mimic/samples";
import type { Overview, WorkflowView } from "@/lib/mimic/server";
import { CATEGORIES, FIELDS, FIELD_LABEL, REQUIRED_FIELDS, type Category, type DemoEvent, type Field } from "@/lib/mimic/types";
import { cn } from "@/lib/utils";

type Phase = "setup" | "recording" | "review";
const empty = () => Object.fromEntries(FIELDS.map((f) => [f, ""])) as Record<Field, string>;
const stamp = () => new Date().toISOString();

/** What an event looks like in plain words, for the live list and the review. */
export function describeEvent(e: DemoEvent): string {
  switch (e.kind) {
    case "open_document":
      return "Opened the invoice";
    case "copy_from_document":
      return `${FIELD_LABEL[e.field]} ← "${e.value}"${e.label ? ` (next to "${e.label}")` : ""}`;
    case "type_field":
      return `Typed ${FIELD_LABEL[e.field].toLowerCase()}: "${e.value}"`;
    case "choose_category":
      return `Chose category ${e.category}`;
    case "check_duplicates":
      return `Searched Demo Books for duplicates (${e.found} found)`;
    case "save_draft":
      return "Saved the draft";
    case "verify_saved":
      return "Opened the saved draft to check it";
  }
}

/**
 * The practice desk: an invoice on the left, Demo Books' "new bill" form on the right. While recording, Mimic
 * notes which text went into which field and what it sat next to, never mouse positions or anything outside
 * this desk. Select text in the invoice and pick the field it belongs in, or type into the form.
 */
export function TeachMimic({ samples, ledger, onCreated }: { samples: SampleInvoice[]; ledger: Overview["ledger"]; onCreated: (w: WorkflowView) => void }) {
  // Teach with an ordinary invoice; the duplicate and the one carrying instructions are for testing.
  const teachable = samples.filter((s) => !/resent/i.test(s.name) && !/instructions/i.test(s.shows));
  const [docId, setDocId] = useState(teachable[0]!.id);
  const doc = samples.find((s) => s.id === docId)!;
  const lines = doc.text.split("\n");
  const [phase, setPhase] = useState<Phase>("setup");
  const [events, setEvents] = useState<DemoEvent[]>([]);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [endedAt, setEndedAt] = useState<string | null>(null);
  const [form, setForm] = useState(empty);
  const [category, setCategory] = useState<Category | "">("");
  const [selection, setSelection] = useState<{ text: string; label: string } | null>(null);
  const [dupResult, setDupResult] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copied = useRef<Partial<Record<Field, string>>>({});
  const docRef = useRef<HTMLDivElement>(null);
  const recording = phase === "recording";

  const record = (e: DemoEvent) => setEvents((xs) => (xs.length < 290 ? [...xs, e] : xs));

  const start = () => {
    setEvents([{ kind: "open_document", docId, at: stamp() }]);
    setStartedAt(stamp());
    setEndedAt(null);
    setForm(empty());
    setCategory("");
    setSaved(false);
    setChecked(false);
    setDupResult(null);
    setError(null);
    copied.current = {};
    setPhase("recording");
  };

  const onMouseUp = () => {
    if (!recording) return;
    const sel = window.getSelection();
    const text = sel?.toString().replace(/\s+/g, " ").trim() ?? "";
    if (!sel || !text || text.length > 200) return setSelection(null);
    const node = sel.anchorNode;
    const el = (node?.nodeType === 3 ? node.parentElement : (node as Element | null))?.closest<HTMLElement>("[data-line]");
    if (!el || !docRef.current?.contains(el)) return setSelection(null);
    const line = lines[Number(el.dataset.line)] ?? "";
    const at = line.indexOf(text);
    setSelection({ text, label: at > 0 ? line.slice(0, at).trim().slice(0, 80) : "" });
  };

  const put = (f: Field) => {
    if (!selection) return;
    setForm((v) => ({ ...v, [f]: selection.text }));
    copied.current[f] = selection.text;
    record({ kind: "copy_from_document", field: f, value: selection.text, label: selection.label, at: stamp() });
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  };

  const typed = (f: Field) => {
    const v = form[f].trim();
    if (!recording || !v || v === copied.current[f]) return;
    copied.current[f] = v;
    record({ kind: "type_field", field: f, value: v.slice(0, 200), at: stamp() });
  };

  const searchDuplicates = () => {
    const found = ledger.filter((e) => normSupplier(e.supplier) === normSupplier(form.supplier) && e.invoiceNumber.toLowerCase() === form.invoiceNumber.trim().toLowerCase()).length;
    setDupResult(found ? `${found} matching draft${found === 1 ? "" : "s"} in Demo Books.` : "No matching draft in Demo Books.");
    if (recording) record({ kind: "check_duplicates", found, at: stamp() });
  };

  const save = () => {
    const missing = REQUIRED_FIELDS.filter((f) => !form[f].trim());
    if (missing.length) return setError(`Fill ${missing.map((f) => FIELD_LABEL[f].toLowerCase()).join(", ")} first.`);
    if (!category) return setError("Choose a category first.");
    setError(null);
    setSaved(true);
    record({ kind: "save_draft", at: stamp() });
  };

  const stop = () => {
    setEndedAt(stamp());
    setPhase("review");
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await jsonFetch<{ workflow: WorkflowView }>("/api/mimic/workflows", { method: "POST", body: JSON.stringify({ demonstration: { docId, startedAt, endedAt: endedAt ?? stamp(), events } }) });
      onCreated(r.workflow);
      setPhase("setup");
      setEvents([]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (phase === "review")
    return (
      <section className="glass rounded-[22px] p-6" aria-labelledby="teach-review">
        <h2 id="teach-review" className="text-[18px] font-semibold">
          Here&apos;s what Mimic saw
        </h2>
        <p className="mt-1 text-[14px] text-s-ink-2">
          {events.length} actions on &ldquo;{doc.name}&rdquo;. Mimic will turn them into steps you can review, test and edit before anything runs.
        </p>
        <ol className="mt-4 space-y-1.5 text-[13.5px]">
          {events.map((e, i) => (
            <li key={i} className="flex gap-2">
              <span className="w-6 shrink-0 text-right tabular-nums text-s-ink-3">{i + 1}.</span>
              <span>{describeEvent(e)}</span>
            </li>
          ))}
        </ol>
        {!events.some((e) => e.kind === "save_draft") && <p className="mt-3 text-[13.5px] text-amber-700 dark:text-amber-300">You didn&apos;t save a draft, so Mimic can&apos;t tell what the result should be. Record again and finish with Save draft.</p>}
        {error && (
          <p role="alert" className="mt-3 text-[13.5px] text-s-danger">
            {error}
          </p>
        )}
        <div className="mt-5 flex flex-wrap gap-2">
          <button type="button" onClick={create} disabled={busy || !events.some((e) => e.kind === "save_draft")} className="inline-flex h-10 items-center gap-2 rounded-xl bg-s-accent px-4 text-[14px] font-medium text-s-accent-ink disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Create the automation
          </button>
          <button type="button" onClick={start} className="inline-flex h-10 items-center gap-2 rounded-xl border border-s-line-strong px-4 text-[14px] hover:bg-s-hover">
            Record again
          </button>
          <button type="button" onClick={() => setPhase("setup")} className="inline-flex h-10 items-center gap-2 rounded-xl px-3 text-[14px] text-s-ink-2 hover:bg-s-hover">
            <Trash2 className="h-4 w-4" /> Discard
          </button>
        </div>
      </section>
    );

  return (
    <div className="space-y-4">
      {phase === "setup" ? (
        <section className="glass rounded-[22px] p-6" aria-labelledby="teach-start">
          <h2 id="teach-start" className="text-[18px] font-semibold">
            Show Mimic how you process a supplier invoice
          </h2>
          <ol className="mt-3 grid gap-2 text-[14px] text-s-ink-2 sm:grid-cols-2">
            <li>1. Pick an invoice below.</li>
            <li>2. Press Teach Mimic. Recording starts.</li>
            <li>3. Do the task: select text in the invoice and put it in the right field, check for duplicates, choose a category, save the draft.</li>
            <li>4. Stop, review what Mimic saw, and create the automation.</li>
          </ol>
          <p className="mt-3 text-[12.5px] text-s-ink-3">
            Mimic only sees this practice desk: the invoice and the Demo Books form. It records which text went into which field, not your screen or mouse. The invoices are fictional samples; Demo Books is
            Mimic&apos;s built-in practice ledger.
          </p>
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <label className="text-[13px] text-s-ink-2">
              Invoice to teach with
              <select value={docId} onChange={(e) => setDocId(e.target.value)} className="mt-1 block h-10 rounded-xl border border-s-line-strong bg-transparent px-3 text-[14px] text-s-ink">
                {teachable.map((s) => (
                  <option key={s.id} value={s.id}>
                    Sample: {s.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" onClick={start} className="inline-flex h-10 items-center gap-2 rounded-xl bg-s-accent px-5 text-[14px] font-semibold uppercase tracking-[0.04em] text-s-accent-ink shadow-[0_8px_24px_-12px_var(--s-accent)]">
              <MousePointerClick className="h-4 w-4" /> Teach Mimic
            </button>
          </div>
        </section>
      ) : (
        <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-rose-500/40 bg-rose-500/8 px-4 py-3">
          <span className="flex items-center gap-2 text-[14px] font-medium">
            <Circle className="h-3 w-3 animate-pulse fill-rose-500 text-rose-500" aria-hidden /> Recording — Mimic is watching this practice desk only
          </span>
          <span className="flex gap-2">
            <button type="button" onClick={stop} className="inline-flex h-9 items-center gap-2 rounded-xl bg-s-ink px-4 text-[13.5px] font-medium text-s-bg">
              <Square className="h-3.5 w-3.5" /> Stop and review
            </button>
            <button type="button" onClick={() => setPhase("setup")} className="inline-flex h-9 items-center rounded-xl border border-s-line-strong px-3 text-[13.5px] hover:bg-s-hover">
              Cancel
            </button>
          </span>
        </div>
      )}

      <div className={cn("grid gap-4 lg:grid-cols-[1.05fr_1fr]", !recording && "opacity-60")}>
        <section className="glass rounded-[22px] p-5" aria-label="The invoice">
          <div className="flex items-center gap-2 text-[13px] text-s-ink-2">
            <FileText className="h-4 w-4" /> Sample: {doc.name}
          </div>
          <div ref={docRef} onMouseUp={onMouseUp} onKeyUp={onMouseUp} tabIndex={0} aria-label="Invoice text: select a value with the mouse or Shift and the arrow keys" className="mt-3 overflow-x-auto rounded-xl border border-s-line bg-s-bg/60 p-4 font-mono text-[12.5px] leading-[1.7] select-text">
            {lines.map((l, i) => (
              <div key={i} data-line={i} className="whitespace-pre">
                {l || " "}
              </div>
            ))}
          </div>
          {recording && (
            <div className="mt-3 min-h-[44px]" aria-live="polite">
              {selection ? (
                <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
                  <span className="mr-1 text-s-ink-2">
                    Put &ldquo;<span className="font-medium text-s-ink">{selection.text.slice(0, 40)}</span>&rdquo; into:
                  </span>
                  {FIELDS.map((f) => (
                    <button key={f} type="button" onClick={() => put(f)} className="rounded-full border border-s-line-strong px-2.5 py-1 text-[12.5px] hover:bg-s-hover">
                      {FIELD_LABEL[f]}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-[12.5px] text-s-ink-3">Select a value in the invoice (drag across it), then choose the field it belongs in. You can also type into the form.</p>
              )}
            </div>
          )}
        </section>

        <section className="glass rounded-[22px] p-5" aria-label="Demo Books: new bill">
          <div className="flex items-center justify-between">
            <h3 className="text-[15px] font-semibold">Demo Books · New bill</h3>
            <span className="rounded-full bg-s-hover px-2 py-0.5 text-[11.5px] text-s-ink-2">Practice ledger</span>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {FIELDS.map((f) => (
              <label key={f} className="text-[12.5px] text-s-ink-2">
                {FIELD_LABEL[f]}
                {(REQUIRED_FIELDS as readonly string[]).includes(f) ? " *" : ""}
                <input
                  value={form[f]}
                  disabled={!recording || saved}
                  onChange={(e) => setForm((v) => ({ ...v, [f]: e.target.value }))}
                  onBlur={() => typed(f)}
                  className="mt-1 block h-9 w-full rounded-xl border border-s-line-strong bg-transparent px-3 text-[13.5px] text-s-ink outline-none focus:border-s-accent disabled:opacity-60"
                />
              </label>
            ))}
            <label className="text-[12.5px] text-s-ink-2 sm:col-span-2">
              Category *
              <select
                value={category}
                disabled={!recording || saved}
                onChange={(e) => {
                  setCategory(e.target.value as Category);
                  if (e.target.value) record({ kind: "choose_category", category: e.target.value as Category, at: stamp() });
                }}
                className="mt-1 block h-9 w-full rounded-xl border border-s-line-strong bg-transparent px-2 text-[13.5px] text-s-ink disabled:opacity-60"
              >
                <option value="">Choose…</option>
                {CATEGORIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button type="button" onClick={searchDuplicates} disabled={!recording || saved || !form.supplier} className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-s-line-strong px-3 text-[13px] hover:bg-s-hover disabled:opacity-50">
              <Search className="h-3.5 w-3.5" /> Search for duplicates
            </button>
            <button type="button" onClick={save} disabled={!recording || saved} className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-s-accent px-4 text-[13px] font-medium text-s-accent-ink disabled:opacity-50">
              <Check className="h-3.5 w-3.5" /> Save draft
            </button>
            {saved && (
              <button
                type="button"
                onClick={() => {
                  setChecked(true);
                  record({ kind: "verify_saved", at: stamp() });
                }}
                disabled={checked}
                className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-s-line-strong px-3 text-[13px] hover:bg-s-hover disabled:opacity-50"
              >
                Open the saved draft
              </button>
            )}
          </div>
          {dupResult && <p className="mt-2 text-[12.5px] text-s-ink-2">{dupResult}</p>}
          {saved && <p className="mt-2 text-[12.5px] text-s-ink-2">Saved in practice. Nothing is written to Demo Books while you teach; Mimic writes only when the automation runs.</p>}
          {checked && (
            <dl className="mt-2 grid grid-cols-2 gap-x-3 rounded-xl border border-s-line p-3 text-[12.5px]">
              {FIELDS.filter((f) => form[f]).map((f) => (
                <div key={f} className="contents">
                  <dt className="text-s-ink-3">{FIELD_LABEL[f]}</dt>
                  <dd>{form[f]}</dd>
                </div>
              ))}
              <dt className="text-s-ink-3">Category</dt>
              <dd>{category}</dd>
            </dl>
          )}
          {error && (
            <p role="alert" className="mt-2 text-[13px] text-s-danger">
              {error}
            </p>
          )}
        </section>
      </div>

      {recording && events.length > 0 && (
        <section className="s-card rounded-[22px] p-4" aria-label="What Mimic has seen so far">
          <h3 className="text-[12px] font-medium uppercase tracking-[0.08em] text-s-ink-3">What Mimic has seen</h3>
          <ol className="mt-2 space-y-1 text-[13px]">
            {events.slice(-8).map((e, i) => (
              <li key={i}>{describeEvent(e)}</li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
