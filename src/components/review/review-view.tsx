"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, ChevronDown, ChevronRight, ExternalLink, FileSearch, Loader2, RotateCcw, Square, Undo2, Wrench, X } from "lucide-react";
import { StudioHeader } from "@/components/studio/frame";
import { api, CodeApiError, post } from "@/components/code/api";
import { FileDiff } from "@/components/code/diff-view";
import { CATEGORIES, CATEGORY_LABEL, CONFIDENCE_LABEL, fixTask, SEVERITIES, type Category, type Finding, type Severity } from "@/lib/review/review";
import type { ReviewView as Review } from "@/lib/review/server";
import { cn } from "@/lib/utils";
import { SeverityBadge, SeverityCounts, StatusPill } from "./bits";

/**
 * One review: progress while it runs (the page drives it one part at a time), then the findings, most
 * important first, with filters. Each finding shows its evidence line, why it matters, how sure Orbis is,
 * and a suggested fix as a diff when one could be checked against the file. "Fix with the coding agent"
 * hands it to the agent in a Code project, with plan approval and edit review on.
 */
export function ReviewDetail({ id }: { id: string }) {
  const router = useRouter();
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<CodeApiError | null>(null);
  const [sev, setSev] = useState<Set<Severity>>(new Set(SEVERITIES));
  const [cat, setCat] = useState<Category | "all">("all");
  const [showClosed, setShowClosed] = useState(false);
  const [fixing, setFixing] = useState<string | null>(null);
  const driving = useRef(false);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const r = await api<{ review: Review }>(`/api/review/${id}`);
      setReview(r.review);
      return r.review;
    } catch (e) {
      setError(e instanceof CodeApiError ? e : new CodeApiError((e as Error).message, 0, null, null));
      return null;
    }
  }, [id]);

  // While the review runs, ask for the next part until it's done; another tab holding a step just means waiting.
  const drive = useCallback(async () => {
    if (driving.current) return;
    driving.current = true;
    try {
      let cur = await load();
      while (alive.current && cur?.status === "running") {
        if (cur.busy) {
          await new Promise((r) => setTimeout(r, 3000));
          cur = await load();
          continue;
        }
        try {
          const r = await post<{ review: Review }>(`/api/review/${id}/step`, {});
          cur = r.review;
          if (alive.current) setReview(cur);
        } catch (e) {
          if (alive.current) setError(e instanceof CodeApiError ? e : new CodeApiError((e as Error).message, 0, null, null));
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

  const act = async (path: string) => {
    setError(null);
    try {
      const r = await post<{ review: Review }>(`/api/review/${id}/${path}`, {});
      setReview(r.review);
      if (path === "retry") void drive();
    } catch (e) {
      setError(e instanceof CodeApiError ? e : null);
    }
  };

  const setStatus = async (f: Finding, status: Finding["status"]) => {
    try {
      const r = await api<{ review: Review }>(`/api/review/${id}/findings/${f.id}`, { method: "PATCH", body: JSON.stringify({ status }) });
      setReview(r.review);
    } catch (e) {
      setError(e instanceof CodeApiError ? e : null);
    }
  };

  const fixWithAgent = async (f: Finding) => {
    setFixing(f.id);
    setError(null);
    try {
      const { projectId } = await post<{ projectId: string }>(`/api/review/${id}/project`, {});
      const run = await post<{ run: { id: string } }>(`/api/code/projects/${projectId}/agent`, { request: fixTask(f), options: { approvePlans: true, reviewEdits: true, commands: "safe" } });
      router.push(`/code/${projectId}?run=${run.run.id}`);
    } catch (e) {
      setError(e instanceof CodeApiError ? e : new CodeApiError((e as Error).message, 0, null, null));
      setFixing(null);
    }
  };

  const shown = useMemo(
    () => (review?.findings ?? []).filter((f) => sev.has(f.severity) && (cat === "all" || f.category === cat) && (showClosed || f.status === "open")),
    [review, sev, cat, showClosed],
  );
  const closed = (review?.findings ?? []).filter((f) => f.status !== "open").length;

  const header = (
    <StudioHeader>
      <Link href="/review" className="inline-flex items-center gap-1 text-[13px] text-s-ink-2 hover:text-s-ink">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Code Review
      </Link>
    </StudioHeader>
  );

  if (!review) {
    return (
      <>
        {header}
        <div className="mx-auto w-full max-w-[880px] px-4 pt-6 sm:px-8">
          {error ? (
            <p role="alert" className="rounded-xl border border-s-danger/40 px-3 py-2 text-[13px] text-s-danger">
              {error.message}
            </p>
          ) : (
            <div className="s-skeleton h-32 rounded-2xl" role="status" aria-label="Loading the review" />
          )}
        </div>
      </>
    );
  }

  const total = review.chunks.length;
  const done = Math.min(review.next_chunk, total);

  return (
    <>
      {header}
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[880px] px-4 pb-24 pt-2 sm:px-8">
          <h1 className="break-words text-[22px] font-semibold leading-snug">{review.title}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-s-ink-3">
            <StatusPill status={review.status} />
            <span>
              {review.source.url ? (
                <a href={review.source.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline-offset-2 hover:underline">
                  {review.source.label} <ExternalLink className="h-3 w-3" aria-hidden />
                </a>
              ) : (
                review.source.label
              )}
            </span>
            <span>{review.fileCount} files</span>
            {review.usage.modelName && <span>Reviewed by {review.usage.modelName}</span>}
            {!!review.usage.modelCalls && <span>{((review.usage.inputTokens ?? 0) + (review.usage.outputTokens ?? 0)).toLocaleString("en-US")} tokens</span>}
          </p>
          {/* Screen readers hear the progress and the end, not every update. */}
          <p role="status" className="sr-only">
            {review.status === "running"
              ? `Reviewing part ${done + 1} of ${total}`
              : review.status === "completed"
                ? `Review finished: ${review.findings.filter((f) => f.status === "open").length} open findings`
                : `Review ${review.status}`}
          </p>

          {review.status === "running" && (
            <div className="mt-4 rounded-2xl border border-s-line p-3">
              <div className="flex items-center gap-3 text-[13.5px]">
                <Loader2 className="h-4 w-4 animate-spin text-s-ink-2" aria-hidden />
                <span className="flex-1">
                  Reviewing part {done + 1} of {total}…
                </span>
                <button
                  type="button"
                  onClick={() => void act("cancel")}
                  className="inline-flex h-8 items-center gap-1.5 rounded-full border border-s-line px-3 text-[12.5px] text-s-ink-2 hover:border-s-danger hover:text-s-danger"
                >
                  <Square className="h-3 w-3" aria-hidden /> Stop
                </button>
              </div>
              <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-s-hover" aria-hidden>
                <div className="h-full rounded-full bg-s-accent transition-all" style={{ width: `${Math.round((done / Math.max(1, total)) * 100)}%` }} />
              </div>
            </div>
          )}
          {(review.status === "failed" || review.status === "cancelled") && (
            <div
              className={cn(
                "mt-4 flex flex-wrap items-center gap-3 rounded-2xl border px-3 py-2.5 text-[13.5px]",
                review.status === "failed" ? "border-s-danger/40 text-s-danger" : "border-s-line text-s-ink-2",
              )}
            >
              <span className="min-w-0 flex-1">
                {review.status === "failed" ? (review.error ?? "The review stopped with an error.") : "You stopped this review."}{" "}
                {done < total && `${done} of ${total} parts were reviewed; the findings below are from those.`}
              </span>
              {done < total && (
                <button
                  type="button"
                  onClick={() => void act("retry")}
                  className="inline-flex h-8 items-center gap-1.5 rounded-full border border-s-line px-3 text-[12.5px] text-s-ink hover:border-s-line-strong"
                >
                  <RotateCcw className="h-3 w-3" aria-hidden /> Continue the review
                </button>
              )}
            </div>
          )}
          {error && (
            <p role="alert" className="mt-3 rounded-xl border border-s-danger/40 px-3 py-2 text-[13px] text-s-danger">
              {error.message}{" "}
              {error.upgrade && (
                <Link href="/pricing" className="underline">
                  See plans
                </Link>
              )}
            </p>
          )}

          <Activity review={review} />

          <section aria-labelledby="rv-findings" className="mt-6">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 id="rv-findings" className="text-[17px] font-semibold">
                Findings
              </h2>
              <span className="text-[13px] text-s-ink-3">
                <SeverityCounts counts={review.counts} />
              </span>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2" role="group" aria-label="Filter findings">
              {SEVERITIES.map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={sev.has(s)}
                  onClick={() => setSev((cur) => (cur.has(s) ? new Set([...cur].filter((x) => x !== s)) : new Set([...cur, s])))}
                  className={cn(
                    "inline-flex h-8 items-center gap-1 rounded-full border px-3 text-[12.5px] capitalize",
                    sev.has(s) ? "border-s-line-strong bg-s-hover text-s-ink" : "border-s-line text-s-ink-3",
                  )}
                >
                  {sev.has(s) && <Check className="h-3 w-3" aria-hidden />}
                  {s} ({review.counts[s]})
                </button>
              ))}
              <label className="sr-only" htmlFor="rv-cat">
                Category
              </label>
              <select id="rv-cat" value={cat} onChange={(e) => setCat(e.target.value as Category | "all")} className="h-8 rounded-full border border-s-line bg-transparent px-2.5 text-[12.5px]">
                <option value="all">All categories</option>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABEL[c]}
                  </option>
                ))}
              </select>
              {closed > 0 && (
                <label className="inline-flex min-h-8 items-center gap-1.5 text-[12.5px] text-s-ink-2">
                  <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> Show dismissed and resolved ({closed})
                </label>
              )}
            </div>

            {shown.length === 0 ? (
              <p className="mt-4 rounded-2xl border border-dashed border-s-line px-4 py-6 text-center text-[13.5px] text-s-ink-3">
                {review.status === "running"
                  ? "Findings appear here as each part is reviewed."
                  : review.findings.length
                    ? "No findings match these filters."
                    : "No problems were found in what was reviewed. That isn't proof there are none: the review reads the code, it doesn't run it."}
              </p>
            ) : (
              <ol className="mt-3 space-y-3">
                {shown.map((f) => (
                  <FindingCard
                    key={f.id}
                    reviewId={id}
                    finding={f}
                    canFix={!review.source.kind.startsWith("diff")}
                    fixing={fixing === f.id}
                    onStatus={(s) => void setStatus(f, s)}
                    onFix={() => void fixWithAgent(f)}
                  />
                ))}
              </ol>
            )}
            {review.skipped.length > 0 && review.status !== "running" && (
              <details className="mt-4 text-[12.5px] text-s-ink-3">
                <summary className="cursor-pointer">Not reviewed ({review.skipped.length} source files, to stay within the review size)</summary>
                <p className="mt-1 break-words font-mono text-[11.5px]">{review.skipped.slice(0, 120).join(", ")}</p>
              </details>
            )}
          </section>
        </div>
      </div>
    </>
  );
}

