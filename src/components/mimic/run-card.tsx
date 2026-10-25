"use client";
import { useState } from "react";
import { AlertTriangle, Ban, Check, CircleDashed, Clock, Eye, Loader2, X } from "lucide-react";
import { jsonFetch } from "@/hooks/use-ndjson";
import type { RunView } from "@/lib/mimic/server";
import { CATEGORIES, FIELDS, FIELD_LABEL, type Category, type Field, type StepResult } from "@/lib/mimic/types";
import { cn } from "@/lib/utils";

export const RUN_STATUS: Record<RunView["status"], { label: string; tone: string }> = {
  running: { label: "Running", tone: "bg-s-hover text-s-ink-2" },
  completed: { label: "Done", tone: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300" },
  dry_run: { label: "Test run", tone: "bg-sky-500/12 text-sky-700 dark:text-sky-300" },
  proposal: { label: "Prepared for you", tone: "bg-violet-500/12 text-violet-700 dark:text-violet-300" },
  needs_approval: { label: "Needs your approval", tone: "bg-amber-500/15 text-amber-800 dark:text-amber-300" },
  needs_attention: { label: "Needs your attention", tone: "bg-amber-500/15 text-amber-800 dark:text-amber-300" },
  failed: { label: "Failed", tone: "bg-rose-500/12 text-rose-700 dark:text-rose-300" },
  stopped: { label: "Stopped", tone: "bg-rose-500/12 text-rose-700 dark:text-rose-300" },
  rejected: { label: "Rejected by you", tone: "bg-s-hover text-s-ink-2" },
};

const STEP_ICON: Record<StepResult["status"], React.ReactNode> = {
  done: <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />,
  would_do: <Eye className="h-3.5 w-3.5 text-sky-600 dark:text-sky-400" />,
  waiting: <Clock className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />,
  blocked: <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />,
  failed: <X className="h-3.5 w-3.5 text-rose-600 dark:text-rose-400" />,
  skipped: <CircleDashed className="h-3.5 w-3.5 text-s-ink-3" />,
};

const SOURCE_LABEL = { learned_label: "as you showed", label: "by label", layout: "by position", derived: "worked out", ai: "AI, checked", missing: "not found" } as const;

export const fmtTime = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

const fmtValue = (f: Field, v: string | number | null) => (v === null ? "—" : typeof v === "number" ? v.toFixed(2) : f === "invoiceDate" || f === "dueDate" ? new Date(`${v}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : v);

export function StatusPill({ status }: { status: RunView["status"] }) {
  const s = RUN_STATUS[status];
  return <span className={cn("inline-flex items-center rounded-full px-2.5 py-0.5 text-[12px] font-medium", s.tone)}>{s.label}</span>;
}

/** One run: what Mimic did step by step, what it read (and from where), the checks, and, when it waits for you, the decision. */
export function RunCard({ run, workflowName, onChanged, defaultOpen = false }: { run: RunView; workflowName?: string; onChanged?: (r: RunView) => void; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const r = run.result;
  const decidable = ["needs_approval", "needs_attention", "proposal", "failed"].includes(run.status) && !run.dryRun;
  const title = r?.proposed ? `${r.proposed.supplier} · ${r.proposed.invoiceNumber}` : (run.documentName ?? "Invoice");
  return (
    <article className="glass rounded-[22px] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill status={run.status} />
            {run.dryRun && <span className="text-[12px] text-s-ink-3">Nothing was saved</span>}
          </div>
          <h3 className="mt-2 truncate text-[15.5px] font-semibold">{title}</h3>
          <p className="text-[12.5px] text-s-ink-3">
            {workflowName ? `${workflowName} · ` : ""}
            {fmtTime(run.createdAt)}
            {run.documentName ? ` · ${run.documentName}` : ""}
            {run.seconds !== null ? ` · ${run.seconds}s` : ""}
          </p>
        </div>
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="rounded-xl border border-s-line-strong px-3 py-1.5 text-[13px] hover:bg-s-hover">
          {open ? "Hide details" : "Details"}
        </button>
      </div>

      {r && r.attention.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {r.attention.map((a, i) => (
            <li key={i} className="flex gap-2 text-[13.5px]">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
              <span>{a.text}</span>
            </li>
          ))}
        </ul>
      )}
      {r?.warnings.map((w, i) => (
        <p key={i} className="mt-2 text-[12.5px] text-s-ink-2">
          {w}
        </p>
      ))}

      {open && r && (
        <div className="mt-4 grid gap-5 lg:grid-cols-2">
          <section aria-label="Steps">
            <h4 className="text-[12px] font-medium uppercase tracking-[0.08em] text-s-ink-3">Steps</h4>
            <ol className="mt-2 space-y-2">
              {r.steps.map((s, i) => (
                <li key={i} className="flex gap-2.5 text-[13.5px]">
                  <span className="mt-0.5" aria-label={s.status}>
                    {STEP_ICON[s.status]}
                  </span>
                  <span>
                    <span className="font-medium">{s.title}</span>
                    <span className="block text-[12.5px] text-s-ink-2">{s.detail}</span>
                  </span>
                </li>
              ))}
            </ol>
            {r.checks.length > 0 && (
              <>
                <h4 className="mt-4 text-[12px] font-medium uppercase tracking-[0.08em] text-s-ink-3">Checks</h4>
                <ul className="mt-2 space-y-1.5">
                  {r.checks.map((c) => (
                    <li key={c.id} className="flex gap-2 text-[13px]">
                      {c.status === "pass" ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" /> : c.status === "warn" ? <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" /> : <Ban className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-600" />}
                      <span>
                        <span className="font-medium">{c.label}:</span> {c.detail}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
          {r.extracted && (
            <section aria-label="What Mimic read">
              <h4 className="text-[12px] font-medium uppercase tracking-[0.08em] text-s-ink-3">What Mimic read</h4>
              <div className="mt-2 overflow-x-auto" tabIndex={0} aria-label="What Mimic read">
                <table className="w-full text-left text-[13px]">
                  <tbody>
                    {FIELDS.map((f) => {
                      const x = r.extracted![f];
                      return (
                        <tr key={f} className="border-b border-s-line last:border-0 align-top">
                          <th scope="row" className="py-1.5 pr-3 font-normal text-s-ink-2">
                            {FIELD_LABEL[f]}
                          </th>
                          <td className="py-1.5 pr-3 font-medium">{fmtValue(f, x.value)}</td>
                          <td className="py-1.5 text-[12px] text-s-ink-3">
                            {SOURCE_LABEL[x.source]}
                            {x.evidence ? <span className="block max-w-[260px] truncate font-mono text-[11.5px]" title={x.evidence}>{x.evidence}</span> : null}
                            {x.note ? <span className="block">{x.note}</span> : null}
                          </td>
                        </tr>
                      );
                    })}
                    <tr className="align-top">
                      <th scope="row" className="py-1.5 pr-3 font-normal text-s-ink-2">
                        Category
                      </th>
                      <td className="py-1.5 pr-3 font-medium">{r.category?.value ?? "—"}</td>
                      <td className="py-1.5 text-[12px] text-s-ink-3">{r.category ? { rule: "your rule", question: "your answer", correction: "chosen by you" }[r.category.source] : "no rule yet"}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      )}

      {decidable && r && <Decision run={run} onChanged={onChanged} />}
    </article>
  );
}

function Decision({ run, onChanged }: { run: RunView; onChanged?: (r: RunView) => void }) {
  const r = run.result!;
  const needsCategory = r.attention.some((a) => a.kind === "category");
  const probable = r.attention.some((a) => a.kind === "duplicate" && /may duplicate/.test(a.text));
  const confirmedDup = r.attention.some((a) => a.kind === "duplicate" && !/may duplicate/.test(a.text));
  const failed = new Set(r.checks.filter((c) => c.status === "fail").map((c) => c.id));
  // Offer to correct what's missing, and the fields behind a failed check.
  const fixable: Field[] = r.extracted
    ? FIELDS.filter((f) => r.extracted![f].value === null || (failed.has("arithmetic") && ["net", "tax", "total"].includes(f)) || (failed.has("due_order") && ["invoiceDate", "dueDate"].includes(f)))
    : [];
  const [values, setValues] = useState<Partial<Record<Field, string>>>({});
  const [category, setCategory] = useState<Category | "">(r.category?.value ?? "");
  const [remember, setRemember] = useState(false);
  const [notDuplicate, setNotDuplicate] = useState(false);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = async (action: "approve" | "reject") => {
    setBusy(action);
    setError(null);
    try {
      const corrections = Object.fromEntries(Object.entries(values).filter(([, v]) => v && v.trim()));
      const changedCategory = category && (needsCategory || category !== r.category?.value);
      const body = { action, ...(Object.keys(corrections).length ? { corrections } : {}), ...(changedCategory ? { category, remember } : {}), ...(notDuplicate ? { notDuplicate } : {}) };
      const res = await jsonFetch<{ run: RunView }>(`/api/mimic/runs/${run.id}`, { method: "POST", body: JSON.stringify(body) });
      onChanged?.(res.run);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (confirmedDup)
    return (
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-s-line px-4 py-3 text-[13.5px]">
        <span>This invoice is already in Demo Books. Mimic won&apos;t create it twice.</span>
        <button type="button" onClick={() => send("reject")} disabled={!!busy} className="rounded-xl border border-s-line-strong px-3 py-1.5 text-[13px] hover:bg-s-hover disabled:opacity-50">
          {busy === "reject" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Dismiss"}
        </button>
      </div>
    );

  return (
    <div className="mt-4 rounded-2xl border border-s-line p-4">
      <p className="text-[13.5px] font-medium">{run.status === "proposal" ? "Create this draft?" : run.status === "needs_approval" ? "Approve the draft?" : "Fix what's needed, then approve"}</p>
      {fixable.length > 0 && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {fixable.map((f) => (
            <label key={f} className="text-[12.5px] text-s-ink-2">
              {FIELD_LABEL[f]}
              {r.extracted![f].value === null ? " (not found)" : ""}
              <input
                value={values[f] ?? ""}
                placeholder={r.extracted![f].value === null ? (f === "invoiceDate" || f === "dueDate" ? "e.g. 02.10.2026" : "") : String(r.extracted![f].value)}
                onChange={(e) => setValues((v) => ({ ...v, [f]: e.target.value }))}
                className="mt-1 block h-9 w-full rounded-xl border border-s-line-strong bg-transparent px-3 text-[13.5px] text-s-ink outline-none focus:border-s-accent"
              />
            </label>
          ))}
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-[12.5px] text-s-ink-2">
          Category
          <select value={category} onChange={(e) => setCategory(e.target.value as Category)} className="mt-1 block h-9 rounded-xl border border-s-line-strong bg-transparent px-2 text-[13.5px] text-s-ink">
            <option value="">Choose…</option>
            {CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        {category && category !== r.category?.value && (
          <fieldset className="text-[12.5px]">
            <legend className="sr-only">Use this category</legend>
            <label className="mr-3 inline-flex items-center gap-1.5">
              <input type="radio" checked={!remember} onChange={() => setRemember(false)} /> Only this invoice
            </label>
            <label className="inline-flex items-center gap-1.5">
              <input type="radio" checked={remember} onChange={() => setRemember(true)} /> Always for this supplier
            </label>
          </fieldset>
        )}
        {probable && (
          <label className="inline-flex items-center gap-1.5 text-[12.5px]">
            <input type="checkbox" checked={notDuplicate} onChange={(e) => setNotDuplicate(e.target.checked)} /> It&apos;s a different invoice
          </label>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-3 text-[13px] text-s-danger">
          {error}
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => send("approve")}
          disabled={!!busy || (needsCategory && !category) || (probable && !notDuplicate)}
          className="inline-flex h-9 items-center gap-2 rounded-xl bg-s-accent px-4 text-[13.5px] font-medium text-s-accent-ink disabled:opacity-50"
        >
          {busy === "approve" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          {run.status === "proposal" ? "Create draft" : "Approve and create draft"}
        </button>
        <button type="button" onClick={() => send("reject")} disabled={!!busy} className="inline-flex h-9 items-center gap-2 rounded-xl border border-s-line-strong px-4 text-[13.5px] hover:bg-s-hover disabled:opacity-50">
          {busy === "reject" ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />} Reject
        </button>
      </div>
      <p className="mt-2 text-[12px] text-s-ink-3">Mimic checks everything again before it writes, and won&apos;t create the same invoice twice.</p>
    </div>
  );
}
