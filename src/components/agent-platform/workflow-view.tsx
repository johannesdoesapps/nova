"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CircleAlert, CircleDashed, CircleX, Clock3, Download, Loader2, Minus, RotateCcw, SkipForward, Square, ThumbsDown, ThumbsUp } from "lucide-react";
import { api, post, type CodeApiError } from "@/components/code/api";
import { StudioHeader } from "@/components/studio/frame";
import { ConfirmDialog } from "@/components/studio/dialogs";
import type { WorkflowView as View } from "@/lib/agent-platform/workflow-server";
import { MAX_ATTEMPTS, TEMPLATE_INFO, type StepStatus, type WorkflowStatus, type WorkflowStep } from "@/lib/agent-platform/workflow";
import { agentDef } from "@/lib/agent-platform/registry";
import { ago } from "@/lib/home";
import { cn } from "@/lib/utils";
import { AgentIconTile } from "./marketplace";

const STATUS_TEXT: Record<WorkflowStatus, string> = {
  running: "Working",
  waiting: "Waiting for you in a task",
  needs_approval: "Ready for your decision",
  completed: "Finished",
  failed: "Stopped at a failed step",
  cancelled: "Stopped",
};

const STEP_ICON: Record<StepStatus, { icon: typeof Check; tone: string; label: string }> = {
  pending: { icon: CircleDashed, tone: "text-s-ink-3", label: "Waiting for an earlier step" },
  ready: { icon: CircleDashed, tone: "text-s-ink-2", label: "Ready to start" },
  running: { icon: Loader2, tone: "text-s-ink-2", label: "Working" },
  waiting: { icon: Clock3, tone: "text-amber-600 dark:text-amber-400", label: "Waiting for you" },
  done: { icon: Check, tone: "text-emerald-600 dark:text-emerald-400", label: "Done" },
  failed: { icon: CircleX, tone: "text-s-danger", label: "Failed" },
  skipped: { icon: Minus, tone: "text-s-ink-3", label: "Skipped" },
  cancelled: { icon: Square, tone: "text-s-ink-3", label: "Stopped" },
};

/** Where a step's task is shown: the coding task in its project, or the review. */
function taskHref(w: View, s: WorkflowStep): string | null {
  if (!s.taskId) return null;
  return s.kind === "review" ? `/review/${s.taskId}` : `/code/${w.project_id}?run=${s.taskId}`;
}

/**
 * A workflow as it runs: its steps, each linked to the task it started, with the page moving the
 * current step on while it's open. A step that waits for the user (a plan to approve) is answered in
 * that task; the workflow notices and carries on. At the end the user approves or rejects the changes.
 */
