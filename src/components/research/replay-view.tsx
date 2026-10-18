"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { CheckCircle2, CircleDashed, Play, RotateCcw, XCircle } from "lucide-react";
import { useApp } from "@/components/layout/app-context";
import { Badge, Button, Card, EmptyState, Notice, PageHeader, Select } from "@/components/ui/primitives";
import { jsonFetch } from "@/hooks/use-ndjson";
import { inputFromReport, runClaimPipeline } from "@/lib/claims/pipeline";
import { compareReplays, type ReplayComparison } from "@/lib/claims/replay";
import type { ClaimReport, ReplayEvent } from "@/lib/claims/types";
import { cn, relativeTime } from "@/lib/utils";
import { StatusBadge } from "./badges";
import { useReports } from "./report-picker";
import { SectionTabs } from "./section-tabs";
import { CLAIM_TABS } from "./tabs-config";

const ACTOR_TONE = { user: "accent", rules: "default", model: "warning" } as const;

export function ReplayView() {
  const { user } = useApp();
  const params = useSearchParams();
  const router = useRouter();
  const reportId = params.get("report");
  const { report, list, error } = useReports(reportId);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [cmp, setCmp] = useState<{ comparison: ReplayComparison; rerun: ClaimReport; label: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const replayFrozen = () => {
    if (!report) return;
    const input = inputFromReport(report);
    const rerun = runClaimPipeline({ ...input, sources: input.sources.filter((s) => !excluded.has(`S${s.index}`)) }, report.id);
    setCmp({ comparison: compareReplays(report, rerun), rerun, label: excluded.size ? `Re-run without ${[...excluded].join(", ")}` : "Exact replay (recorded inputs and model outputs)" });
  };

  const replayLive = async () => {
    if (!report) return;
    setBusy(true);
    setErr(null);
    try {
      const input = inputFromReport(report);
      const r = await jsonFetch<{ report: ClaimReport }>("/api/claims/analyze", {
        method: "POST",
        body: JSON.stringify({ question: input.question, answer: input.answer, mode: "model", modelId: report.modelId ?? undefined, save: false, sources: input.sources.map((s) => ({ ...s, provider: s.provider ?? null })) }),
      });
      setCmp({ comparison: compareReplays(report, r.report), rerun: r.report, label: "Live re-run (model called again)" });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const changed = useMemo(() => {
    if (!cmp || !report) return [];
    return report.claims
      .map((c) => ({ before: c, after: cmp.rerun.claims.find((x) => x.text === c.text) }))
      .filter((x) => x.after && x.after.assessment.status !== x.before.assessment.status);
  }, [cmp, report]);

  return (
    <div className="mx-auto max-w-6xl px-4 pb-16 pt-8 sm:px-6">
      <PageHeader title="Research Replay" description="Every Claim DNA analysis records each step with fingerprints of its inputs and outputs. Replay it to check it reproduces, or change one input to see which conclusions depend on it." />
      <SectionTabs tabs={CLAIM_TABS} />
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">Analysis:</span>
        <Select value={reportId ?? ""} onChange={(e) => { setCmp(null); setExcluded(new Set()); router.replace(e.target.value ? `/claims/replay?report=${e.target.value}` : "/claims/replay"); }} aria-label="Report">
          <option value="">Choose a saved analysis…</option>
          {list.map((r) => <option key={r.id} value={r.id}>{r.question || "Untitled"} · {relativeTime(r.created_at)}</option>)}
        </Select>
        {!user && <span className="text-xs text-faint">Showing analyses saved in this browser.</span>}
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      {!report ? (
        <EmptyState title="Pick an analysis to replay">Run one in Claim DNA first; it is recorded automatically.</EmptyState>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Card className="p-4">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">Recorded process</div>
              <div className="text-[11px] text-faint">{report.replay.pipelineVersion} · clock {report.replay.config.now.slice(0, 19).replace("T", " ")} UTC</div>
            </div>
            <ol className="mt-3 space-y-2">
              {report.replay.events.map((e) => <EventRow key={e.seq} e={e} diff={cmp?.comparison.steps.find((s) => s.step === e.step)} />)}
            </ol>
          </Card>
          <div className="space-y-4">
            <Card className="space-y-3 p-4">
              <div className="text-sm font-medium">Replay</div>
              <div>
                <div className="text-xs text-muted">Leave out sources (what-if):</div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {report.sources.map((s) => (
                    <label key={s.id} className="flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-xs">
                      <input type="checkbox" checked={excluded.has(s.id)} onChange={(e) => { const n = new Set(excluded); if (e.target.checked) n.add(s.id); else n.delete(s.id); setExcluded(n); }} className="accent-[var(--accent)]" />
                      [{s.index}] {s.publisher}
                    </label>
                  ))}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button onClick={replayFrozen}><Play className="h-4 w-4" /> {excluded.size ? "Re-run with changes" : "Replay exactly"}</Button>
                {report.mode === "model" && <Button variant="secondary" onClick={replayLive} loading={busy}><RotateCcw className="h-4 w-4" /> Live re-run (calls the model)</Button>}
              </div>
              <p className="text-xs text-faint">Exact replays run in your browser with the recorded inputs, clock and model outputs, so they cost nothing. A live re-run asks the model again; differences there show how stable its judgements are.</p>
              {err && <Notice tone="danger">{err}</Notice>}
            </Card>
            {cmp && (
              <Card className="space-y-3 p-4">
                <div className="flex items-center gap-2 text-sm font-medium">
                  {cmp.comparison.reproducible ? <CheckCircle2 className="h-4 w-4 text-success" /> : <XCircle className="h-4 w-4 text-warning" />}
                  {cmp.label}: {cmp.comparison.reproducible ? "every step reproduced" : `diverged at “${cmp.comparison.firstDivergence?.step.replace("_", " ")}”`}
                </div>
                {cmp.comparison.notes.map((n) => <Notice key={n} tone="info">{n}</Notice>)}
                {changed.length > 0 ? (
                  <div>
                    <div className="text-xs font-medium">Conclusions that changed</div>
                    <ul className="mt-1 space-y-2">
                      {changed.map(({ before, after }) => (
                        <li key={before.id} className="rounded-lg border border-border p-2 text-sm">
                          <div className="flex flex-wrap items-center gap-1.5"><span className="font-mono text-[11px] text-faint">{before.id}</span><StatusBadge status={before.assessment.status} /> → <StatusBadge status={after!.assessment.status} /></div>
                          <div className="mt-1 text-muted">{before.text}</div>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="text-xs text-muted">No claim changed status.</p>
                )}
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function EventRow({ e, diff }: { e: ReplayEvent; diff?: ReplayComparison["steps"][number] }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-xl border border-border bg-bg-elev p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[11px] text-faint">#{e.seq}</span>
        <span className="text-sm font-medium">{e.step.replace("_", " ")}</span>
        <Badge tone={ACTOR_TONE[e.actor]}>{e.actor}</Badge>
        {!e.deterministic && <Badge tone="warning" title="Calling the model again may give different output">non-deterministic</Badge>}
        {diff && (diff.outputMatches ? <Badge tone="success">matches</Badge> : <Badge tone="danger">differs</Badge>)}
        <span className="ml-auto text-[11px] tabular-nums text-faint">{e.durationMs} ms</span>
      </div>
      <p className="mt-1 text-xs text-muted">{e.description}</p>
      {e.model && <p className="mt-1 text-[11px] text-faint">Model {e.model.id}{e.model.servedModel ? ` (served as ${e.model.servedModel})` : ""} · temperature {e.model.temperature ?? "default"} · prompt {e.model.promptHash}</p>}
      <div className="mt-1 font-mono text-[10px] text-faint">in {e.inputHash} → out {e.outputHash}</div>
      <button type="button" onClick={() => setOpen(!open)} className={cn("mt-1 inline-flex items-center gap-1 text-[11px] text-accent hover:underline")}>
        <CircleDashed className="h-3 w-3" /> {open ? "Hide output" : "Show output"}
      </button>
      {open && <pre className="mt-1 max-h-64 overflow-auto rounded-lg bg-panel p-2 text-[11px] text-muted">{JSON.stringify(diff && !diff.outputMatches ? { before: diff.before, after: diff.after } : e.output, null, 2)}</pre>}
    </li>
  );
}
