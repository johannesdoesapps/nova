"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Lightbulb, Plus, Save, Sparkles, Trash2, X } from "lucide-react";
import { useApp } from "@/components/layout/app-context";
import { Badge, Button, Card, Input, Notice, PageHeader, Select, Textarea } from "@/components/ui/primitives";
import { jsonFetch } from "@/hooks/use-ndjson";
import { isDiscriminating, newArena, standings, statusFromEvidence, suggestEvidence, verdict, type Arena, type Hypothesis, type Prediction, type PredictionEvidence } from "@/lib/claims/hypothesis";
import { cn, relativeTime } from "@/lib/utils";
import { StatusBadge } from "./badges";
import { localArenas } from "./local-store";
import { useReports } from "./report-picker";
import { SectionTabs } from "./section-tabs";
import { CLAIM_TABS } from "./tabs-config";

const STANDING_TONE = { untested: "default", unrefuted: "success", weakened: "danger", mixed: "warning" } as const;
const PRED_TONE = { untested: "default", consistent: "success", inconsistent: "danger", ambiguous: "warning" } as const;

export function ArenaView() {
  const { user } = useApp();
  const params = useSearchParams();
  const router = useRouter();
  const reportId = params.get("report");
  const { report, list: reports } = useReports(reportId);
  const [arenas, setArenas] = useState<Arena[]>([]);
  const [arena, setArena] = useState<Arena | null>(null);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [notices, setNotices] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (user) void jsonFetch<{ arenas: Arena[] }>("/api/claims/arenas").then((r) => setArenas(r.arenas)).catch(() => {});
    // eslint-disable-next-line react-hooks/set-state-in-effect
    else setArenas(localArenas.list());
  }, [user]);

  const effectiveQuestion = question || report?.question || "";
  const update = (fn: (a: Arena) => Arena) => {
    setArena((a) => (a ? { ...fn(a), updatedAt: new Date().toISOString() } : a));
    setDirty(true);
  };

  const start = async (useModel: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await jsonFetch<{ hypotheses: Hypothesis[]; origin: string; notices: string[] }>("/api/claims/hypotheses", {
        method: "POST",
        body: JSON.stringify({ question: effectiveQuestion, useModel, context: report?.claims.slice(0, 20).map((c) => c.text) }),
      });
      setNotices(r.notices);
      setArena({ ...newArena(effectiveQuestion, report?.id ?? null), hypotheses: r.hypotheses });
      setDirty(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!arena) return;
    try {
      if (user) await jsonFetch(`/api/claims/arenas/${arena.id}`, { method: "PUT", body: JSON.stringify(arena) });
      else localArenas.save(arena);
      setArenas((xs) => [arena, ...xs.filter((x) => x.id !== arena.id)]);
      setDirty(false);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const removeArena = async (id: string) => {
    if (user) await fetch(`/api/claims/arenas/${id}`, { method: "DELETE" });
    else localArenas.remove(id);
    setArenas((xs) => xs.filter((x) => x.id !== id));
    if (arena?.id === id) setArena(null);
  };

  const s = useMemo(() => (arena ? standings(arena) : []), [arena]);
  const v = useMemo(() => (arena ? verdict(arena) : null), [arena]);
  const suggestions = useMemo(() => (arena && report ? suggestEvidence(arena, report) : []), [arena, report]);

  const addEvidence = (hid: string, pid: string, ev: PredictionEvidence) =>
    update((a) => ({
      ...a,
      hypotheses: a.hypotheses.map((h) =>
        h.id !== hid ? h : { ...h, predictions: h.predictions.map((p) => (p.id !== pid ? p : { ...p, evidence: [...p.evidence, ev], status: statusFromEvidence([...p.evidence, ev]) })) },
      ),
    }));

  return (
    <div className="mx-auto max-w-7xl px-4 pb-16 pt-8 sm:px-6">
      <PageHeader title="Hypothesis Arena" description="Put competing explanations side by side, write down what each one predicts, and record which predictions the evidence bears out. No win probabilities — just which explanations survive testing." />
      <SectionTabs tabs={CLAIM_TABS} />

      {!arena ? (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[1fr_280px]">
          <Card className="space-y-4 p-4">
            <div className="text-sm font-medium">Question to explain</div>
            <Input value={effectiveQuestion} onChange={(e) => setQuestion(e.target.value)} placeholder="e.g. Why did support tickets double in March?" maxLength={2000} aria-label="Question" />
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted">Link a claim report (optional):</span>
              <Select value={reportId ?? ""} onChange={(e) => router.replace(e.target.value ? `/claims/arena?report=${e.target.value}` : "/claims/arena")} aria-label="Claim report">
                <option value="">None</option>
                {reports.map((r) => <option key={r.id} value={r.id}>{r.question || "Untitled"} · {relativeTime(r.created_at)}</option>)}
              </Select>
            </div>
            {report && <p className="text-xs text-faint">Claims from this report will be suggested as evidence for predictions. Suggestions are never applied automatically.</p>}
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => start(false)} loading={busy} disabled={effectiveQuestion.trim().length < 3} variant="secondary"><Lightbulb className="h-4 w-4" /> Start from template</Button>
              <Button onClick={() => start(true)} loading={busy} disabled={effectiveQuestion.trim().length < 3}><Sparkles className="h-4 w-4" /> Generate with a model</Button>
            </div>
            {error && <Notice tone="danger">{error}</Notice>}
          </Card>
          <Card className="h-fit p-4">
            <div className="mb-2 text-sm font-medium">Saved arenas</div>
            {!user && <p className="mb-2 text-xs text-faint">Saved in this browser only.</p>}
            {arenas.length === 0 ? <p className="text-sm text-faint">None yet.</p> : (
              <ul className="space-y-1">
                {arenas.map((a) => (
                  <li key={a.id} className="group flex items-start gap-1">
                    <button type="button" onClick={() => { setArena(a); setDirty(false); }} className="min-w-0 flex-1 rounded-lg px-2 py-1.5 text-left hover:bg-panel-2">
                      <div className="truncate text-sm">{a.question}</div>
                      <div className="text-[11px] text-faint">{a.hypotheses.length} hypotheses · {relativeTime(a.updatedAt)}</div>
                    </button>
                    <Button variant="ghost" size="icon" className="opacity-0 group-hover:opacity-100" onClick={() => removeArena(a.id)} aria-label="Delete arena"><Trash2 className="h-3.5 w-3.5" /></Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button variant="ghost" size="sm" onClick={() => setArena(null)}>← All arenas</Button>
            <Button size="sm" onClick={save} disabled={!dirty}><Save className="h-3.5 w-3.5" /> {dirty ? "Save" : "Saved"}</Button>
          </div>
          <Card className="p-4">
            <div className="text-xs uppercase tracking-wider text-faint">Question</div>
            <div className="mt-1 text-lg font-medium">{arena.question}</div>
            {notices.map((n) => <Notice key={n} tone="info" className="mt-2">{n}</Notice>)}
            {v && (
              <div className={cn("mt-3 rounded-xl border p-3 text-sm", v.leader ? "border-success/30 bg-success/[0.06]" : "border-border bg-bg-elev")}>
                <div className="font-medium">{v.leader ? "Provisional standing" : "No verdict yet"}</div>
                <p className="mt-0.5 text-muted">{v.message}</p>
              </div>
            )}
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[520px] text-left text-sm">
                <thead className="text-xs text-faint"><tr><th className="py-1 font-medium">Hypothesis</th><th className="font-medium">Standing</th><th className="font-medium">Consistent</th><th className="font-medium">Inconsistent</th><th className="font-medium">Untested</th><th className="font-medium" title="Tested predictions that no rival hypothesis shares">Discriminating tested</th></tr></thead>
                <tbody className="divide-y divide-border">
                  {s.map((x) => (
                    <tr key={x.hypothesisId}><td className="py-1.5">{x.hypothesisId} · {x.label}</td><td><Badge tone={STANDING_TONE[x.standing]}>{x.standing}</Badge></td><td className="tabular-nums">{x.consistent}</td><td className="tabular-nums">{x.inconsistent}</td><td className="tabular-nums">{x.untested}</td><td className="tabular-nums">{x.discriminatingTested}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2 xl:grid-cols-3">
            {arena.hypotheses.map((h) => (
              <HypothesisCard
                key={h.id}
                arena={arena}
                h={h}
                onChange={(next) => update((a) => ({ ...a, hypotheses: a.hypotheses.map((x) => (x.id === h.id ? next : x)) }))}
                onRemove={() => update((a) => ({ ...a, hypotheses: a.hypotheses.filter((x) => x.id !== h.id) }))}
                onEvidence={(pid, ev) => addEvidence(h.id, pid, ev)}
                suggestions={suggestions.filter((x) => x.hypothesisId === h.id)}
                reportClaims={report?.claims ?? []}
              />
            ))}
            {arena.hypotheses.length < 8 && (
              <button
                type="button"
                onClick={() => {
                  const id = `H${Math.max(0, ...arena.hypotheses.map((h) => Number(h.id.slice(1)) || 0)) + 1}`;
                  update((a) => ({ ...a, hypotheses: [...a.hypotheses, { id, label: "New hypothesis", statement: "", origin: "user", predictions: [] }] }));
                }}
                className="flex min-h-40 items-center justify-center gap-2 rounded-2xl border border-dashed border-border text-sm text-muted hover:text-fg"
              >
                <Plus className="h-4 w-4" /> Add hypothesis
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function HypothesisCard({ arena, h, onChange, onRemove, onEvidence, suggestions, reportClaims }: {
  arena: Arena;
  h: Hypothesis;
  onChange: (h: Hypothesis) => void;
  onRemove: () => void;
  onEvidence: (pid: string, ev: PredictionEvidence) => void;
  suggestions: ReturnType<typeof suggestEvidence>;
  reportClaims: { id: string; text: string; assessment: { status: import("@/lib/claims/types").ClaimStatus } }[];
}) {
  const setPred = (p: Prediction) => onChange({ ...h, predictions: h.predictions.map((x) => (x.id === p.id ? p : x)) });
  return (
    <Card className="flex flex-col p-4">
      <div className="flex items-start gap-2">
        <Badge tone="accent">{h.id}</Badge>
        <Input value={h.label} onChange={(e) => onChange({ ...h, label: e.target.value })} className="h-8 font-medium" aria-label="Hypothesis name" maxLength={80} />
        <Button variant="ghost" size="icon" onClick={onRemove} aria-label="Remove hypothesis"><X className="h-4 w-4" /></Button>
      </div>
      <Textarea value={h.statement} onChange={(e) => onChange({ ...h, statement: e.target.value })} rows={2} className="mt-2" placeholder="One-sentence explanation" aria-label="Statement" maxLength={400} />
      <div className="mt-1 text-[11px] text-faint">{h.origin === "template" ? "Template starter — edit to fit your question." : h.origin === "model" ? "Generated by a model — a starting point, not a conclusion." : "Written by you."}</div>
      <div className="mt-3 text-xs font-medium text-muted">Predictions</div>
      <ul className="mt-1 flex-1 space-y-2">
        {h.predictions.map((p) => (
          <PredictionRow key={p.id} p={p} discriminating={isDiscriminating(arena, h.id, p)} onChange={setPred} onEvidence={(ev) => onEvidence(p.id, ev)} suggestions={suggestions.filter((s) => s.predictionId === p.id)} reportClaims={reportClaims} />
        ))}
      </ul>
      <Button variant="ghost" size="sm" className="mt-2 self-start" onClick={() => onChange({ ...h, predictions: [...h.predictions, { id: `${h.id}-P${h.predictions.length + 1}-${Date.now() % 1000}`, expectation: "", test: "", status: "untested", evidence: [] }] })}>
        <Plus className="h-3.5 w-3.5" /> Add prediction
      </Button>
    </Card>
  );
}

function PredictionRow({ p, discriminating, onChange, onEvidence, suggestions, reportClaims }: {
  p: Prediction;
  discriminating: boolean;
  onChange: (p: Prediction) => void;
  onEvidence: (ev: PredictionEvidence) => void;
  suggestions: ReturnType<typeof suggestEvidence>;
  reportClaims: { id: string; text: string; assessment: { status: import("@/lib/claims/types").ClaimStatus } }[];
}) {
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-xl border border-border bg-bg-elev p-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={PRED_TONE[p.status]}>{p.status}</Badge>
        {discriminating ? <Badge tone="accent" title="No rival hypothesis predicts the same thing, so testing this one tells them apart.">discriminating</Badge> : <Badge title="A rival hypothesis predicts much the same thing.">shared</Badge>}
      </div>
      <Textarea value={p.expectation} onChange={(e) => onChange({ ...p, expectation: e.target.value })} rows={2} className="mt-1.5 text-xs" placeholder="If true, we should observe…" aria-label="Expectation" maxLength={400} />
      <Input value={p.test} onChange={(e) => onChange({ ...p, test: e.target.value })} className="mt-1.5 h-8 text-xs" placeholder="How to check it" aria-label="Test" maxLength={400} />
      {p.evidence.length > 0 && (
        <ul className="mt-1.5 space-y-1 text-[11px] text-muted">
          {p.evidence.map((e, i) => (
            <li key={i}><Badge tone={e.stance === "consistent" ? "success" : e.stance === "inconsistent" ? "danger" : "warning"}>{e.stance}</Badge> {e.claimId && <span className="font-mono">{e.claimId}</span>} {e.note}</li>
          ))}
        </ul>
      )}
      <button type="button" onClick={() => setOpen(!open)} className="mt-1.5 text-[11px] text-accent hover:underline">{open ? "Close" : "Record evidence"}</button>
      {open && (
        <div className="mt-1.5 space-y-1.5">
          <Input value={note} onChange={(e) => setNote(e.target.value)} className="h-8 text-xs" placeholder="What did you find? (source, figure, observation)" maxLength={400} aria-label="Evidence note" />
          <div className="flex flex-wrap gap-1">
            {(["consistent", "inconsistent", "ambiguous"] as const).map((s) => (
              <Button key={s} size="sm" variant="secondary" disabled={!note.trim()} onClick={() => { onEvidence({ note: note.trim(), stance: s, addedBy: "user" }); setNote(""); }}>{s}</Button>
            ))}
          </div>
          {suggestions.length > 0 && (
            <div className="rounded-lg border border-border p-2">
              <div className="text-[11px] text-faint">Possibly relevant claims from the linked report (term overlap — you decide):</div>
              <ul className="mt-1 space-y-1.5">
                {suggestions.slice(0, 4).map((s) => {
                  const claim = reportClaims.find((c) => c.id === s.claimId);
                  return (
                    <li key={s.claimId} className="text-[11px]">
                      <div className="flex items-center gap-1"><span className="font-mono text-faint">{s.claimId}</span>{claim && <StatusBadge status={claim.assessment.status} />}</div>
                      <div className="text-muted">{s.text}</div>
                      <div className="mt-0.5 flex gap-1">
                        {(["consistent", "inconsistent"] as const).map((st) => (
                          <button key={st} type="button" className="rounded border border-border px-1.5 py-0.5 hover:text-fg" onClick={() => onEvidence({ claimId: s.claimId, note: s.text.slice(0, 160), stance: st, addedBy: "user" })}>mark {st}</button>
                        ))}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {suggestions.length === 0 && reportClaims.length === 0 && <p className="text-[11px] text-faint">Link a claim report to get suggested evidence.</p>}
        </div>
      )}
    </li>
  );
}