function Activity({ review }: { review: Review }) {
  const [open, setOpen] = useState(false);
  if (!review.log.length) return null;
  return (
    <section className="mt-4 rounded-2xl border border-s-line">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[13.5px]">
        {open ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
        What Orbis did <span className="text-s-ink-3">({review.log.length} steps)</span>
      </button>
      {open && (
        <ol className="space-y-1.5 border-t border-s-line px-3 py-2.5 text-[12.5px]">
          {review.log.map((l, i) => (
            <li key={i} className={cn("flex gap-2", l.kind === "error" ? "text-s-danger" : l.kind === "warning" ? "text-amber-700 dark:text-amber-400" : "text-s-ink-2")}>
              <time dateTime={l.at} className="shrink-0 tabular-nums text-s-ink-3" suppressHydrationWarning>
                {new Date(l.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </time>
              <span>{l.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function FindingCard({
  reviewId,
  finding: f,
  canFix,
  fixing,
  onStatus,
  onFix,
}: {
  reviewId: string;
  finding: Finding;
  canFix: boolean;
  fixing: boolean;
  onStatus: (s: Finding["status"]) => void;
  onFix: () => void;
}) {
  const [context, setContext] = useState<{ lines: { no: number; text: string }[] } | null>(null);
  const [loadingCtx, setLoadingCtx] = useState(false);

  const showContext = async () => {
    if (context) return setContext(null);
    setLoadingCtx(true);
    try {
      const r = await api<{ file: { content: string; lineNos: number[] | null } }>(`/api/review/${reviewId}?file=${encodeURIComponent(f.file)}`);
      const all = r.file.content.split("\n").map((text, i) => ({ no: r.file.lineNos?.[i] ?? i + 1, text }));
      const at = all.findIndex((l) => l.no === f.line);
      setContext({ lines: all.slice(Math.max(0, at - 6), at + 7) });
    } catch {
      setContext({ lines: [] });
    } finally {
      setLoadingCtx(false);
    }
  };

  return (
    <li className={cn("rounded-2xl border border-s-line p-3.5", f.status !== "open" && "opacity-70")}>
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge severity={f.severity} />
        <span className="text-[12px] text-s-ink-2">{CATEGORY_LABEL[f.category]}</span>
        <span
          className={cn(
            "text-[12px]",
            f.confidence === "confirmed" ? "text-emerald-700 dark:text-emerald-400" : f.confidence === "needs_verification" ? "text-amber-700 dark:text-amber-400" : "text-s-ink-2",
          )}
        >
          · {CONFIDENCE_LABEL[f.confidence]}
        </span>
        {f.inChange && <span className="rounded-full border border-s-line px-1.5 text-[11px] text-s-ink-2">in this change</span>}
        {f.status !== "open" && <span className="rounded-full border border-s-line px-1.5 text-[11px] capitalize text-s-ink-3">{f.status}</span>}
      </div>
      <h3 className="mt-2 text-[15px] font-medium leading-snug">{f.title}</h3>
      <p className="mt-1 font-mono text-[12px] text-s-ink-2">
        {f.file}:{f.line}
      </p>
      <pre
        tabIndex={0}
        aria-label={`Code at ${f.file} line ${f.line}`}
        className="s-scroll mt-2 overflow-x-auto rounded-lg border border-s-line bg-[var(--s-code,transparent)] px-2.5 py-1.5 font-mono text-[12px]"
      >
        <span className="select-none text-s-ink-3">{f.line} | </span>
        {f.evidence}
      </pre>
      {f.description && <p className="mt-2 text-[13.5px] leading-relaxed text-s-ink">{f.description}</p>}
      {f.reasoning && (
        <p className="mt-1.5 text-[13px] leading-relaxed text-s-ink-2">
          <span className="font-medium text-s-ink">How it shows up: </span>
          {f.reasoning}
        </p>
      )}
      {f.source !== "ai" && <p className="mt-1.5 text-[12px] text-s-ink-3">Found by a built-in check ({f.source.replace(/^rule:/, "")}), not by the AI.</p>}
      {f.fix && (
        <div className="mt-2.5">
          <p className="text-[13px] leading-relaxed text-s-ink-2">
            <span className="font-medium text-s-ink">Suggested fix: </span>
            {f.fix.explanation}
          </p>
          {f.fix.before !== null && f.fix.after !== null && (
            <div className="mt-2">
              <FileDiff change={{ path: `${f.file}:${f.line} (suggested, not applied)`, before: f.fix.before, after: f.fix.after }} />
            </div>
          )}
        </div>
      )}
      {context && (
        <pre
          tabIndex={0}
          aria-label={`${f.file} around line ${f.line}`}
          className="s-scroll mt-2 max-h-72 overflow-auto rounded-lg border border-s-line bg-[var(--s-code,transparent)] py-1.5 font-mono text-[12px]"
        >
          {context.lines.length === 0
            ? "Couldn't load the file."
            : context.lines.map((l) => (
                <div key={l.no} className={cn("whitespace-pre px-2.5", l.no === f.line && "bg-amber-500/15")}>
                  <span className="mr-2 inline-block w-9 select-none text-right text-s-ink-3">{l.no}</span>
                  {l.text}
                </div>
              ))}
        </pre>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void showContext()}
          aria-expanded={!!context}
          className="inline-flex h-8 items-center gap-1.5 rounded-full border border-s-line px-3 text-[12.5px] text-s-ink-2 hover:text-s-ink"
        >
          {loadingCtx ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <FileSearch className="h-3.5 w-3.5" aria-hidden />}
          {context ? "Hide the code" : "Show in the file"}
        </button>
        {f.status === "open" && canFix && (
          <button
            type="button"
            onClick={onFix}
            disabled={fixing}
            title="Opens a Code project and starts the coding agent on this finding. You approve its plan and its edits."
            className="inline-flex h-8 items-center gap-1.5 rounded-full bg-s-accent px-3 text-[12.5px] font-medium text-s-accent-ink disabled:opacity-50"
          >
            {fixing ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Wrench className="h-3.5 w-3.5" aria-hidden />} Fix with the coding agent
          </button>
        )}
        {f.status === "open" ? (
          <>
            <button
              type="button"
              onClick={() => onStatus("resolved")}
              className="inline-flex h-8 items-center gap-1.5 rounded-full border border-s-line px-3 text-[12.5px] text-s-ink-2 hover:text-s-ink"
            >
              <Check className="h-3.5 w-3.5" aria-hidden /> Mark resolved
            </button>
            <button
              type="button"
              onClick={() => onStatus("dismissed")}
              className="inline-flex h-8 items-center gap-1.5 rounded-full border border-s-line px-3 text-[12.5px] text-s-ink-2 hover:text-s-ink"
            >
              <X className="h-3.5 w-3.5" aria-hidden /> Not a problem
            </button>
          </>
        ) : (
          <button type="button" onClick={() => onStatus("open")} className="inline-flex h-8 items-center gap-1.5 rounded-full border border-s-line px-3 text-[12.5px] text-s-ink-2 hover:text-s-ink">
            <Undo2 className="h-3.5 w-3.5" aria-hidden /> Reopen
          </button>
        )}
      </div>
    </li>
  );
}
