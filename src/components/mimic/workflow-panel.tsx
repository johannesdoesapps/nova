"use client";
import { useState } from "react";
import { ArrowLeft, FlaskConical, Loader2, Pause, Play, Power, Trash2 } from "lucide-react";
import { Segmented, Switch } from "@/components/studio/ui";
import { jsonFetch } from "@/hooks/use-ndjson";
import type { Overview, RunView, WorkflowView } from "@/lib/mimic/server";
import { MODE_HINT, MODE_LABEL, MODES, TRIGGER_LABEL, type Mode, type TriggerKind } from "@/lib/mimic/types";
import { cn } from "@/lib/utils";
import { describeEvent } from "./teach";
import { RunCard } from "./run-card";

export const WF_STATUS: Record<WorkflowView["status"], { label: string; tone: string }> = {
  draft: { label: "Not tested yet", tone: "bg-s-hover text-s-ink-2" },
  tested: { label: "Tested, off", tone: "bg-sky-500/12 text-sky-700 dark:text-sky-300" },
  active: { label: "On", tone: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300" },
  paused: { label: "Paused", tone: "bg-amber-500/15 text-amber-800 dark:text-amber-300" },
};

/** Review, edit, test, turn on and run one automation. */
export function WorkflowPanel({ workflow, data, onBack, onChanged, onRun }: { workflow: WorkflowView; data: Overview; onBack: () => void; onChanged: (w: WorkflowView | null) => void; onRun: (r: RunView) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [docId, setDocId] = useState(data.samples[1]?.id ?? data.samples[0]!.id);
  const [lastRun, setLastRun] = useState<RunView | null>(null);
  const [showDemo, setShowDemo] = useState(false);
  const def = workflow.definition;
  const open = workflow.questions.filter((q) => q.answer === null);
  const runs = data.runs.filter((r) => r.workflowId === workflow.id).slice(0, 5);

  const patch = async (body: Record<string, unknown>, key: string) => {
    setBusy(key);
    setError(null);
    try {
      const r = await jsonFetch<{ workflow: WorkflowView }>(`/api/mimic/workflows/${workflow.id}`, { method: "PATCH", body: JSON.stringify(body) });
      onChanged(r.workflow);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const run = async (dryRun: boolean) => {
    setBusy(dryRun ? "test" : "run");
    setError(null);
    try {
      const r = await jsonFetch<{ run: RunView }>(`/api/mimic/workflows/${workflow.id}/run`, { method: "POST", body: JSON.stringify({ documentId: docId, dryRun }) });
      setLastRun(r.run);
      onRun(r.run);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete "${workflow.name}" and its run history? Drafts it created stay in Demo Books.`)) return;
    setBusy("delete");
    try {
      await jsonFetch(`/api/mimic/workflows/${workflow.id}`, { method: "DELETE" });
      onChanged(null);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  const docOptions = [...data.samples.map((s) => ({ id: s.id, label: `Sample: ${s.name} — ${s.shows}` })), ...data.documents.map((d) => ({ id: d.id, label: d.name }))];

  return (
    <div className="space-y-4">
      <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 text-[13.5px] text-s-ink-2 hover:text-s-ink">
        <ArrowLeft className="h-4 w-4" /> All automations
      </button>

      <section className="glass rounded-[22px] p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <span className={cn("inline-flex rounded-full px-2.5 py-0.5 text-[12px] font-medium", WF_STATUS[workflow.status].tone)}>{WF_STATUS[workflow.status].label}</span>
            <input
              defaultValue={workflow.name}
              aria-label="Automation name"
              onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== workflow.name && patch({ name: e.target.value.trim() }, "name")}
              className="mt-2 block w-full max-w-xl rounded-lg bg-transparent font-serif text-[30px] leading-tight outline-none focus:ring-2 focus:ring-s-accent/40"
            />
            <p className="mt-1 max-w-2xl text-[14px] text-s-ink-2">{def.objective}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {workflow.status === "active" ? (
              <button type="button" onClick={() => patch({ status: "paused" }, "status")} disabled={!!busy} className="inline-flex h-10 items-center gap-2 rounded-xl border border-s-line-strong px-4 text-[14px] hover:bg-s-hover">
                <Pause className="h-4 w-4" /> Pause
              </button>
            ) : (
              <button
                type="button"
                onClick={() => patch({ status: "active" }, "status")}
                disabled={!!busy || open.length > 0 || !workflow.testedAt}
                title={open.length ? "Answer the open questions first" : !workflow.testedAt ? "Run a test first" : undefined}
                className="inline-flex h-10 items-center gap-2 rounded-xl bg-s-accent px-4 text-[14px] font-medium text-s-accent-ink disabled:opacity-50"
              >
                <Power className="h-4 w-4" /> Turn on
              </button>
            )}
            <button type="button" onClick={remove} disabled={!!busy} aria-label="Delete automation" className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-s-line-strong hover:bg-s-hover">
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        </div>
        {error && (
          <p role="alert" className="mt-3 text-[13.5px] text-s-danger">
            {error}
          </p>
        )}
        {(open.length > 0 || !workflow.testedAt) && workflow.status !== "active" && (
          <p className="mt-3 text-[13px] text-s-ink-2">
            Before it can run: {[open.length ? `answer ${open.length} question${open.length === 1 ? "" : "s"}` : null, !workflow.testedAt ? "run a test" : null].filter(Boolean).join(" and ")}.
          </p>
        )}
      </section>

      {workflow.questions.length > 0 && (
        <section className="glass rounded-[22px] p-6" aria-labelledby="q-title">
          <h2 id="q-title" className="text-[16px] font-semibold">
            Questions from your demonstration
          </h2>
          <p className="text-[13px] text-s-ink-2">One demonstration can&apos;t show everything. Mimic asks instead of guessing.</p>
          <div className="mt-3 space-y-4">
            {workflow.questions.map((q) => (
              <fieldset key={q.id} className="s-card rounded-2xl p-4">
                <legend className="px-1 text-[14px] font-medium">{q.text}</legend>
                <div className="mt-1 flex flex-wrap gap-2">
                  {q.options.map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => patch({ answer: { questionId: q.id, answer: o.id } }, `q-${q.id}`)}
                      disabled={!!busy}
                      aria-pressed={q.answer === o.id}
                      className={cn("rounded-xl border px-3 py-1.5 text-[13px] transition", q.answer === o.id ? "border-s-accent bg-s-accent-soft font-medium" : "border-s-line-strong hover:bg-s-hover")}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </fieldset>
            ))}
          </div>
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
        <section className="glass rounded-[22px] p-6" aria-labelledby="steps-title">
          <h2 id="steps-title" className="text-[16px] font-semibold">
            Steps
          </h2>
          <p className="text-[13px] text-s-ink-2">&ldquo;Learned&rdquo; steps came from your demonstration; &ldquo;Added&rdquo; ones are safeguards Mimic includes. Safety steps can&apos;t be turned off.</p>
          <ol className="mt-3 space-y-3">
            {def.steps.map((s, i) => (
              <li key={s.id} className={cn("flex gap-3 s-card rounded-2xl p-3", !s.enabled && "opacity-60")}>
                <span className="mt-0.5 w-5 shrink-0 text-right text-[13px] tabular-nums text-s-ink-3">{i + 1}.</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[14px] font-medium">{s.title}</span>
                    <span className={cn("rounded-full px-2 py-0.5 text-[11px]", s.origin === "learned" ? "bg-violet-500/12 text-violet-700 dark:text-violet-300" : "bg-s-hover text-s-ink-2")}>{s.origin === "learned" ? "Learned" : "Added"}</span>
                  </div>
                  <p className="text-[12.5px] text-s-ink-2">{s.detail}</p>
                  {s.kind === "create_draft" && (
                    <label className="mt-2 inline-flex items-center gap-2 text-[12.5px]">
                      <Switch checked={s.requiresApproval} onChange={(v) => patch({ steps: [{ id: s.id, requiresApproval: v }] }, `s-${s.id}`)} label="Ask me before creating the draft" />
                      Ask me before creating the draft
                    </label>
                  )}
                </div>
                {!s.required && <Switch checked={s.enabled} onChange={(v) => patch({ steps: [{ id: s.id, enabled: v }] }, `s-${s.id}`)} label={`${s.title}: ${s.enabled ? "on" : "off"}`} />}
              </li>
            ))}
          </ol>
          <button type="button" onClick={() => setShowDemo((v) => !v)} className="mt-3 text-[13px] text-s-ink-2 underline-offset-2 hover:underline">
            {showDemo ? "Hide" : "Show"} what Mimic learned from
          </button>
          {showDemo && (
            <div className="mt-2 s-card rounded-2xl p-3 text-[12.5px]">
              <ul className="space-y-1">
                {workflow.observed.map((o, i) => (
                  <li key={i}>{o}</li>
                ))}
              </ul>
              <ol className="mt-3 space-y-0.5 text-s-ink-2">
                {workflow.demonstration.events.map((e, i) => (
                  <li key={i}>
                    {i + 1}. {describeEvent(e)}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </section>

        <div className="space-y-4">
          <section className="glass rounded-[22px] p-6" aria-labelledby="mode-title">
            <h2 id="mode-title" className="text-[16px] font-semibold">
              How much Mimic does on its own
            </h2>
            <div className="mt-3 overflow-x-auto">
              <Segmented label="Automation mode" value={workflow.mode} onChange={(m: Mode) => patch({ mode: m }, "mode")} options={MODES.map((m) => ({ value: m, label: MODE_LABEL[m] }))} />
            </div>
            <p className="mt-2 text-[13px] text-s-ink-2">{MODE_HINT[workflow.mode]}</p>
            {workflow.mode === "automatic" && (
              <label className="mt-3 block text-[12.5px] text-s-ink-2">
                Create drafts on its own up to this total ({def.currencies.join(", ")})
                <input
                  type="number"
                  min={0}
                  step={50}
                  defaultValue={def.autoLimit}
                  onBlur={(e) => Number(e.target.value) !== def.autoLimit && patch({ autoLimit: Math.max(0, Number(e.target.value) || 0) }, "limit")}
                  className="mt-1 block h-9 w-40 rounded-xl border border-s-line-strong bg-transparent px-3 text-[13.5px] text-s-ink"
                />
              </label>
            )}
            <label className="mt-4 block text-[12.5px] text-s-ink-2">
              When it runs
              <select value={def.trigger} onChange={(e) => patch({ trigger: e.target.value as TriggerKind }, "trigger")} className="mt-1 block h-9 rounded-xl border border-s-line-strong bg-transparent px-2 text-[13.5px] text-s-ink">
                {(Object.keys(TRIGGER_LABEL) as TriggerKind[]).map((t) => (
                  <option key={t} value={t}>
                    {TRIGGER_LABEL[t]}
                  </option>
                ))}
              </select>
            </label>
            <p className="mt-3 text-[12.5px] text-s-ink-3">Expected currency: {def.currencies.join(", ")}. Mimic stops on any other currency and never converts.</p>
          </section>

          <section className="glass rounded-[22px] p-6" aria-labelledby="test-title">
            <h2 id="test-title" className="text-[16px] font-semibold">
              Test it, then run it
            </h2>
            <p className="text-[13px] text-s-ink-2">A test shows exactly what Mimic would read, check and create. Nothing is saved.</p>
            <label className="mt-3 block text-[12.5px] text-s-ink-2">
              Invoice
              <select value={docId} onChange={(e) => setDocId(e.target.value)} className="mt-1 block h-9 w-full rounded-xl border border-s-line-strong bg-transparent px-2 text-[13px] text-s-ink">
                {docOptions.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" onClick={() => run(true)} disabled={!!busy} className="inline-flex h-9 items-center gap-2 rounded-xl border border-s-line-strong px-4 text-[13.5px] hover:bg-s-hover disabled:opacity-50">
                {busy === "test" ? <Loader2 className="h-4 w-4 animate-spin" /> : <FlaskConical className="h-4 w-4" />} Test run
              </button>
              <button type="button" onClick={() => run(false)} disabled={!!busy || workflow.status !== "active"} title={workflow.status !== "active" ? "Turn the automation on first" : undefined} className="inline-flex h-9 items-center gap-2 rounded-xl bg-s-accent px-4 text-[13.5px] font-medium text-s-accent-ink disabled:opacity-50">
                {busy === "run" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Run now
              </button>
            </div>
            <p className="mt-3 text-[12px] text-s-ink-3">Mimic uses: the invoice you choose (read-only) and Demo Books (creates draft transactions only, never posts, deletes or pays).</p>
          </section>
        </div>
      </div>

      {lastRun && <RunCard run={lastRun} workflowName={workflow.name} defaultOpen onChanged={(r) => (setLastRun(r), onRun(r))} />}
      {runs.length > 0 && !lastRun && (
        <section aria-labelledby="recent-title" className="space-y-3">
          <h2 id="recent-title" className="text-[15px] font-semibold">
            Recent runs
          </h2>
          {runs.map((r) => (
            <RunCard key={r.id} run={r} workflowName={workflow.name} onChanged={onRun} />
          ))}
        </section>
      )}
    </div>
  );
}