export function WorkflowDetail({ id }: { id: string }) {
  const [w, setW] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"reject" | "cancel" | null>(null);
  const alive = useRef(true);
  const driving = useRef(false);

  const drive = useCallback(async () => {
    if (driving.current) return;
    driving.current = true;
    let failures = 0;
    try {
      while (alive.current) {
        let cur: View;
        try {
          cur = (await post<{ workflow: View }>(`/api/workflows/${id}/advance`, {})).workflow;
          failures = 0;
          setError(null);
        } catch (e) {
          if (++failures >= 3) {
            setError((e as Error).message);
            return;
          }
          await new Promise((r) => setTimeout(r, 4000));
          continue;
        }
        if (!alive.current) return;
        setW(cur);
        if (cur.status === "running") continue;
        if (cur.status === "waiting") {
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        return;
      }
    } finally {
      driving.current = false;
    }
  }, [id]);

  useEffect(() => {
    alive.current = true;
    api<{ workflow: View }>(`/api/workflows/${id}`)
      .then((r) => {
        setW(r.workflow);
        if (r.workflow.status === "running" || r.workflow.status === "waiting") void drive();
      })
      .catch((e: Error) => setError(e.message));
    return () => {
      alive.current = false;
    };
  }, [id, drive]);

  const act = async (name: string, url: string, body: unknown = {}) => {
    setBusy(name);
    setError(null);
    try {
      const r = await post<{ workflow: View }>(url, body);
      setW(r.workflow);
      if (r.workflow.status === "running" || r.workflow.status === "waiting") void drive();
    } catch (e) {
      setError((e as CodeApiError).message);
    } finally {
      setBusy(null);
    }
  };

  const info = w ? TEMPLATE_INFO[w.template] : null;
  // The failed step the user is asked about (other steps that were running have finished by now).
  const current = w?.steps.find((s) => s.status === "failed");
  const canRecover = w?.status === "failed" && !!current;

  return (
    <>
      <StudioHeader>
        <span className="text-[14px] font-medium text-s-ink-2">
          <Link href="/agents" className="hover:text-s-ink">
            Agents
          </Link>{" "}
          /{" "}
          <Link href="/agents/workflows" className="hover:text-s-ink">
            Workflows
          </Link>
        </span>
      </StudioHeader>
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[880px] px-4 pb-20 pt-2 sm:px-8">
          {!w ? (
            error ? (
              <p role="alert" className="mt-10 text-[14px] text-s-danger">
                {error}
              </p>
            ) : (
              <div className="mt-6 space-y-3">
                <div className="s-skeleton h-10 w-2/3 rounded-xl" />
                <div className="s-skeleton h-40 rounded-2xl" />
              </div>
            )
          ) : (
            <>
              <p className="text-[12.5px] font-medium uppercase tracking-[0.08em] text-s-ink-3">{info!.name} workflow</p>
              <h1 className="mt-1 font-serif text-[clamp(26px,4vw,36px)] leading-[1.1] tracking-[-0.01em]">{w.summary}</h1>
              <p className="mt-1.5 text-[13.5px] text-s-ink-2">
                {w.projectName ? (
                  <>
                    Project{" "}
                    <Link href={`/code/${w.project_id}`} className="text-s-ink underline-offset-4 hover:underline">
                      {w.projectName}
                    </Link>{" "}
                    ·{" "}
                  </>
                ) : null}
                started <span suppressHydrationWarning>{ago(w.created_at)}</span>
              </p>

              <div className="mt-5 flex flex-wrap items-center gap-2" role="status">
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[13px]",
                    w.status === "failed" ? "border-s-danger/50 text-s-danger" : "border-s-line text-s-ink-2",
                  )}
                >
                  {(w.status === "running" || w.busy) && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
                  {STATUS_TEXT[w.status]}
                </span>
                {!["completed", "failed", "cancelled"].includes(w.status) && (
                  <button
                    type="button"
                    onClick={() => setConfirm("cancel")}
                    disabled={!!busy}
                    className="inline-flex h-8 items-center gap-1.5 rounded-full border border-s-line px-3 text-[12.5px] text-s-ink-2 hover:border-s-danger hover:text-s-danger"
                  >
                    <Square className="h-3 w-3" aria-hidden /> Stop workflow
                  </button>
                )}
              </div>

              {w.error && w.status === "failed" && (
                <p role="alert" className="mt-3 rounded-xl border border-s-danger/40 px-3 py-2 text-[13.5px] text-s-danger">
                  {w.error}
                </p>
              )}
              {error && (
                <p role="alert" className="mt-3 flex flex-wrap items-center gap-2 text-[13.5px] text-s-danger">
                  <CircleAlert className="h-4 w-4" aria-hidden /> {error}
                  <button type="button" onClick={() => void drive()} className="rounded-full border border-s-line px-3 py-1 text-[12.5px] text-s-ink-2 hover:text-s-ink">
                    Try again
                  </button>
                </p>
              )}

              <ol className="mt-6 space-y-3" aria-label="Steps">
                {w.steps.map((s, i) => {
                  const st = STEP_ICON[s.status];
                  const def = s.agent ? agentDef(s.agent) : null;
                  const href = taskHref(w, s);
                  return (
                    <li
                      key={s.key}
                      className={cn("glass rounded-[20px] p-4", (s.status === "running" || s.status === "waiting") && !["completed", "cancelled"].includes(w.status) && "border-s-line-strong")}
                    >
                      <div className="flex items-start gap-3">
                        {def ? <AgentIconTile agent={def} /> : <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[14px] border border-s-line text-s-ink-2">{i + 1}</span>}
                        <div className="min-w-0 flex-1">
                          <p className="text-[12px] text-s-ink-3">
                            Step {i + 1}
                            {def ? ` · ${def.name}` : ""}
                            {s.dependsOn.length ? ` · after ${s.dependsOn.map((k) => w.steps.findIndex((x) => x.key === k) + 1).join(" and ")}` : ""}
                            {w.steps.some((o) => o.key !== s.key && o.kind !== "approval" && s.kind !== "approval" && o.dependsOn.join() === s.dependsOn.join() && s.dependsOn.length > 0)
                              ? " · runs alongside another step"
                              : ""}
                            {s.attempts > 1 ? ` · attempt ${s.attempts} of ${MAX_ATTEMPTS}` : ""}
                          </p>
                          <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{s.label}</h2>
                          <p className={cn("mt-0.5 inline-flex items-center gap-1.5 text-[13px]", st.tone)}>
                            <st.icon className={cn("h-3.5 w-3.5", s.status === "running" && "animate-spin")} aria-hidden /> {st.label}
                          </p>
                          {s.summary && <p className="mt-1 text-[13.5px] text-s-ink-2">{s.summary}</p>}
                          {s.error && <p className="mt-1 text-[13.5px] text-s-danger">{s.error}</p>}
                          {s.status === "waiting" && s.kind === "code_run" && href && (
                            <p className="mt-2 text-[13.5px]">
                              The agent is waiting for you.{" "}
                              <Link href={href} className="font-medium text-s-accent underline-offset-4 hover:underline">
                                Open the task to answer
                              </Link>
                              ; this page carries on once you have.
                            </p>
                          )}
                          {href && (
                            <Link
                              href={href}
                              className="mt-2 inline-flex h-8 items-center rounded-full border border-s-line px-3 text-[12.5px] text-s-ink-2 hover:border-s-line-strong hover:text-s-ink"
                            >
                              {s.kind === "review" ? "Open the review" : "Open the task: changes, tests and report"}
                            </Link>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>

              {canRecover && (
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {current!.attempts < MAX_ATTEMPTS && (
                    <button
                      type="button"
                      disabled={!!busy}
                      onClick={() => void act("retry", `/api/workflows/${id}/recover`, { action: "retry", step: current!.key })}
                      className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-s-accent px-4 text-[13.5px] font-medium text-s-accent-ink hover:brightness-110 disabled:opacity-50"
                    >
                      <RotateCcw className="h-4 w-4" aria-hidden /> Try this step again
                    </button>
                  )}
                  {current!.optional && (
                    <button
                      type="button"
                      disabled={!!busy}
                      onClick={() => void act("skip", `/api/workflows/${id}/recover`, { action: "skip", step: current!.key })}
                      className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-s-line-strong px-4 text-[13.5px] hover:bg-s-hover disabled:opacity-50"
                    >
                      <SkipForward className="h-4 w-4" aria-hidden /> Skip it and go on
                    </button>
                  )}
                </div>
              )}

              {w.status === "needs_approval" && (
                <section aria-labelledby="decide" className="glass-strong mt-6 rounded-[22px] p-5">
                  <h2 id="decide" className="text-[16px] font-semibold">
                    Your decision
                  </h2>
                  <p className="mt-1 text-[13.5px] text-s-ink-2">
                    Look at each task&apos;s changes and test results and the review&apos;s findings above. Approving records your decision; to publish the changes, push them to a new GitHub branch
                    from the project in Code (it asks first). Rejecting undoes every change the workflow made.
                  </p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={!!busy}
                      onClick={() => void act("approve", `/api/workflows/${id}/decide`, { action: "approve" })}
                      className="inline-flex h-10 items-center gap-2 rounded-xl bg-s-accent px-4 text-[14px] font-medium text-s-accent-ink hover:brightness-110 disabled:opacity-50"
                    >
                      {busy === "approve" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ThumbsUp className="h-4 w-4" aria-hidden />} Approve the changes
                    </button>
                    <button
                      type="button"
                      disabled={!!busy}
                      onClick={() => setConfirm("reject")}
                      className="inline-flex h-10 items-center gap-2 rounded-xl border border-s-line-strong px-4 text-[14px] hover:bg-s-hover disabled:opacity-50"
                    >
                      <ThumbsDown className="h-4 w-4" aria-hidden /> Reject and undo them
                    </button>
                  </div>
                </section>
              )}

              {w.status === "completed" && w.decision?.action === "approve" && (
                <section className="mt-6 rounded-[22px] border border-s-line p-5 text-[13.5px]">
                  <h2 className="text-[15px] font-semibold">Approved</h2>
                  <p className="mt-1 text-s-ink-2">The changes are in the project. Nothing has been pushed anywhere.</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Link href={`/code/${w.project_id}`} className="inline-flex h-9 items-center rounded-xl border border-s-line-strong px-3.5 hover:bg-s-hover">
                      Open the project (push to GitHub from there)
                    </Link>
                    <a href={`/api/code/projects/${w.project_id}/download`} className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-s-line-strong px-3.5 hover:bg-s-hover">
                      <Download className="h-4 w-4" aria-hidden /> Download the project
                    </a>
                  </div>
                </section>
              )}

              <section aria-labelledby="wf-log" className="mt-8">
                <h2 id="wf-log" className="text-[13px] font-semibold uppercase tracking-[0.06em] text-s-ink-3">
                  Activity
                </h2>
                <ol className="mt-2 space-y-1 text-[13px] text-s-ink-2">
                  {[...w.log].reverse().map((l, i) => (
                    <li key={`${l.at}-${i}`} className="flex gap-3">
                      <time dateTime={l.at} className="w-20 shrink-0 text-s-ink-3" suppressHydrationWarning>
                        {new Date(l.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </time>
                      <span>{l.text}</span>
                    </li>
                  ))}
                </ol>
              </section>
            </>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirm === "reject"}
        title="Reject and undo the changes?"
        description="Every file the workflow's tasks changed goes back to how it was before. If you've edited those files since, nothing is undone and you're told which files."
        confirmLabel="Reject and undo"
        onClose={() => setConfirm(null)}
        onConfirm={() => act("reject", `/api/workflows/${id}/decide`, { action: "reject" })}
      />
      <ConfirmDialog
        open={confirm === "cancel"}
        title="Stop this workflow?"
        description="The task it's running is stopped too. Changes made so far stay in the project until you undo them."
        confirmLabel="Stop workflow"
        onClose={() => setConfirm(null)}
        onConfirm={() => act("cancel", `/api/workflows/${id}/cancel`)}
      />
    </>
  );
}
