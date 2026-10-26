"use client";
import { useEffect, useRef, useState } from "react";
import { Check, Download, Play, Square, X } from "lucide-react";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { jsonFetch, postNdjson } from "@/hooks/use-ndjson";
import type { CheckResult, CheckSummary } from "@/lib/evals/answer-check";
import { cn } from "@/lib/utils";

type ModelOption = { id: string; displayName: string; provider: string; estimatedUsd: number | null };
type Row = { id: string; category: string; pass: boolean; checks: CheckResult[]; words: number; prompt: string; reply: string; error: string | null; latencyMs: number; costUsd: number };
type Done = { summary: CheckSummary; costUsd: number };
type Saved = { at: string; model: string; passed: number; total: number };

const LAST_KEY = "orbis:admin:answer-check:last";
function parseSaved(raw: string | null): Saved | null {
  try {
    const v = JSON.parse(raw ?? "null") as Saved | null;
    return v && typeof v.passed === "number" && typeof v.total === "number" ? v : null;
  } catch {
    return null;
  }
}
const usd = (n: number) => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

/**
 * Admin answer check: runs 40 fixed questions on one model and grades each
 * reply against rules a program can check. Nothing runs until the admin presses
 * Run, after seeing the estimated cost. The last score is kept in this browser
 * so the next run can be compared with it.
 */
