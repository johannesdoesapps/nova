"use client";
import { useState } from "react";
import { AlertTriangle, CircleCheck, Wrench, CircleDashed, CircleX, Clock3, FileCode2, Globe, Loader2, RotateCcw, ShieldAlert, ShieldCheck, Square, Undo2 } from "lucide-react";
import { assessReport, CHECK_STATUS_LABEL, checklistOf, fixRequest, nextActions, TASK_STATE_INFO, taskState } from "@/lib/code/agent/verdict";
import type { CheckItem, CheckStatus, RunReport, RunView, TaskState } from "@/lib/code/agent/types";
import { REPRODUCTION_LABEL, type ProfileReport } from "@/lib/code/agent/profiles";
import { cn } from "@/lib/utils";

/**
 * The end of a coding session: what was asked, what the agent says it did
 * (labelled as its words), and what the records show — every check with its
 * status, time and output, the checks that didn't run and why, the files
 * changed and the commands run. The overall state comes from the checks
 * (verdict.ts), never from the agent's summary. Status is always spelled out
 * in words next to its icon, so nothing relies on colour.
 */

const usd = (n: number) => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;

const STATE_STYLE: Record<TaskState, { icon: typeof ShieldCheck; tone: string; border: string }> = {
  verified: { icon: ShieldCheck, tone: "text-emerald-600 dark:text-emerald-400", border: "border-emerald-500/40" },
  checked: { icon: ShieldCheck, tone: "text-s-ink", border: "border-s-line-strong" },
  warnings: { icon: AlertTriangle, tone: "text-amber-600 dark:text-amber-400", border: "border-amber-500/50" },
  unverified: { icon: ShieldAlert, tone: "text-s-ink-2", border: "border-s-line-strong" },
  failed: { icon: CircleX, tone: "text-s-danger", border: "border-s-danger/40" },
  cancelled: { icon: Square, tone: "text-s-ink-2", border: "border-s-line-strong" },
  queued: { icon: Clock3, tone: "text-s-ink-2", border: "border-s-line" },
  running: { icon: Loader2, tone: "text-s-ink-2", border: "border-s-line" },
  waiting: { icon: Clock3, tone: "text-s-ink-2", border: "border-s-line" },
  verifying: { icon: Loader2, tone: "text-s-ink-2", border: "border-s-line" },
};

const CHECK_STYLE: Record<CheckStatus, { icon: typeof CircleCheck; tone: string }> = {
  passed: { icon: CircleCheck, tone: "text-emerald-600 dark:text-emerald-400" },
  failed: { icon: CircleX, tone: "text-s-danger" },
  stale: { icon: Clock3, tone: "text-amber-600 dark:text-amber-400" },
  error: { icon: AlertTriangle, tone: "text-amber-600 dark:text-amber-400" },
  not_run: { icon: CircleDashed, tone: "text-s-ink-3" },
};

const KIND_LABEL: Record<CheckItem["kind"], string> = { automated: "Automated", inspection: "Visual inspection", process: "Process" };

/** What a file row does: open the file, or (deleted, so nothing to open) show the changes with its diff. */
export function fileAction(f: RunReport["files"][number]): { kind: "open"; path: string } | { kind: "review" } {
  return f.change === "deleted" ? { kind: "review" } : { kind: "open", path: f.path };
}

