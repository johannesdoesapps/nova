"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, BookOpenCheck, ChevronDown, ChevronRight, Download, ExternalLink, FileText, Loader2, Printer, RotateCcw, Square, Telescope, Trash2 } from "lucide-react";
import { useApp } from "@/components/layout/app-context";
import { StudioHeader } from "@/components/studio/frame";
import { api, CodeApiError, post } from "@/components/code/api";
import { Markdown } from "@/components/common/markdown";
import { StatusPill } from "@/components/review/bits";
import { ago } from "@/lib/home";
import { DEPTHS, type Depth } from "@/lib/research/research";
import type { ResearchView } from "@/lib/research/server";
import { cn } from "@/lib/utils";
import { LoadFailed } from "@/components/common/load-failed";

type Row = Pick<ResearchView, "id" | "question" | "depth" | "status" | "phase" | "created_at" | "usage">;

const EXAMPLES = [
  "Compare the pricing and free tiers of the three largest managed Postgres providers, with sources.",
  "What does current research say about the effect of a four-day work week on productivity?",
  "Which EU rules apply to selling a subscription app to consumers in Germany, and what do they require?",
];

const errorOf = (e: unknown) => (e instanceof CodeApiError ? e : new CodeApiError((e as Error).message, 0, null, null));

/** Deep Research's start page: the objective, depth and optional context, plus past runs. */
export function ResearchHome() {
  const { user } = useApp();
  const router = useRouter();
  const [question, setQuestion] = useState("");
  const [depth, setDepth] = useState<Depth>("standard");
  const [context, setContext] = useState("");
  const [showContext, setShowContext] = useState(false);
  const [runs, setRuns] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CodeApiError | null>(null);

  // Another agent can hand over a question (e.g. Threat Hunter's research hand-off): it's filled in, never started.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const q = p.get("q");
    const c = p.get("context");
    // Reading the address once after mount (it isn't available while rendering on the server).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (q) setQuestion(q.slice(0, 1000));
    if (c) {
      setContext(c.slice(0, 4000));
      setShowContext(true);
    }
  }, []);

  const [runsFailed, setRunsFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!user) return;
    let alive = true;
    api<{ runs: Row[] }>("/api/research")
      .then((r) => alive && (setRuns(r.runs), setRunsFailed(false)))
      .catch(() => alive && (setRuns([]), setRunsFailed(true)));
    return () => {
      alive = false;
    };
  }, [user, attempt]);

  const start = async () => {
    if (question.trim().length < 5 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ run: ResearchView }>("/api/research", { question: question.trim(), depth, context: context.trim() || null });
      router.push(`/research/${r.run.id}`);
    } catch (e) {
      setError(errorOf(e));
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm("Delete this research and its report?")) return;
    try {
      await api(`/api/research/${id}`, { method: "DELETE" });
      setRuns((rs) => rs?.filter((r) => r.id !== id) ?? null);
    } catch (e) {
      setError(errorOf(e));
    }
  };

  const header = (
    <StudioHeader>
      <h1 className="text-[14px] font-medium text-s-ink-2">Deep Research</h1>
    </StudioHeader>
  );

  if (!user) {
    return (
      <>
        {header}
        <div className="mx-auto max-w-[640px] px-4 py-16 text-center">
          <h2 className="font-serif text-[clamp(28px,4.5vw,40px)]">Research with sources you can check</h2>
          <p className="mt-3 text-[15px] text-s-ink-2">Orbis plans the research, searches the web question by question, and writes a report where every claim links to the passage it came from.</p>
          <Link href="/login?next=/research" className="mt-6 inline-flex h-10 items-center rounded-full bg-s-accent px-5 text-[14px] font-medium text-s-accent-ink">
            Sign in to start
          </Link>
        </div>
      </>
    );
  }

  return (
    <>
      {header}
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[880px] px-4 pb-24 pt-2 sm:px-8">
          <h2 className="font-serif text-[clamp(30px,5vw,40px)] leading-tight">Deep Research</h2>
          <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-s-ink-2">
            Orbis breaks your objective into questions, searches the web for each, and writes a report. Sources are only pages a passage was actually taken from, and you can read that passage next to
            each source.
          </p>

          <section aria-label="Start research" className="mt-6 s-card rounded-2xl p-4">
            <label htmlFor="rs-q" className="block text-[13px] font-medium">
              What do you want to find out?
            </label>
            <textarea
              id="rs-q"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="Describe the objective: what to compare, find or decide…"
              className="mt-1.5 block w-full resize-y rounded-xl border border-s-line bg-transparent p-3 text-[14px] outline-none placeholder:text-s-ink-3 focus:border-s-line-strong"
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {EXAMPLES.map((x) => (
                <button
                  key={x}
                  type="button"
                  onClick={() => setQuestion(x)}
                  className="rounded-full border border-s-line px-2.5 py-1 text-left text-[12px] text-s-ink-2 hover:border-s-line-strong hover:text-s-ink"
                >
                  {x.slice(0, 56)}…
                </button>
              ))}
            </div>
            <fieldset className="mt-4">
              <legend className="text-[13px] font-medium">Depth</legend>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {(Object.keys(DEPTHS) as Depth[]).map((d) => (
                  <label
                    key={d}
                    className={cn("flex min-h-10 cursor-pointer items-center gap-2 rounded-xl border px-3 py-1.5 text-[13px]", depth === d ? "border-s-line-strong bg-s-hover" : "border-s-line")}
                  >
                    <input type="radio" name="depth" value={d} checked={depth === d} onChange={() => setDepth(d)} />
                    <span>
                      <span className="font-medium">{DEPTHS[d].label}</span> <span className="text-s-ink-3">· {DEPTHS[d].hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <button
              type="button"
              onClick={() => setShowContext(!showContext)}
              aria-expanded={showContext}
              className="mt-4 inline-flex min-h-8 items-center gap-1 text-[13px] text-s-ink-2 hover:text-s-ink"
            >
              {showContext ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />} Add your own notes or a document (optional)
            </button>
            {showContext && (
              <>
                <label htmlFor="rs-ctx" className="sr-only">
                  Your notes or document
                </label>
                <textarea
                  id="rs-ctx"
                  value={context}
                  onChange={(e) => setContext(e.target.value)}
                  rows={6}
                  maxLength={60_000}
                  placeholder="Paste text the research should take into account. It's sent to the AI model with your request; it's cited as [doc]."
                  className="mt-1.5 block w-full resize-y rounded-xl border border-s-line bg-transparent p-3 text-[13.5px] outline-none placeholder:text-s-ink-3 focus:border-s-line-strong"
                />
              </>
            )}
            {error && (
              <p role="alert" className="mt-3 rounded-xl border border-s-danger/40 px-3 py-2 text-[13px] text-s-danger">
                {error.message}{" "}
                {(error.upgrade || error.details?.scope === "web_search") && (
                  <Link href="/pricing" className="underline">
                    See plans
                  </Link>
                )}
              </p>
            )}
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void start()}
                disabled={question.trim().length < 5 || busy}
                className="inline-flex h-10 items-center gap-2 rounded-full bg-s-accent px-5 text-[14px] font-medium text-s-accent-ink transition hover:brightness-110 disabled:opacity-40"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Telescope className="h-4 w-4" aria-hidden />} Start research
              </button>
              <span className="text-[12px] text-s-ink-3">
                Uses Claude with web search. Each step is charged like a message of its size, and each question uses one of your plan&apos;s monthly web searches. A standard run takes a few minutes.
              </span>
            </div>
          </section>

          <section aria-labelledby="rs-history" className="mt-8">
            <h3 id="rs-history" className="text-[15px] font-medium">
              Your research
            </h3>
            {runs === null ? (
              <div className="s-skeleton mt-3 h-14 rounded-2xl" role="status" aria-label="Loading research" />
            ) : runsFailed ? (
              <LoadFailed
                what="your research"
                onRetry={() => {
                  setRuns(null);
                  setAttempt((a) => a + 1);
                }}
              />
            ) : runs.length === 0 ? (
              <p className="mt-2 text-[13.5px] text-s-ink-3">None yet. Each run is kept here with its report and sources.</p>
            ) : (
              <ul className="mt-3 flex flex-col gap-2">
                {runs.map((r) => (
                  <li key={r.id} className="flex items-center gap-3 s-card rounded-2xl px-3 py-2.5">
                    <Link href={`/research/${r.id}`} className="min-w-0 flex-1">
                      <span className="block truncate text-[14px]">{r.question}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-s-ink-3">
                        <StatusPill status={r.status} />
                        <span>{DEPTHS[r.depth].label}</span>
                        {!!r.usage.searches && <span>{r.usage.searches} searches</span>}
                        <time dateTime={r.created_at} suppressHydrationWarning>
                          {ago(r.created_at)}
                        </time>
                      </span>
                    </Link>
                    <button
                      type="button"
                      onClick={() => void remove(r.id)}
                      aria-label={`Delete research: ${r.question.slice(0, 60)}`}
                      title="Delete"
                      className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-s-ink-3 hover:bg-s-hover hover:text-s-danger"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </>
  );
}

const PHASE_LABEL: Record<ResearchView["phase"], string> = { planning: "Planning the research", researching: "Searching", writing: "Writing the report", done: "Done" };

/** One run: progress while it works (the page drives it step by step), then the report with linked citations. */
export function ResearchDetail({ id }: { id: string }) {
  const [run, setRun] = useState<ResearchView | null>(null);
  const [error, setError] = useState<CodeApiError | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const driving = useRef(false);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const r = await api<{ run: ResearchView }>(`/api/research/${id}`);
      setRun(r.run);
      return r.run;
    } catch (e) {
      setError(errorOf(e));
      return null;
    }
  }, [id]);

  const drive = useCallback(async () => {
    if (driving.current) return;
    driving.current = true;
    try {
      let cur = await load();
      while (alive.current && cur?.status === "running") {
        if (cur.busy) {
          await new Promise((r) => setTimeout(r, 4000));
          cur = await load();
          continue;
        }
        try {
          cur = (await post<{ run: ResearchView }>(`/api/research/${id}/step`, {})).run;
          if (alive.current) setRun(cur);
        } catch (e) {
          if (alive.current) setError(errorOf(e));
          break;
        }
      }
    } finally {
      driving.current = false;
    }
  }, [id, load]);

  useEffect(() => {
    alive.current = true;
    void drive();
    return () => {
      alive.current = false;
    };
  }, [drive]);

  const act = async (path: "cancel" | "resume", body: Record<string, unknown> = {}) => {
    setError(null);
    try {
      setRun((await post<{ run: ResearchView }>(`/api/research/${id}/${path}`, body)).run);
      if (path === "resume") void drive();
    } catch (e) {
      setError(errorOf(e));
    }
  };

  const showSource = (n: number) => {
    setActive(n);
    document.getElementById(`src-${n}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    (document.getElementById(`src-${n}`) as HTMLElement | null)?.focus({ preventScroll: true });
  };

  const header = (
    <StudioHeader>
      <Link href="/research" className="inline-flex items-center gap-1 text-[13px] text-s-ink-2 hover:text-s-ink">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Deep Research
      </Link>
    </StudioHeader>
  );

  if (!run) {
    return (
      <>
        {header}
        <div className="mx-auto w-full max-w-[880px] px-4 pt-6 sm:px-8">
          {error ? (
            <p role="alert" className="rounded-xl border border-s-danger/40 px-3 py-2 text-[13px] text-s-danger">
              {error.message}
            </p>
          ) : (
            <div className="s-skeleton h-32 rounded-2xl" role="status" aria-label="Loading the research" />
          )}
        </div>
      </>
    );
  }

  const total = run.plan?.questions.length ?? DEPTHS[run.depth].questions;
  const steps = 2 + total;
  const doneSteps = run.phase === "planning" ? 0 : run.phase === "researching" ? 1 + run.next_question : run.phase === "writing" ? 1 + total : steps;
  const cited = new Set(run.report_check?.cited ?? []);
  const shownSources = run.report ? run.sources.filter((s) => cited.has(s.n)) : run.sources;
  const otherSources = run.report ? run.sources.filter((s) => !cited.has(s.n)) : [];

  return (
    <>
      {header}
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[880px] px-4 pb-24 pt-2 sm:px-8">
          <h1 className="break-words text-[22px] font-semibold leading-snug">{run.question}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-s-ink-3">
            <StatusPill status={run.status} />
            <span>{DEPTHS[run.depth].label}</span>
            {run.usage.modelName && (
              <span>
                {run.usage.searchModelName && run.usage.searchModelName !== run.usage.modelName ? `${run.usage.searchModelName} searched · ${run.usage.modelName} wrote` : run.usage.modelName}
              </span>
            )}
            {!!run.usage.searches && <span>{run.usage.searches} web searches</span>}
            {run.hasContext && <span>with your document</span>}
          </p>
          <p role="status" className="sr-only">
            {run.status === "running" ? PHASE_LABEL[run.phase] : run.status === "completed" ? "Research finished. The report is below." : `Research ${run.status}`}
          </p>

          {run.status === "running" && (
            <div className="mt-4 s-card rounded-2xl p-3">
              <div className="flex flex-wrap items-center gap-3 text-[13.5px]">
                <Loader2 className="h-4 w-4 animate-spin text-s-ink-2" aria-hidden />
                <span className="min-w-0 flex-1">
                  {PHASE_LABEL[run.phase]}
                  {run.phase === "researching" && run.plan ? ` — question ${run.next_question + 1} of ${total}: ${run.plan.questions[run.next_question]}` : "…"}
                </span>
                {run.phase === "researching" && run.notes.length > 0 && !run.busy && (
                  <button
                    type="button"
                    onClick={() => void act("resume", { writeNow: true })}
                    className="inline-flex h-8 items-center gap-1.5 rounded-full border border-s-line px-3 text-[12.5px] text-s-ink-2 hover:text-s-ink"
                  >
                    <FileText className="h-3 w-3" aria-hidden /> Write the report now
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void act("cancel")}
                  className="inline-flex h-8 items-center gap-1.5 rounded-full border border-s-line px-3 text-[12.5px] text-s-ink-2 hover:border-s-danger hover:text-s-danger"
                >
                  <Square className="h-3 w-3" aria-hidden /> Stop
                </button>
              </div>
              <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-s-hover" aria-hidden>
                <div className="h-full rounded-full bg-s-accent transition-all" style={{ width: `${Math.round((doneSteps / steps) * 100)}%` }} />
              </div>
              <p className="mt-2 text-[12px] text-s-ink-3">Each question takes about a minute while Claude searches and reads. You can leave this page; come back to continue.</p>
            </div>
          )}
          {(run.status === "failed" || run.status === "cancelled") && (
            <div
              className={cn(
                "mt-4 flex flex-wrap items-center gap-3 rounded-2xl border px-3 py-2.5 text-[13.5px]",
                run.status === "failed" ? "border-s-danger/40 text-s-danger" : "border-s-line text-s-ink-2",
              )}
            >
              <span className="min-w-0 flex-1">{run.status === "failed" ? (run.error ?? "The research stopped with an error.") : "You stopped this research."}</span>
              {run.phase !== "done" && (
                <button
                  type="button"
                  onClick={() => void act("resume")}
                  className="inline-flex h-8 items-center gap-1.5 rounded-full border border-s-line px-3 text-[12.5px] text-s-ink hover:border-s-line-strong"
                >
                  <RotateCcw className="h-3 w-3" aria-hidden /> Continue
                </button>
              )}
              {run.notes.length > 0 && !run.report && (
                <button
                  type="button"
                  onClick={() => void act("resume", { writeNow: true })}
                  className="inline-flex h-8 items-center gap-1.5 rounded-full border border-s-line px-3 text-[12.5px] text-s-ink hover:border-s-line-strong"
                >
                  <FileText className="h-3 w-3" aria-hidden /> Write the report from what was found
                </button>
              )}
            </div>
          )}
          {error && (
            <p role="alert" className="mt-3 rounded-xl border border-s-danger/40 px-3 py-2 text-[13px] text-s-danger">
              {error.message}
            </p>
          )}

          {run.plan && (
            <section aria-labelledby="rs-plan" className="mt-5 s-card rounded-2xl p-3.5">
              <h2 id="rs-plan" className="text-[14px] font-medium">
                Research plan
              </h2>
              {run.plan.approach && <p className="mt-1 text-[13px] text-s-ink-2">{run.plan.approach}</p>}
              <ol className="mt-2 space-y-1.5 text-[13.5px]">
                {run.plan.questions.map((q, i) => {
                  const n = run.notes[i];
                  const state = n ? "done" : run.status === "running" && run.phase === "researching" && i === run.next_question ? "now" : "todo";
                  return (
                    <li key={i} className="flex gap-2">
                      <span
                        className={cn(
                          "mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[11px]",
                          state === "done" ? "border-emerald-600/60 text-emerald-700 dark:text-emerald-400" : state === "now" ? "border-s-line-strong" : "border-s-line text-s-ink-3",
                        )}
                      >
                        {state === "now" ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : i + 1}
                      </span>
                      <span className="min-w-0">
                        {q}
                        {n && (
                          <span className="block text-[12px] text-s-ink-3">
                            {n.searches} search{n.searches === 1 ? "" : "es"}
                            {n.queries.length
                              ? `: ${n.queries
                                  .slice(0, 3)
                                  .map((x) => `“${x}”`)
                                  .join(", ")}`
                              : ""}
                          </span>
                        )}
                        <span className="sr-only">{state === "done" ? " (done)" : state === "now" ? " (in progress)" : " (not started)"}</span>
                      </span>
                    </li>
                  );
                })}
              </ol>
            </section>
          )}

          {run.report && (
            <section aria-labelledby="rs-report" className="mt-6">
              <div className="flex flex-wrap items-center gap-2">
                <h2 id="rs-report" className="mr-auto text-[17px] font-semibold">
                  Report
                </h2>
                <a href={`/api/research/${id}/export`} className="inline-flex h-9 items-center gap-1.5 rounded-full border border-s-line px-3 text-[12.5px] text-s-ink-2 hover:text-s-ink">
                  <Download className="h-3.5 w-3.5" aria-hidden /> Markdown
                </a>
                <a
                  href={`/research-print/${id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-9 items-center gap-1.5 rounded-full border border-s-line px-3 text-[12.5px] text-s-ink-2 hover:text-s-ink"
                >
                  <Printer className="h-3.5 w-3.5" aria-hidden /> Print or save as PDF
                </a>
              </div>
              {run.report_check && <SupportNote check={run.report_check} sources={run.sources.length} />}
              <div className="mt-3 s-card rounded-2xl p-4 sm:p-5">
                <Markdown text={run.report} onCitation={showSource} validCitations={new Set(run.sources.map((s) => s.n))} className="s-prose text-[15px]" />
              </div>
            </section>
          )}

          {run.sources.length > 0 && (
            <section aria-labelledby="rs-sources" className="mt-6">
              <h2 id="rs-sources" className="text-[17px] font-semibold">
                Sources {run.report ? `cited (${shownSources.length})` : `found so far (${run.sources.length})`}
              </h2>
              <p className="mt-1 text-[12.5px] text-s-ink-3">Each source is a page the search returned and a passage was taken from; the quotes are those passages, word for word.</p>
              <ol className="mt-3 space-y-2">
                {shownSources.map((s) => (
                  <SourceItem key={s.n} s={s} active={active === s.n} />
                ))}
              </ol>
              {otherSources.length > 0 && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-[13px] text-s-ink-2">Also used in the research notes but not cited in the report ({otherSources.length})</summary>
                  <ol className="mt-2 space-y-2">
                    {otherSources.map((s) => (
                      <SourceItem key={s.n} s={s} active={active === s.n} />
                    ))}
                  </ol>
                </details>
              )}
            </section>
          )}

          {run.notes.length > 0 && (
            <details className="mt-6 s-card rounded-2xl p-3.5">
              <summary className="cursor-pointer text-[14px] font-medium">Research notes ({run.notes.length})</summary>
              <div className="mt-3 space-y-5">
                {run.notes.map((n, i) => (
                  <div key={i}>
                    <h3 className="text-[14px] font-medium">
                      {i + 1}. {n.question}
                    </h3>
                    <Markdown text={n.text || "_Nothing was found._"} onCitation={showSource} validCitations={new Set(run.sources.map((s) => s.n))} className="s-prose mt-1 text-[14px]" />
                  </div>
                ))}
              </div>
            </details>
          )}

          <ActivityLog log={run.log} />
        </div>
      </div>
    </>
  );
}

function SupportNote({ check, sources }: { check: NonNullable<ResearchView["report_check"]>; sources: number }) {
  const parts = [`Cites ${check.cited.length} of ${sources} sources`];
  if (check.findingParagraphs)
    parts.push(
      check.uncitedParagraphs ? `${check.findingParagraphs - check.uncitedParagraphs} of ${check.findingParagraphs} findings paragraphs have a citation` : "every findings paragraph has a citation",
    );
  if (check.invalidRemoved) parts.push(`${check.invalidRemoved} citation${check.invalidRemoved === 1 ? "" : "s"} to sources that don't exist ${check.invalidRemoved === 1 ? "was" : "were"} removed`);
  return (
    <p
      className={cn(
        "mt-2 flex items-start gap-2 rounded-xl border px-3 py-2 text-[12.5px]",
        check.uncitedParagraphs || check.invalidRemoved ? "border-amber-500/40 text-s-ink-2" : "border-s-line text-s-ink-2",
      )}
    >
      <BookOpenCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>{parts.join(" · ")}. AI-written from the sources below: open a source to check an important claim.</span>
    </p>
  );
}

function SourceItem({ s, active }: { s: ResearchView["sources"][number]; active: boolean }) {
  return (
    <li id={`src-${s.n}`} tabIndex={-1} className={cn("rounded-xl border p-3 outline-none transition-colors", active ? "border-s-line-strong bg-s-hover" : "border-s-line")}>
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 font-mono text-[12px] text-s-ink-3">[{s.n}]</span>
        <div className="min-w-0 flex-1">
          <a href={s.url} target="_blank" rel="noreferrer noopener" className="inline-flex max-w-full items-center gap-1 text-[14px] font-medium underline-offset-2 hover:underline">
            <span className="truncate">{s.title}</span> <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
          </a>
          <p className="text-[12px] text-s-ink-3">
            {s.domain}
            {s.pageAge ? ` · ${s.pageAge}` : ""}
          </p>
          {s.quotes.map((q, i) => (
            <blockquote key={i} className="mt-1.5 border-l-2 border-s-line-strong pl-2.5 text-[12.5px] italic leading-relaxed text-s-ink-2">
              “{q}”
            </blockquote>
          ))}
        </div>
      </div>
    </li>
  );
}

function ActivityLog({ log }: { log: ResearchView["log"] }) {
  const [open, setOpen] = useState(false);
  if (!log.length) return null;
  return (
    <section className="mt-6 s-card rounded-2xl">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[13.5px]">
        {open ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
        What Orbis did <span className="text-s-ink-3">({log.length} steps)</span>
      </button>
      {open && (
        <ol className="space-y-1.5 border-t border-s-line px-3 py-2.5 text-[12.5px]">
          {log.map((l, i) => (
            <li key={i} className={cn("flex gap-2", l.kind === "error" ? "text-s-danger" : l.kind === "warning" ? "text-amber-700 dark:text-amber-400" : "text-s-ink-2")}>
              <time dateTime={l.at} className="shrink-0 tabular-nums text-s-ink-3" suppressHydrationWarning>
                {new Date(l.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </time>
              <span>{l.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
