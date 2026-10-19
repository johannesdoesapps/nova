"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, BookOpen, ExternalLink, FileSearch, History, Plus, Scale, Trash2, X } from "lucide-react";
import { useApp } from "@/components/layout/app-context";
import { ModelPicker, defaultModelId, useModels } from "@/components/common/model-picker";
import { Badge, Button, Card, EmptyState, Input, Notice, PageHeader, Select, Textarea } from "@/components/ui/primitives";
import { jsonFetch } from "@/hooks/use-ndjson";
import { normalizeAnswer } from "@/lib/claims/extract";
import { inputFromReport, runClaimPipeline } from "@/lib/claims/pipeline";
import type { Claim, ClaimReport, EvidenceLink, SourceRecord, Stance } from "@/lib/claims/types";
import { conflicts, directVsInference, factCheckQueue, misCitations, missingEvidence, unsupportedStatements } from "@/lib/claims/workflows";
import { cn, isSafeHttpUrl, relativeTime } from "@/lib/utils";
import { BasisBadge, EstimateMeter, JudgedByBadge, STATUS_META, StanceBadge, StatusBadge } from "./badges";
import { EXAMPLE } from "./examples";
import { handoff, localReports } from "./local-store";
import { SectionTabs } from "./section-tabs";
import { CLAIM_TABS } from "./tabs-config";

interface SourceDraft {
  key: string;
  title: string;
  url: string;
  publishedAt: string;
  text: string;
  provider: string | null;
}

type Workflow = "queue" | "unsupported" | "conflicts" | "missing" | "inference" | "miscited";

const blankSource = (): SourceDraft => ({ key: crypto.randomUUID(), title: "", url: "", publishedAt: "", text: "", provider: null });