export function AnswerCheckPanel() {
  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [cases, setCases] = useState(0);
  const [modelId, setModelId] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [done, setDone] = useState<Done | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRaw, setLastRaw] = useLocalStorage(LAST_KEY);
  const [open, setOpen] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    jsonFetch<{ cases: number; models: ModelOption[] }>("/api/admin/answer-check")
      .then((r) => {
        const real = r.models.filter((m) => m.provider !== "demo");
        setModels(real);
        setCases(r.cases);
        setModelId((id) => id || real[0]?.id || "");
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const last = parseSaved(lastRaw);
  const chosen = models?.find((m) => m.id === modelId);
  const run = async () => {
    if (!chosen) return;
    setRunning(true);
    setRows([]);
    setDone(null);
    setError(null);
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      for await (const ev of postNdjson("/api/admin/answer-check", { modelId }, ctrl.signal)) {
        if (ev.type === "result") setRows((r) => [...r, ev as unknown as Row]);
        else if (ev.type === "done") {
          const d = ev as unknown as Done;
          setDone(d);
          const saved = { at: new Date().toISOString(), model: chosen.displayName, passed: d.summary.passed, total: d.summary.total };
          setLastRaw(JSON.stringify(saved));
        } else if (ev.type === "error") setError(String(ev.message ?? "The check failed."));
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setRunning(false);
      abort.current = null;
    }
  };

  const download = () => {
    const blob = new Blob([JSON.stringify({ model: chosen?.displayName, at: new Date().toISOString(), summary: done?.summary, costUsd: done?.costUsd, results: rows }, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `answer-check-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const passed = rows.filter((r) => r.pass).length;
  return (
    <section aria-labelledby="answer-check-h" className="glass rounded-[22px] p-5">
      <h2 id="answer-check-h" className="text-[15px] font-semibold">
        Answer check
      </h2>
      <p className="mt-1 max-w-2xl text-[13px] text-s-ink-3">
        {cases || 40} fixed questions (facts, reasoning, code, writing, follow-ups, other languages, honesty about live data, safety, clarifying questions and reply length), each graded by rules a
        program can check. Run it before and after changing prompts or models to see whether answers got better or worse. It doesn&rsquo;t measure everything: read the replies too.
      </p>

      {last && (
        <p className="mt-3 text-[13px] text-s-ink-2">
          Last run in this browser: {last.passed}/{last.total} on {last.model}, {new Date(last.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}.
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <select
          value={modelId}
          onChange={(e) => setModelId(e.target.value)}
          disabled={running || !models?.length}
          aria-label="Model to check"
          className="h-9 max-w-[260px] rounded-xl border border-s-line-strong bg-s-bg px-2 text-[13px] text-s-ink"
        >
          {!models && <option>Loading…</option>}
          {models?.length === 0 && <option>No real models are set up</option>}
          {models?.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName}
            </option>
          ))}
        </select>
        {running ? (
          <button type="button" onClick={() => abort.current?.abort()} className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-s-ink px-3.5 text-[13.5px] font-medium text-s-bg">
            <Square className="h-3.5 w-3.5 fill-current" /> Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void run()}
            disabled={!chosen}
            className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-s-accent px-3.5 text-[13.5px] font-medium text-s-accent-ink hover:brightness-110 disabled:opacity-40"
          >
            <Play className="h-3.5 w-3.5" /> Run check
          </button>
        )}
        {chosen && (
          <span className="text-[12.5px] text-s-ink-3">
            {chosen.estimatedUsd !== null
              ? `About ${usd(chosen.estimatedUsd)} per run (estimate; real cost depends on reply length)`
              : "No verified price for this model, so the cost can't be estimated"}
          </span>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-3 text-[13px] text-s-danger">
          {error}
        </p>
      )}

      {(rows.length > 0 || running) && (
        <div className="mt-4">
          <div className="flex flex-wrap items-center gap-3 text-[13.5px]" aria-live="polite">
            <span className="font-medium">
              {passed}/{rows.length} passed{running ? ` · ${rows.length} of ${cases} done` : ""}
            </span>
            {done && <span className="text-s-ink-3">Cost {usd(done.costUsd)}</span>}
            {done && (
              <button type="button" onClick={download} className="inline-flex h-8 items-center gap-1.5 rounded-full border border-s-line-strong px-3 text-[12.5px] hover:bg-s-hover">
                <Download className="h-3.5 w-3.5" /> Download results
              </button>
            )}
          </div>
          {done && (
            <ul className="mt-2 flex flex-wrap gap-1.5 text-[12px]">
              {Object.entries(done.summary.byCategory).map(([k, v]) => (
                <li key={k} className={cn("rounded-full border px-2.5 py-1", v.passed === v.total ? "border-s-line text-s-ink-2" : "border-s-danger/40 text-s-danger")}>
                  {k} {v.passed}/{v.total}
                </li>
              ))}
            </ul>
          )}
          <ul className="mt-3 divide-y divide-s-line s-card rounded-2xl">
            {rows.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setOpen(open === r.id ? null : r.id)}
                  aria-expanded={open === r.id}
                  className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-[13px] hover:bg-s-hover"
                >
                  {r.pass ? <Check className="h-4 w-4 shrink-0 text-s-ink-2" aria-label="Passed" /> : <X className="h-4 w-4 shrink-0 text-s-danger" aria-label="Failed" />}
                  <span className="min-w-0 flex-1 truncate">{r.prompt}</span>
                  <span className="shrink-0 text-[12px] text-s-ink-3">{r.category}</span>
                </button>
                {open === r.id && (
                  <div className="space-y-2 px-3.5 pb-3 text-[13px]">
                    <ul className="flex flex-wrap gap-1.5 text-[12px]">
                      {r.checks.map((c) => (
                        <li key={c.name} className={cn("rounded-full border px-2 py-0.5", c.ok ? "border-s-line text-s-ink-3" : "border-s-danger/40 text-s-danger")}>
                          {c.ok ? "✓" : "✗"} {c.name}
                        </li>
                      ))}
                    </ul>
                    {r.error && <p className="text-s-danger">{r.error}</p>}
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-xl bg-s-hover p-3 text-[12.5px] leading-relaxed">{r.reply || "(no reply)"}</pre>
                    <p className="text-[12px] text-s-ink-3">
                      {r.words} words · {(r.latencyMs / 1000).toFixed(1)} s · {usd(r.costUsd)}
                    </p>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