/** Checks the user can ask Orbis to run again: tests when the project has them, and the browser inspection for a website. */
export function canRerun(r: RunReport): boolean {
  return checklistOf(r).some((c) => (c.id === "tests" && (c.applicable || c.status !== "not_run")) || c.id === "browser");
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" }) : null);

export function VerificationPanel({
  run,
  onShowChanges,
  onOpenFile,
  onRerun,
  onUndo,
  onOpenPreview,
  onRetry,
  onAskFix,
}: {
  run: RunView;
  onShowChanges: () => void;
  onOpenFile: (path: string) => void;
  onRerun: () => Promise<void>;
  onUndo: () => Promise<void>;
  onOpenPreview?: () => void;
  /** Start the same request again as a new session (offered when the run failed or was stopped). */
  onRetry?: () => void;
  /** Put a request to fix what the checks found in the prompt box, to edit and send. */
  onAskFix?: (request: string) => void;
}) {
  const [rerunning, setRerunning] = useState(false);
  const r = run.report;
  const state = taskState(run);
  const info = TASK_STATE_INFO[state];
  const style = STATE_STYLE[state];
  const assessment = r && run.status === "completed" ? assessReport(r) : null;
  const items = r ? checklistOf(r) : [];
  const ran = items.filter((c) => c.status !== "not_run");
  const notRun = items.filter((c) => c.status === "not_run");
  const actions = r ? nextActions(r, state) : [];
  const fix = r && run.status === "completed" && onAskFix ? fixRequest(r) : null;
  const secondary = "inline-flex h-8 items-center gap-1.5 rounded-full border border-s-line px-3 text-[12.5px] text-s-ink-2 hover:border-s-line-strong hover:text-s-ink disabled:opacity-50";
  const heading = "text-[11px] font-medium uppercase tracking-[0.08em] text-s-ink-3";

  const rerun = async () => {
    setRerunning(true);
    try {
      await onRerun();
    } finally {
      setRerunning(false);
    }
  };

  return (
    <section aria-labelledby={`verdict-${run.id}`} className={cn("rounded-2xl border p-4 text-[13.5px] leading-relaxed", style.border)}>
      <div className="flex items-start gap-2.5">
        <style.icon className={cn("mt-0.5 h-5 w-5 shrink-0", style.tone)} aria-hidden />
        <div className="min-w-0">
          <h2 id={`verdict-${run.id}`} className={cn("text-[15.5px] font-medium", style.tone)}>
            {info.label}
          </h2>
          <p className="text-[13px] text-s-ink-2">{info.meaning}</p>
        </div>
      </div>
      {run.error && <p className="mt-2 rounded-xl border border-s-danger/40 px-3 py-2 text-s-danger">{run.error}</p>}
      {(state === "failed" || state === "cancelled") && onRetry && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-s-ink-2">
          <span>{state === "failed" ? "Nothing is lost: changes so far are kept, and you can undo them below." : "Changes made before you stopped are kept until you undo them."}</span>
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex h-8 items-center gap-1.5 rounded-full bg-s-accent px-3.5 text-[12.5px] font-medium text-s-accent-ink transition hover:brightness-110"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Try again
          </button>
        </div>
      )}
      {assessment && assessment.reasons.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[13px] text-s-ink-2" aria-label="Why it isn't verified">
          {assessment.reasons.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      )}
      {!r && run.status === "completed" && <p className="mt-2 text-[13px] text-s-ink-2">The session&apos;s record of checks is missing, so its work can&apos;t be treated as verified.</p>}

      <div className="mt-3">
        <h3 className={heading}>{run.options.agent === "bug_fixer" ? "The bug, as reported" : run.options.agent === "qa_tester" ? "What to test" : "The task"}</h3>
        <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-s-ink-2">{run.request}</p>
      </div>

      {r?.profile && <ProfileSection report={r.profile} heading={heading} onOpenFile={onOpenFile} />}

      {run.summary && (
        <div className="mt-3">
          <h3 className={heading}>What the agent says it did</h3>
          <p className="mt-1 whitespace-pre-wrap text-s-ink-2">{run.summary}</p>
        </div>
      )}

      {r && (
        <div className="mt-3">
          <h3 className={heading}>
            Checks <span className="normal-case tracking-normal">· {ran.length ? `${ran.length} ran` : "none ran"}</span>
          </h3>
          <ul className="mt-1.5 space-y-1.5">
            {items.map((c) => (
              <CheckRow key={c.id} item={c} />
            ))}
          </ul>
          {items.some((c) => c.id === "browser") && (
            <p className="mt-2 text-[12px] text-s-ink-3">
              The browser inspection opens the page at desktop, tablet and phone sizes and looks for errors, broken links and images, and layout problems. It doesn&apos;t click through the site or
              test what it does.
            </p>
          )}
          {notRun.length > 0 && ran.length === 0 && <p className="mt-2 text-[13px] text-s-ink-2">No checks ran, so nothing confirms these changes work.</p>}
          {fix && (
            <button type="button" onClick={() => onAskFix!(fix)} className={cn(secondary, "mt-2")} title="Fills the prompt box with what the checks found, for you to edit and send">
              <Wrench className="h-3.5 w-3.5" aria-hidden /> Ask the agent to fix these
            </button>
          )}
        </div>
      )}

      {r && (
        <div className="mt-3">
          <h3 className={heading}>Files changed</h3>
          {r.files.length === 0 ? (
            <p className="mt-1 text-[13px] text-s-ink-3">No files were changed.</p>
          ) : (
            <ul className="mt-1 space-y-0.5 font-mono text-[12.5px]">
              {r.files.map((f) => {
                const a = fileAction(f);
                return (
                  <li key={f.path} className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => (a.kind === "open" ? onOpenFile(a.path) : onShowChanges())}
                      title={a.kind === "open" ? `Open ${f.path}` : `${f.path} was deleted: show the changes`}
                      className={cn(
                        "min-h-6 min-w-0 flex-1 truncate text-left underline-offset-2 hover:text-s-ink hover:underline",
                        f.change === "deleted" ? "text-s-ink-3 line-through" : "text-s-ink-2",
                      )}
                    >
                      {f.path}
                    </button>
                    <span className="shrink-0 text-[11.5px] text-s-ink-3">{f.change === "created" ? "new" : f.change === "deleted" ? "deleted" : "edited"}</span>
                    {/* aria-label isn't read on a plain span, so the counts carry hidden words instead. */}
                    <span className="shrink-0 text-emerald-600 dark:text-emerald-400">
                      +{f.added}
                      <span className="sr-only"> lines added</span>
                    </span>
                    <span className="shrink-0 text-s-danger">
                      −{f.removed}
                      <span className="sr-only"> lines removed</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {r && r.commands.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-[12.5px] text-s-ink-3">
            {r.commands.length} command{r.commands.length === 1 ? "" : "s"} ran
          </summary>
          <ul className="mt-1 space-y-0.5 font-mono text-[11.5px] text-s-ink-2">
            {r.commands.map((c, i) => (
              <li key={i}>
                $ {c.command} <span className={c.exitCode === 0 ? "text-emerald-600 dark:text-emerald-400" : "text-s-danger"}>— {c.result}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {r && r.unresolved.length > 0 && (
        <div className="mt-3">
          <h3 className={heading}>Still open (the agent&apos;s words)</h3>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-s-ink-2">
            {r.unresolved.map((u, i) => (
              <li key={i}>{u}</li>
            ))}
          </ul>
        </div>
      )}

      {actions.length > 0 && (
        <div className="mt-3">
          <h3 className={heading}>Next steps</h3>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-s-ink-2">
            {actions.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onShowChanges}
          className="inline-flex h-8 items-center gap-1.5 rounded-full bg-s-accent px-3.5 text-[12.5px] font-medium text-s-accent-ink transition hover:brightness-110"
        >
          <FileCode2 className="h-3.5 w-3.5" aria-hidden /> Review changes
        </button>
        {run.status === "completed" && r && canRerun(r) && (
          <button type="button" onClick={() => void rerun()} disabled={rerunning} className={secondary} title="Run the tests and the browser inspection again on the files as they are now">
            {rerunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RotateCcw className="h-3.5 w-3.5" aria-hidden />} Re-run checks
          </button>
        )}
        {onOpenPreview && r?.checks?.server && (
          <button type="button" onClick={onOpenPreview} className={secondary}>
            <Globe className="h-3.5 w-3.5" aria-hidden /> Open preview
          </button>
        )}
        {r && r.files.length > 0 && (
          <button type="button" onClick={() => void onUndo()} title="Put every file this session changed back as it was" className={cn(secondary, "hover:border-s-danger hover:text-s-danger")}>
            <Undo2 className="h-3.5 w-3.5" aria-hidden /> Undo all changes
          </button>
        )}
      </div>

      {r && (
        <p className="mt-3 text-[11.5px] text-s-ink-3">
          {r.usage.steps} step{r.usage.steps === 1 ? "" : "s"} · {(r.usage.inputTokens + r.usage.outputTokens).toLocaleString()} tokens ·{" "}
          {r.usage.costUsd === null ? "cost not known" : `about ${usd(r.usage.costUsd)}`}
          {r.usage.models.length > 0 && ` · ${r.usage.models.join(", ")}`}
          {r.checkpoints > 0 && ` · ${r.checkpoints} checkpoint${r.checkpoints === 1 ? "" : "s"} (in Changes)`}
        </p>
      )}
    </section>
  );
}

/** Bug Fixing: whether the bug was reproduced before the fix (from what ran). QA Testing: the test files it wrote. */
function ProfileSection({ report: p, heading, onOpenFile }: { report: ProfileReport; heading: string; onOpenFile: (path: string) => void }) {
  if (p.reproduction) {
    const rep = p.reproduction;
    return (
      <div className="mt-3">
        <h3 className={heading}>Before the fix</h3>
        <p className={cn("mt-1", rep.state === "failed_before_fix" ? "text-s-ink" : "text-amber-700 dark:text-amber-400")}>{REPRODUCTION_LABEL[rep.state]}</p>
        {rep.command && (
          <p className="mt-0.5 text-[12.5px] text-s-ink-3">
            <code className="font-mono">{rep.command}</code>
            {rep.detail ? ` · ${rep.detail}` : ""}
          </p>
        )}
        {rep.state !== "failed_before_fix" && <p className="mt-0.5 text-[12.5px] text-s-ink-3">Without a failing check before the change, the tests below can&apos;t show the fix is what made the difference.</p>}
      </div>
    );
  }
  const tests = p.testFiles ?? [];
  const other = p.otherFiles ?? [];
  return (
    <div className="mt-3">
      <h3 className={heading}>Tests written</h3>
      {tests.length === 0 ? (
        <p className="mt-1 text-[13px] text-s-ink-3">No test files were added or changed.</p>
      ) : (
        <ul className="mt-1 space-y-0.5 font-mono text-[12.5px]">
          {tests.map((path) => (
            <li key={path}>
              <button type="button" onClick={() => onOpenFile(path)} className="min-h-6 truncate text-left text-s-ink-2 underline-offset-2 hover:text-s-ink hover:underline">
                {path}
              </button>
            </li>
          ))}
        </ul>
      )}
      {other.length > 0 && <p className="mt-1 text-[12.5px] text-s-ink-3">Test setup changed: {other.join(", ")}</p>}
    </div>
  );
}

function CheckRow({ item: c }: { item: CheckItem }) {
  const s = CHECK_STYLE[c.status];
  const hasMore = !!(c.command || c.details.length || c.output);
  const head = (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
      <s.icon className={cn("h-4 w-4 shrink-0", s.tone)} aria-hidden />
      <span className="font-medium text-s-ink">{c.label}</span>
      <span className={cn("rounded-full border px-1.5 text-[11.5px]", s.tone, c.status === "not_run" ? "border-s-line" : "border-current/40")}>{CHECK_STATUS_LABEL[c.status]}</span>
      <span className="text-[11.5px] text-s-ink-3">{KIND_LABEL[c.kind]}</span>
      {c.at && (
        <time dateTime={c.at} className="text-[11.5px] text-s-ink-3">
          {when(c.at)}
        </time>
      )}
    </span>
  );
  return (
    <li className="rounded-xl border border-s-line px-3 py-2">
      {hasMore ? (
        <details>
          <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
            {head}
            <span className="mt-0.5 block pl-6 text-[12.5px] text-s-ink-2">{c.summary}</span>
          </summary>
          <div className="mt-1.5 space-y-1.5 pl-6 text-[12.5px]">
            {c.command && (
              <p className="text-s-ink-3">
                Command: <code className="font-mono text-s-ink-2">{c.command}</code>
              </p>
            )}
            {c.details.length > 0 && (
              <ul className="list-disc space-y-0.5 pl-4 text-s-ink-2">
                {c.details.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            )}
            {c.output && <pre className="max-h-56 overflow-auto rounded-lg bg-s-hover/60 p-2 font-mono text-[11.5px] whitespace-pre-wrap text-s-ink-2">{c.output}</pre>}
          </div>
        </details>
      ) : (
        <>
          {head}
          <span className="mt-0.5 block pl-6 text-[12.5px] text-s-ink-2">{c.summary}</span>
        </>
      )}
    </li>
  );
}