export function ClaimDnaView() {
  const { user } = useApp();
  const params = useSearchParams();
  const models = useModels();
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [sources, setSources] = useState<SourceDraft[]>([blankSource()]);
  const [mode, setMode] = useState<"rules" | "model">("rules");
  const [picked, setPicked] = useState<string | undefined>();
  const modelId = picked ?? defaultModelId(models);
  const [report, setReport] = useState<ClaimReport | null>(null);
  const [savedOnServer, setSavedOnServer] = useState(false);
  const [notices, setNotices] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [workflow, setWorkflow] = useState<Workflow>("queue");
  const [inspect, setInspect] = useState<{ sourceId: string; quote?: string } | null>(null);
  const [history, setHistory] = useState<{ id: string; question: string; created_at: string; summary?: { headline?: string } }[]>([]);

  const fill = (h: typeof EXAMPLE) => {
    setQuestion(h.question);
    setAnswer(h.answer);
    setSources(h.sources.map((s) => ({ key: crypto.randomUUID(), title: s.title, url: s.url, publishedAt: s.publishedAt?.slice(0, 10) ?? "", text: s.text, provider: s.provider })));
    setReport(null);
  };

  // One-time setup on mount: search handoff, ?report= deep link, saved-report list.
  useEffect(() => {
    const h = handoff.take();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (h) fill(h);
    const id = params.get("report");
    if (user) {
      void jsonFetch<{ reports: typeof history }>("/api/claims/reports").then((r) => setHistory(r.reports)).catch(() => {});
      if (id) void jsonFetch<{ report: ClaimReport }>(`/api/claims/reports/${id}`).then((r) => { setReport(r.report); setSavedOnServer(true); }).catch((e) => setError((e as Error).message));
    } else {
      const local = localReports.list();
      setHistory(local.map((r) => ({ id: r.id, question: r.question, created_at: r.createdAt, summary: r.summary })));
      if (id) setReport(local.find((r) => r.id === id) ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const analyze = async () => {
    setBusy(true);
    setError(null);
    setNotices([]);
    try {
      const payload = {
        question,
        answer,
        mode,
        modelId: mode === "model" ? modelId : undefined,
        sources: sources
          .filter((s) => s.text.trim())
          .map((s, i) => ({
            index: i + 1,
            url: s.url.trim() || null,
            title: s.title.trim() || undefined,
            text: s.text,
            publishedAt: s.publishedAt || null,
            contentKind: s.provider ? ("snippet" as const) : s.url.trim() ? ("full_text" as const) : ("user_pasted" as const),
            provider: s.provider,
          })),
      };
      const r = await jsonFetch<{ report: ClaimReport; saved: boolean; notices: string[] }>("/api/claims/analyze", { method: "POST", body: JSON.stringify(payload) });
      setReport(r.report);
      setSavedOnServer(r.saved);
      setNotices(r.notices);
      setSelected(null);
      if (!r.saved) localReports.save(r.report);
      setHistory((h) => [{ id: r.report.id, question: r.report.question, created_at: r.report.createdAt, summary: r.report.summary }, ...h.filter((x) => x.id !== r.report.id)]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const review = async (link: EvidenceLink, stance: Stance) => {
    if (!report) return;
    const next = runClaimPipeline({ ...inputFromReport(report), reviews: [...report.reviews, { linkId: link.id, stance, at: new Date().toISOString() }] }, report.id);
    setReport(next);
    if (user && savedOnServer) await jsonFetch(`/api/claims/reports/${next.id}`, { method: "PUT", body: JSON.stringify(next) }).catch((e) => setError((e as Error).message));
    else localReports.save(next);
  };

  const open = async (id: string) => {
    setError(null);
    if (user) {
      try {
        const r = await jsonFetch<{ report: ClaimReport }>(`/api/claims/reports/${id}`);
        setReport(r.report);
        setSavedOnServer(true);
      } catch (e) {
        setError((e as Error).message);
      }
    } else setReport(localReports.list().find((r) => r.id === id) ?? null);
    setSelected(null);
  };

  const removeReport = async (id: string) => {
    if (!window.confirm("Delete this report? This can't be undone.")) return;
    setError(null);
    if (user) {
      try {
        await jsonFetch(`/api/claims/reports/${id}`, { method: "DELETE" });
      } catch (e) {
        setError((e as Error).message);
        return;
      }
    } else localReports.remove(id);
    setHistory((h) => h.filter((x) => x.id !== id));
    if (report?.id === id) setReport(null);
  };

  const claim = report?.claims.find((c) => c.id === selected) ?? null;

  return (
    <div className="mx-auto max-w-7xl px-4 pb-16 pt-8 sm:px-6">
      <PageHeader
        title="Claim DNA"
        description="Break an answer or report into individual claims, link each one to supporting, conflicting or missing evidence, and see exactly where that judgement came from."
      />
      <SectionTabs tabs={CLAIM_TABS} />

      {!report ? (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[1fr_280px]">
          <Card className="space-y-4 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-medium">What should be checked?</div>
              <Button variant="ghost" size="sm" onClick={() => fill(EXAMPLE)}>
                <BookOpen className="h-3.5 w-3.5" /> Load example (fictional sources)
              </Button>
            </div>
            <Input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Question or topic (optional)" maxLength={2000} aria-label="Question" />
            <Textarea value={answer} onChange={(e) => setAnswer(e.target.value)} rows={8} maxLength={40000} placeholder="Paste an AI answer, report or article. Citation markers like [1] are matched to the numbered sources below." aria-label="Answer to analyse" />
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">Sources <span className="font-normal text-faint">— numbered in order; [1] refers to the first</span></div>
                <Button variant="secondary" size="sm" onClick={() => setSources([...sources, blankSource()])} disabled={sources.length >= 20}>
                  <Plus className="h-3.5 w-3.5" /> Add source
                </Button>
              </div>
              {sources.map((s, i) => (
                <div key={s.key} className="rounded-xl border border-border bg-bg-elev p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <Badge>[{i + 1}]</Badge>
                    <Input value={s.title} onChange={(e) => setSources(sources.map((x) => (x.key === s.key ? { ...x, title: e.target.value } : x)))} placeholder="Title" className="h-8" aria-label={`Source ${i + 1} title`} />
                    <Button variant="ghost" size="icon" aria-label="Remove source" onClick={() => setSources(sources.filter((x) => x.key !== s.key))}>
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="mb-2 grid gap-2 sm:grid-cols-[1fr_150px]">
                    <Input value={s.url} onChange={(e) => setSources(sources.map((x) => (x.key === s.key ? { ...x, url: e.target.value } : x)))} placeholder="https://… (optional)" className="h-8" aria-label={`Source ${i + 1} URL`} />
                    <Input type="date" value={s.publishedAt} onChange={(e) => setSources(sources.map((x) => (x.key === s.key ? { ...x, publishedAt: e.target.value } : x)))} className="h-8" aria-label={`Source ${i + 1} publication date`} />
                  </div>
                  <Textarea value={s.text} onChange={(e) => setSources(sources.map((x) => (x.key === s.key ? { ...x, text: e.target.value } : x)))} rows={3} maxLength={30000} placeholder="Paste the source text. Claims are only checked against text you provide here." aria-label={`Source ${i + 1} text`} />
                  {s.provider && <p className="mt-1 text-[11px] text-faint">From {s.provider} search — snippet only, not the full page.</p>}
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Select value={mode} onChange={(e) => setMode(e.target.value as "rules" | "model")} aria-label="Checking mode">
                  <option value="rules">Rules only (free, reproducible)</option>
                  <option value="model">Rules + model judgement</option>
                </Select>
                {mode === "model" && <ModelPicker value={modelId} onChange={setPicked} models={models} />}
              </div>
              <Button onClick={analyze} loading={busy} disabled={answer.trim().length < 10}>
                <FileSearch className="h-4 w-4" /> Analyse claims
              </Button>
            </div>
            {mode === "model" && (
              <p className="text-xs text-faint">The model judges each claim against the sources, but a judgement only counts if its quote is found word-for-word in the source text. Uses one model call.</p>
            )}
            {error && <Notice tone="danger">{error}</Notice>}
          </Card>
          <HistoryList items={history} onOpen={open} onRemove={removeReport} guest={!user} />
        </div>
      ) : (
        <ReportView
          report={report}
          notices={notices}
          error={error}
          selected={claim}
          onSelect={setSelected}
          workflow={workflow}
          setWorkflow={setWorkflow}
          onInspect={setInspect}
          onReview={review}
          onBack={() => setReport(null)}
        />
      )}

      {report && inspect && <SourceInspector source={report.sources.find((s) => s.id === inspect.sourceId)!} quote={inspect.quote} onClose={() => setInspect(null)} />}
    </div>
  );
}

function HistoryList({ items, onOpen, onRemove, guest }: { items: { id: string; question: string; created_at: string; summary?: { headline?: string } }[]; onOpen: (id: string) => void; onRemove: (id: string) => void; guest: boolean }) {
  return (
    <Card className="h-fit p-4">
      <div className="mb-2 text-sm font-medium">Recent reports</div>
      {guest && <p className="mb-2 text-xs text-faint">Saved in this browser only. Sign in to keep reports in your account.</p>}
      {items.length === 0 ? (
        <p className="text-sm text-faint">No reports yet.</p>
      ) : (
        <ul className="space-y-1">
          {items.slice(0, 12).map((r) => (
            <li key={r.id} className="group flex items-start gap-1">
              <button type="button" onClick={() => onOpen(r.id)} className="min-w-0 flex-1 rounded-lg px-2 py-1.5 text-left hover:bg-panel-2">
                <div className="truncate text-sm">{r.question || "Untitled analysis"}</div>
                <div className="text-[11px] text-faint">{relativeTime(r.created_at)}</div>
              </button>
              <Button variant="ghost" size="icon" className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" aria-label="Delete report" onClick={() => onRemove(r.id)}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const WORKFLOWS: { id: Workflow; label: string; help: string }[] = [
  { id: "queue", label: "Fact-check queue", help: "Every claim, most problematic first." },
  { id: "unsupported", label: "Unsupported", help: "Stated as fact, but nothing in the sources addresses it." },
  { id: "conflicts", label: "Conflicts", help: "Sources disagree with the claim or with each other." },
  { id: "missing", label: "Missing evidence", help: "What evidence would settle it, with suggested searches." },
  { id: "inference", label: "Direct vs inference", help: "What sources say vs. what the AI concluded." },
  { id: "miscited", label: "Mis-citations", help: "The cited source does not appear to contain the claim." },
];

function ReportView(props: {
  report: ClaimReport;
  notices: string[];
  error: string | null;
  selected: Claim | null;
  onSelect: (id: string) => void;
  workflow: Workflow;
  setWorkflow: (w: Workflow) => void;
  onInspect: (v: { sourceId: string; quote?: string }) => void;
  onReview: (l: EvidenceLink, s: Stance) => void;
  onBack: () => void;
}) {
  const { report, selected } = props;
  const s = report.summary;
  const lists = useMemo(() => {
    const d = directVsInference(report.claims);
    return {
      queue: factCheckQueue(report.claims),
      unsupported: unsupportedStatements(report.claims),
      conflicts: conflicts(report.claims).map((c) => c.claim),
      missing: missingEvidence(report.claims).map((m) => m.claim),
      inference: [...d.direct, ...d.inference, ...d.unbacked],
      miscited: misCitations(report.claims).map((m) => m.claim),
    };
  }, [report]);
  const missing = useMemo(() => new Map(missingEvidence(report.claims).map((m) => [m.claim.id, m])), [report]);
  const shown = lists[props.workflow];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={props.onBack}>← New analysis</Button>
        <div className="flex flex-wrap gap-2">
          <Link href={`/claims/arena?report=${report.id}`} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-xs hover:bg-panel-2"><Scale className="h-3.5 w-3.5" /> Compare explanations</Link>
          <Link href={`/claims/replay?report=${report.id}`} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-xs hover:bg-panel-2"><History className="h-3.5 w-3.5" /> Replay this analysis</Link>
        </div>
      </div>

      <Card className="p-4">
        <div className="text-xs uppercase tracking-wider text-faint">{report.question || "Analysis"}</div>
        <p className="mt-1 text-sm">{s.headline}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {(Object.keys(STATUS_META) as (keyof typeof STATUS_META)[]).map((k) => (s.byStatus[k] ? <span key={k} className="inline-flex items-center gap-1"><StatusBadge status={k} /><span className="text-xs tabular-nums text-muted">{s.byStatus[k]}</span></span> : null))}
        </div>
        <div className="mt-3 space-y-2">
          {s.snippetOnly && <Notice tone="warning" title="Checked against snippets only">The sources are search snippets, not full documents. Claims may be supported or contradicted by parts of the pages NOVA never saw.</Notice>}
          {report.sources.length === 0 && <Notice tone="warning" title="No sources">Without source text every factual claim shows as “No evidence found”. That says nothing about whether the claims are true.</Notice>}
          {props.notices.map((n) => <Notice key={n} tone="info">{n}</Notice>)}
          {props.error && <Notice tone="danger">{props.error}</Notice>}
        </div>
        <details className="mt-3 text-xs text-muted">
          <summary className="cursor-pointer text-accent">How to read this</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Statuses describe the relationship between a claim and the sources you supplied — not whether the claim is true.</li>
            <li>Every judgement says who made it: keyword rules, a model (counted only when its quote is verified in the source), or you.</li>
            <li>“Evidence match” is a heuristic shown as a band. Its formula is visible and it is never a probability of truth.</li>
            <li>Limitations are listed on every claim. Open any source to read the passage in context.</li>
          </ul>
        </details>
      </Card>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="space-y-4">
          <Card className="p-4">
            <div className="mb-2 text-sm font-medium">Answer, claim by claim</div>
            <AnnotatedAnswer report={report} selectedId={selected?.id ?? null} onSelect={props.onSelect} />
          </Card>
          <Card className="p-4">
            <div className="mb-2 text-sm font-medium">Sources</div>
            <ul className="space-y-2">
              {report.sources.map((src) => (
                <li key={src.id}>
                  <button type="button" onClick={() => props.onInspect({ sourceId: src.id })} className="w-full rounded-lg border border-border px-3 py-2 text-left hover:bg-panel-2">
                    <div className="flex items-center gap-2 text-sm"><Badge>[{src.index}]</Badge><span className="truncate">{src.title}</span></div>
                    <div className="mt-1 flex flex-wrap gap-1.5 text-[11px] text-faint">
                      <span>{src.publisher}</span>·<span>{src.reliability.sourceType.replace("_", " ")}</span>·<span>{src.publishedAt ? src.publishedAt.slice(0, 10) : "undated"}</span>·<span>{src.contentKind.replace("_", " ")}</span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <div className="space-y-4">
          <div className="flex gap-1 overflow-x-auto rounded-xl border border-border bg-panel p-1" role="tablist" aria-label="Workflows">
            {WORKFLOWS.map((w) => (
              <button key={w.id} role="tab" aria-selected={props.workflow === w.id} title={w.help} onClick={() => props.setWorkflow(w.id)} className={cn("shrink-0 rounded-lg px-2.5 py-1.5 text-xs", props.workflow === w.id ? "bg-accent-soft text-fg" : "text-muted hover:text-fg")}>
                {w.label} <span className="tabular-nums text-faint">{lists[w.id].length}</span>
              </button>
            ))}
          </div>
          <p className="text-xs text-faint">{WORKFLOWS.find((w) => w.id === props.workflow)!.help}</p>

          {selected ? (
            <ClaimDetail claim={selected} report={report} missing={missing.get(selected.id)} onInspect={props.onInspect} onReview={props.onReview} onClose={() => props.onSelect("")} />
          ) : shown.length === 0 ? (
            <EmptyState title="Nothing here">No claims fall into this category.</EmptyState>
          ) : (
            <ul className="space-y-2">
              {shown.map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => props.onSelect(c.id)} className="w-full rounded-xl border border-border bg-panel p-3 text-left hover:border-border-strong">
                    <div className="flex flex-wrap items-center gap-1.5"><span className="font-mono text-[11px] text-faint">{c.id}</span><StatusBadge status={c.assessment.status} /><BasisBadge basis={c.assessment.basis} />{c.hedged && <Badge>hedged</Badge>}</div>
                    <p className="mt-1.5 text-sm">{c.text}</p>
                    {props.workflow === "missing" && missing.get(c.id) && <p className="mt-1 text-xs text-muted">Needed: {missing.get(c.id)!.need}</p>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function AnnotatedAnswer({ report, selectedId, onSelect }: { report: ClaimReport; selectedId: string | null; onSelect: (id: string) => void }) {
  const text = normalizeAnswer(report.answer);
  const parts: ReactNode[] = [];
  let pos = 0;
  for (const c of [...report.claims].sort((a, b) => a.span.start - b.span.start)) {
    if (c.span.start > pos) parts.push(<span key={`t${pos}`} className="text-faint">{text.slice(pos, c.span.start)}</span>);
    const m = STATUS_META[c.assessment.status];
    parts.push(
      <button
        key={c.id}
        type="button"
        onClick={() => onSelect(c.id)}
        title={`${c.id}: ${m.label}`}
        className={cn("rounded px-0.5 text-left underline decoration-2 underline-offset-4", selectedId === c.id ? "bg-accent-soft" : "hover:bg-panel-2", {
          "decoration-success/70": c.assessment.status === "supported",
          "decoration-accent/70": c.assessment.status === "partially_supported",
          "decoration-warning/80": c.assessment.status === "contested",
          "decoration-danger/80": c.assessment.status === "contradicted",
          "decoration-dotted decoration-faint": c.assessment.status === "insufficient",
          "decoration-transparent": c.assessment.status === "not_checkable",
        })}
      >
        {text.slice(c.span.start, c.span.end)}
      </button>,
    );
    pos = c.span.end;
  }
  if (pos < text.length) parts.push(<span key="tail" className="text-faint">{text.slice(pos)}</span>);
  return <div className="whitespace-pre-wrap text-sm leading-7">{parts}</div>;
}

function ClaimDetail({ claim, report, missing, onInspect, onReview, onClose }: { claim: Claim; report: ClaimReport; missing?: ReturnType<typeof missingEvidence>[number]; onInspect: (v: { sourceId: string; quote?: string }) => void; onReview: (l: EvidenceLink, s: Stance) => void; onClose: () => void }) {
  const a = claim.assessment;
  const srcById = new Map(report.sources.map((s) => [s.id, s]));
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-xs text-faint">{claim.id}</span>
          <StatusBadge status={a.status} />
          <BasisBadge basis={a.basis} />
          <Badge>{claim.kind}</Badge>
          <Badge>{claim.origin === "cited" ? "cited in answer" : claim.origin === "ai_inference" ? "labelled as inference" : "uncited"}</Badge>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Back to list"><X className="h-4 w-4" /></Button>
      </div>
      <p className="mt-2 text-[15px]">{claim.text}</p>
      <ul className="mt-2 space-y-0.5 text-sm text-muted">{a.explanation.map((e) => <li key={e}>{e}</li>)}</ul>

      {a.limitations.length > 0 && (
        <div className="mt-3 rounded-xl border border-warning/25 bg-warning/[0.06] p-3">
          <div className="flex items-center gap-1.5 text-xs font-medium text-warning"><AlertTriangle className="h-3.5 w-3.5" /> Limitations of this check</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-muted">{a.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
        </div>
      )}

      <div className="mt-3"><EstimateMeter estimate={a.estimate} /></div>

      <div className="mt-4 text-sm font-medium">Evidence ({claim.evidence.length})</div>
      {claim.evidence.length === 0 && <p className="mt-1 text-sm text-faint">No source passage was relevant enough to link.</p>}
      <ul className="mt-2 space-y-2">
        {claim.evidence.map((l) => {
          const src = srcById.get(l.sourceId);
          return (
            <li key={l.id} className="rounded-xl border border-border bg-bg-elev p-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <StanceBadge stance={l.stance} />
                <JudgedByBadge by={l.judgedBy} />
                <Badge>{l.directness}</Badge>
                {l.cited && <Badge tone="accent">cited</Badge>}
                <span className="text-[11px] text-faint">term overlap {Math.round(l.relevance * 100)}%</span>
              </div>
              <button type="button" onClick={() => onInspect({ sourceId: l.sourceId, quote: l.quoteVerified ? l.quote : undefined })} className="mt-2 block w-full text-left">
                <blockquote className={cn("border-l-2 pl-3 text-sm", l.quoteVerified ? "border-accent/50 text-fg" : "border-danger/50 text-muted line-through decoration-danger/40")}>“{l.quote}”</blockquote>
                <div className="mt-1 flex items-center gap-1 text-[11px] text-faint">
                  [{src?.index}] {src?.title} · {l.quoteVerified ? "quote found in source" : "quote NOT found in source"} · <span className="text-accent">inspect source</span>
                </div>
              </button>
              <p className="mt-2 text-xs text-muted">{l.rationale}</p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-faint">
                Your review:
                {(["supports", "contradicts", "insufficient"] as Stance[]).map((s) => (
                  <button key={s} type="button" onClick={() => onReview(l, s)} className={cn("rounded-md border px-1.5 py-0.5", l.judgedBy === "user" && l.stance === s ? "border-accent text-accent" : "border-border hover:text-fg")}>
                    {s === "supports" ? "Supports" : s === "contradicts" ? "Conflicts" : "Doesn't settle it"}
                  </button>
                ))}
              </div>
            </li>
          );
        })}
      </ul>

      {missing && (
        <div className="mt-4 rounded-xl border border-border p-3">
          <div className="text-xs font-medium">Evidence that would help</div>
          <p className="mt-1 text-xs text-muted">{missing.need}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {missing.queries.map((q) => (
              <Link key={q} href={`/search?q=${encodeURIComponent(q)}`} className="rounded-md border border-border px-2 py-0.5 text-xs text-accent hover:bg-panel-2">Search: {q}</Link>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function SourceInspector({ source, quote, onClose }: { source: SourceRecord; quote?: string; onClose: () => void }) {
  const idx = quote ? source.text.indexOf(quote.replace(/…$/, "")) : -1;
  const q = quote?.replace(/…$/, "") ?? "";
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" role="dialog" aria-modal="true" aria-label="Source inspector" onClick={onClose}>
      <div className="h-full w-full max-w-xl overflow-y-auto border-l border-border bg-bg p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-2">
          <div>
            <Badge>[{source.index}]</Badge>
            <h2 className="mt-1 text-lg font-semibold">{source.title}</h2>
            <div className="text-xs text-faint">{source.publisher}{source.author ? ` · ${source.author}` : ""}</div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></Button>
        </div>
        {source.url && isSafeHttpUrl(source.url) && (
          <a href={source.url} target="_blank" rel="noopener noreferrer nofollow" className="mt-2 inline-flex items-center gap-1 text-sm text-accent hover:underline">
            Open original <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
        <dl className="mt-4 grid grid-cols-2 gap-2 text-xs">
          <div><dt className="text-faint">Type</dt><dd>{source.reliability.sourceType.replace("_", " ")}</dd></div>
          <div><dt className="text-faint">Published</dt><dd>{source.publishedAt ? source.publishedAt.slice(0, 10) : "Unknown"}</dd></div>
          <div><dt className="text-faint">Content read</dt><dd>{source.contentKind.replace("_", " ")} ({source.text.length} chars)</dd></div>
          <div><dt className="text-faint">Fingerprint</dt><dd className="font-mono">{source.contentHash}</dd></div>
        </dl>
        {source.reliability.flags.length > 0 && (
          <div className="mt-4">
            <div className="text-xs font-medium">Reliability indicators</div>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-muted">{source.reliability.flags.map((f) => <li key={f}>{f}</li>)}</ul>
            <p className="mt-1 text-[11px] text-faint">Indicators are observable facts, not a reliability score. Judge the source yourself.</p>
          </div>
        )}
        <div className="mt-4">
          <div className="text-xs font-medium">Provenance</div>
          <ol className="mt-1 space-y-1 border-l border-border pl-3 text-xs text-muted">
            {source.provenance.map((p, i) => <li key={i}><span className="text-faint">{p.actor}</span> — {p.action}{p.detail ? <span className="block truncate font-mono text-[10px] text-faint">{p.detail}</span> : null}</li>)}
          </ol>
        </div>
        <div className="mt-4">
          <div className="text-xs font-medium">Text NOVA checked against</div>
          <div className="mt-1 whitespace-pre-wrap rounded-xl border border-border bg-bg-elev p-3 text-sm leading-6">
            {idx >= 0 ? (
              <>
                {source.text.slice(0, idx)}
                <mark className="rounded bg-accent/25 text-fg">{source.text.slice(idx, idx + q.length)}</mark>
                {source.text.slice(idx + q.length)}
              </>
            ) : (
              source.text
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
