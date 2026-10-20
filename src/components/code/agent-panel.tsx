"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  FileCode2,
  ListChecks,
  Loader2,
  MessageSquare,
  Power,
  RotateCcw,
  Search,
  ShieldCheck,
  Square,
  Terminal as TerminalIcon,
  Undo2,
  X,
} from "lucide-react";
import { useCatalog } from "@/components/common/model-picker";
import { ModelSelector } from "@/components/studio/model-selector";
import { VERIFICATION_LABEL } from "@/lib/code/agent/report";
import { ENDED_STATUSES, STATUS_LABEL, WORKING_STATUSES, type AgentEvent, type CommandMode, type Decision, type LimitReason, type RunReport, type RunView } from "@/lib/code/agent/types";
import { cn } from "@/lib/utils";
import { api, CodeApiError, post } from "./api";
import { FileDiff } from "./diff-view";

/**
 * The coding agent in Code mode: ask for a change, watch what it does, and
 * answer when it needs you (its plan, a command, edits to review, a
 * question, starting the computer). The page drives the run step by step
 * (each request says which step it expects, so a retry never repeats one),
 * so the agent works while this page is open; Stop ends it at once. When the
 * run ends, its report shows what changed, what ran and whether the tests
 * passed, from the run's records.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type RunDetail = { run: RunView; events: AgentEvent[] };

export function AgentPanel({
  projectId,
  computerOn,
  startComputer,
  onFilesChanged,
  onShowChanges,
}: {
  projectId: string;
  computerOn: boolean;
  /** Start the project's computer; true when it's running. */
  startComputer: () => Promise<boolean>;
  /** The agent saved, changed or reverted files: reload them. */
  onFilesChanged: () => void;
  onShowChanges: (runId: string) => void;
}) {
  const catalog = useCatalog();
  const [run, setRun] = useState<RunView | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [driving, setDriving] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [error, setError] = useState<CodeApiError | null>(null);
  // New run
  const [request, setRequest] = useState("");
  const [modelId, setModelId] = useState("auto:coding");
  const [approvePlans, setApprovePlans] = useState(true);
  const [reviewEdits, setReviewEdits] = useState(false);
  const [commands, setCommands] = useState<CommandMode>("safe");
  const [starting, setStarting] = useState(false);

  const alive = useRef(true);
  const lastSeq = useRef(0);
  const driveId = useRef(0);
  const feedEnd = useRef<HTMLDivElement>(null);
  const filesChanged = useRef(onFilesChanged);
  useEffect(() => {
    filesChanged.current = onFilesChanged;
  }, [onFilesChanged]);

  /** Fetch the run and its new activity; reload files when the agent touched them. */
  const refresh = useCallback(async (runId: string): Promise<RunView> => {
    const r = await api<RunDetail>(`/api/code/agent/${runId}?after=${lastSeq.current}`);
    if (!alive.current) return r.run;
    setRun(r.run);
    const fresh = r.events.filter((e) => e.seq > lastSeq.current);
    if (fresh.length) {
      lastSeq.current = Math.max(...fresh.map((e) => e.seq));
      setEvents((es) => [...es.filter((e) => !fresh.some((f) => f.seq === e.seq)), ...fresh].sort((a, b) => a.seq - b.seq));
      if (fresh.some((e) => e.kind === "edit" || e.kind === "revert" || (e.kind === "command" && Array.isArray(e.detail?.changed) && (e.detail.changed as unknown[]).length))) filesChanged.current();
    }
    return r.run;
  }, []);

  const open = useCallback(
    async (runId: string) => {
      lastSeq.current = 0;
      setEvents([]);
      return refresh(runId);
    },
    [refresh],
  );

  /** Keep taking steps while the run is working; stop when it waits, ends, fails, or Stop is pressed. */
  const drive = useCallback(
    async (runId: string) => {
      const me = ++driveId.current;
      setDriving(true);
      setError(null);
      try {
        let expectStep = (await refresh(runId)).steps;
        for (;;) {
          if (!alive.current || driveId.current !== me) return;
          const watch = setInterval(() => void refresh(runId).catch(() => {}), 2500);
          let res: { run: RunView; skipped?: "busy" | "not_working" | "stale" };
          try {
            res = await post(`/api/code/agent/${runId}/step`, { expectStep });
          } finally {
            clearInterval(watch);
          }
          if (driveId.current !== me) return;
          const latest = await refresh(runId);
          expectStep = latest.steps;
          if (!WORKING_STATUSES.includes(latest.status)) return;
          if (res.skipped === "busy") await sleep(3000);
        }
      } catch (e) {
        if (driveId.current === me) setError(e as CodeApiError);
        await refresh(runId).catch(() => {});
      } finally {
        if (driveId.current === me) setDriving(false);
      }
    },
    [refresh],
  );

  useEffect(() => {
    alive.current = true;
    api<{ runs: RunView[] }>(`/api/code/projects/${projectId}/agent`)
      .then(async ({ runs }) => {
        const latest = runs[0];
        if (latest && !ENDED_STATUSES.includes(latest.status)) await open(latest.id);
      })
      .catch((e: CodeApiError) => alive.current && e.status !== 401 && setError(e))
      .finally(() => alive.current && setLoaded(true));
    // Leaving the page ends the loop (it checks `alive` before each step).
    return () => {
      alive.current = false;
    };
  }, [projectId, open]);

  // A step that's running from before this page loaded (or in another tab): watch it until it ends.
  useEffect(() => {
    if (!run?.busy || driving) return;
    const t = setInterval(() => void refresh(run.id).catch(() => {}), 3000);
    return () => clearInterval(t);
  }, [run?.busy, run?.id, driving, refresh]);

  useEffect(() => {
    feedEnd.current?.scrollIntoView({ block: "end" });
  }, [events.length, run?.status]);

  const start = async () => {
    if (!request.trim() || starting) return;
    setStarting(true);
    setError(null);
    try {
      const r = await post<{ run: RunView }>(`/api/code/projects/${projectId}/agent`, { request, options: { modelId, approvePlans, reviewEdits, commands } });
      lastSeq.current = 0;
      setEvents([]);
      setRun(r.run);
      setRequest("");
      void drive(r.run.id);
    } catch (e) {
      setError(e as CodeApiError);
    } finally {
      setStarting(false);
    }
  };

  const respond = async (decision: Decision, text?: string) => {
    if (!run) return;
    setAnswering(true);
    setError(null);
    const watch = setInterval(() => void refresh(run.id).catch(() => {}), 2500);
    try {
      const r = await post<{ run: RunView }>(`/api/code/agent/${run.id}/respond`, { decision, text });
      const latest = await refresh(r.run.id);
      if (WORKING_STATUSES.includes(latest.status)) void drive(latest.id);
    } catch (e) {
      setError(e as CodeApiError);
      await refresh(run.id).catch(() => {});
    } finally {
      clearInterval(watch);
      setAnswering(false);
    }
  };

  const stop = async () => {
    if (!run) return;
    driveId.current++;
    setDriving(false);
    try {
      await post(`/api/code/agent/${run.id}/cancel`, {});
      await refresh(run.id);
    } catch (e) {
      setError(e as CodeApiError);
    }
  };

  const startAndContinue = async () => {
    setAnswering(true);
    const ok = await startComputer();
    setAnswering(false);
    if (ok) await respond("continue");
  };

  const ended = !!run && ENDED_STATUSES.includes(run.status);
  const working = !!run && WORKING_STATUSES.includes(run.status);
  const busy = driving || answering || !!run?.busy;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-s-line px-3">
        <Bot className="h-3.5 w-3.5 text-s-ink-3" />
        <span className="text-[11.5px] font-medium uppercase tracking-[0.08em] text-s-ink-3">Agent</span>
        {run && (
          <span
            className={cn(
              "ml-1 inline-flex items-center gap-1 rounded-full border px-2 py-px text-[11px]",
              working || busy ? "border-s-accent/50 text-s-ink" : run.status === "failed" ? "border-s-danger/50 text-s-danger" : "border-s-line text-s-ink-3",
            )}
          >
            {(busy || working) && !ended && <Loader2 className="h-3 w-3 animate-spin" />}
            {STATUS_LABEL[run.status]}
            {run.steps > 0 && ` · step ${run.steps}`}
          </span>
        )}
        {run && !ended && run.options.approvePlans && !run.plan?.approved && (
          <span
            className="inline-flex items-center gap-1 rounded-full border border-s-line px-2 py-px text-[11px] text-s-ink-3"
            title="The agent can read your files but can't change them or run commands until you approve its plan."
          >
            <ShieldCheck className="h-3 w-3" /> Read-only
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {run && !ended && (
            <button
              type="button"
              onClick={() => void stop()}
              className="inline-flex h-7 items-center gap-1 rounded-full border border-s-line px-2.5 text-[12px] text-s-ink-2 hover:border-s-danger hover:text-s-danger"
            >
              <Square className="h-3 w-3" /> Stop agent
            </button>
          )}
          {ended && (
            <button
              type="button"
              onClick={() => setRun(null)}
              className="inline-flex h-7 items-center gap-1 rounded-full border border-s-line px-2.5 text-[12px] text-s-ink-2 hover:border-s-line-strong hover:text-s-ink"
            >
              New request
            </button>
          )}
        </div>
      </div>

      <div className="s-scroll min-h-0 flex-1 overflow-y-auto p-3" aria-live="polite">
        {!loaded && <div className="s-skeleton h-24 w-full rounded-xl" />}

        {loaded && !run && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void start();
            }}
          >
            <label htmlFor="agent-ask" className="mb-1.5 block text-[13px] font-medium text-s-ink">
              What should the agent do?
            </label>
            <textarea
              id="agent-ask"
              value={request}
              onChange={(e) => setRequest(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void start();
                }
              }}
              rows={4}
              maxLength={8000}
              placeholder="e.g. “Add tests for the cart and make them pass”, “Fix the crash when the list is empty”, “Explain how routing works here”"
              className="block w-full resize-y rounded-xl border border-s-line bg-transparent p-2.5 text-[13.5px] leading-relaxed outline-none placeholder:text-s-ink-3 focus:border-s-line-strong"
            />
            <div className="mt-2 space-y-1.5 text-[12.5px] text-s-ink-2">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={approvePlans} onChange={(e) => setApprovePlans(e.target.checked)} />
                Show me the plan before changing anything
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={reviewEdits} onChange={(e) => setReviewEdits(e.target.checked)} />
                Let me review each set of edits before they&apos;re saved
              </label>
              <label className="flex flex-wrap items-center gap-2">
                Commands
                <select
                  value={commands}
                  onChange={(e) => setCommands(e.target.value as CommandMode)}
                  className="h-7 rounded-lg border border-s-line bg-s-bg px-1.5 text-[12.5px] text-s-ink outline-none"
                >
                  <option value="safe">Tests, builds and installs run; ask me for others</option>
                  <option value="ask">Ask me before every command</option>
                  <option value="off">Don&apos;t run commands</option>
                </select>
              </label>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <ModelSelector models={catalog?.models ?? null} value={modelId} onChange={setModelId} auto={catalog?.auto ?? null} />
              <button
                type="submit"
                disabled={!request.trim() || starting}
                className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-full bg-s-accent px-3.5 text-[12.5px] font-medium text-s-accent-ink transition hover:brightness-110 disabled:opacity-40"
              >
                <Bot className="h-3.5 w-3.5" /> {starting ? "Starting…" : "Start agent"}
              </button>
            </div>
            <p className="mt-3 text-[11.5px] leading-snug text-s-ink-3">
              The agent reads your files, plans, edits, and runs tests on the project&apos;s computer.
              {approvePlans ? " It's read-only until you approve its plan." : ""} It works while this page is open and you can stop it any time. Each step it takes counts like one chat message on your
              plan; commands use workspace minutes. Every change it makes can be reviewed and reverted in Changes. It never deploys, publishes or pushes on its own.
            </p>
          </form>
        )}

        {run && (
          <div className="space-y-2">
            <div className="rounded-xl border border-s-line bg-s-hover/40 px-3 py-2 text-[13px] leading-relaxed">
              <div className="text-[11px] uppercase tracking-[0.08em] text-s-ink-3">Your request</div>
              <p className="mt-0.5 whitespace-pre-wrap text-s-ink">{run.request}</p>
              <p className="mt-1 text-[11.5px] text-s-ink-3">
                {run.options.approvePlans ? "Plan approval on" : "No plan approval"} · {run.options.reviewEdits ? "edits reviewed" : "edits saved directly"} ·{" "}
                {run.options.commands === "safe" ? "safe commands run" : run.options.commands === "ask" ? "every command asks" : "no commands"}
              </p>
              {run.usage.modelCalls > 0 && <UsageLine run={run} />}
            </div>

            <ol className="space-y-1.5">
              {events.map((e) => (
                <EventRow key={e.id} event={e} />
              ))}
            </ol>

            {(driving || run.busy) && !ended && (
              <p className="flex items-center gap-2 px-1 text-[12.5px] text-s-ink-3">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> {run.pending?.kind === "job" ? `Running ${run.pending.command}…` : "Working…"}
              </p>
            )}

            {run.pending && !busy && <PendingCard run={run} computerOn={computerOn} onRespond={respond} onStartComputer={startAndContinue} />}

            {working && !busy && !error && (
              <div className="rounded-xl border border-s-line p-3 text-[13px]">
                <p className="text-s-ink-2">The agent is paused (the page was reloaded or a step didn&apos;t finish).</p>
                <button
                  type="button"
                  onClick={() => void drive(run.id)}
                  className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-full bg-s-accent px-3.5 text-[12.5px] font-medium text-s-accent-ink"
                >
                  <RotateCcw className="h-3.5 w-3.5" /> Continue
                </button>
              </div>
            )}

            {ended && <ReportCard run={run} onShowChanges={() => onShowChanges(run.id)} />}
          </div>
        )}

        {error && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-s-danger/40 px-3 py-2 text-[13px] text-s-danger" role="alert">
            <p className="min-w-0 flex-1">
              {error.message}{" "}
              {error.upgrade && (
                <a href="/pricing" className="underline">
                  See plans
                </a>
              )}
            </p>
            {run && working && (
              <button type="button" onClick={() => void drive(run.id)} className="shrink-0 rounded-full border border-s-line px-2 py-0.5 text-[12px] text-s-ink-2 hover:text-s-ink">
                Try again
              </button>
            )}
            <button type="button" onClick={() => setError(null)} aria-label="Dismiss" className="shrink-0 text-s-ink-3 hover:text-s-ink">
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
        <div ref={feedEnd} />
      </div>
    </div>
  );
}

const minutes = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`);
const usd = (n: number) => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

/** Tokens used against the run's budget, estimated cost and working time. */
function UsageLine({ run }: { run: RunView }) {
  const used = run.usage.inputTokens + run.usage.outputTokens;
  return (
    <p className="mt-1 text-[11.5px] text-s-ink-3">
      {used.toLocaleString()} of {run.tokenBudget.toLocaleString()} tokens
      {run.usage.estimated ? " (some estimated)" : ""} · {run.usage.costUsd === null ? "cost not known for this model" : `about ${usd(run.usage.costUsd)}`} · worked {minutes(run.activeMs)}
    </p>
  );
}

const VERIFY_STYLE: Record<RunReport["verification"], string> = {
  passed: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
  failed: "border-s-danger/50 text-s-danger",
  not_run: "border-s-line text-s-ink-2",
  stale: "border-amber-500/50 text-amber-600 dark:text-amber-400",
};

/** The end of a run: built by the server from what actually ran and changed; the agent's own words are labelled as such. */
function ReportCard({ run, onShowChanges }: { run: RunView; onShowChanges: () => void }) {
  const r = run.report;
  const title = run.status === "completed" ? "Done" : run.status === "failed" ? "Stopped with an error" : "Stopped";
  return (
    <section aria-label="Run report" className={cn("rounded-xl border p-3 text-[13px] leading-relaxed", run.status === "failed" ? "border-s-danger/40" : "border-s-line")}>
      <div className="flex flex-wrap items-center gap-2 font-medium text-s-ink">
        {run.status === "completed" ? (
          <Check className="h-4 w-4 text-emerald-500" />
        ) : run.status === "failed" ? (
          <AlertTriangle className="h-4 w-4 text-s-danger" />
        ) : (
          <Square className="h-3.5 w-3.5" />
        )}
        {title}
        {r && <span className={cn("rounded-full border px-2 py-px text-[11.5px] font-normal", VERIFY_STYLE[r.verification])}>{VERIFICATION_LABEL[r.verification]}</span>}
      </div>
      {run.error && <p className="mt-1 text-s-danger">{run.error}</p>}
      {r?.tests && (
        <p className="mt-1.5 text-[12.5px] text-s-ink-2">
          Last test run: <code className="font-mono text-[12px]">{r.tests.command}</code> —{" "}
          {r.tests.passed !== null || r.tests.failed !== null ? `${r.tests.passed ?? 0} passed, ${r.tests.failed ?? 0} failed` : `exit code ${r.tests.exitCode ?? "none"}`}
          {r.tests.failures.length > 0 && <span className="block text-s-danger">Failing: {r.tests.failures.join("; ")}</span>}
        </p>
      )}
      {r && r.files.length > 0 && (
        <div className="mt-2">
          <div className="text-[11px] uppercase tracking-[0.08em] text-s-ink-3">Files changed</div>
          <ul className="mt-0.5 space-y-0.5 font-mono text-[12px] text-s-ink-2">
            {r.files.map((f) => (
              <li key={f.path} className="flex gap-2">
                <span className="min-w-0 flex-1 truncate">{f.path}</span>
                <span className="shrink-0 text-s-ink-3">{f.change === "created" ? "new" : f.change === "deleted" ? "deleted" : ""}</span>
                <span className="shrink-0 text-emerald-600 dark:text-emerald-400">+{f.added}</span>
                <span className="shrink-0 text-s-danger">−{f.removed}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {r && r.files.length === 0 && <p className="mt-1.5 text-[12.5px] text-s-ink-3">No files were changed.</p>}
      {r && r.commands.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[12px] text-s-ink-3">
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
        <div className="mt-2">
          <div className="text-[11px] uppercase tracking-[0.08em] text-s-ink-3">Not resolved</div>
          <ul className="mt-0.5 list-disc space-y-0.5 pl-5 text-s-ink-2">
            {r.unresolved.map((u, i) => (
              <li key={i}>{u}</li>
            ))}
          </ul>
        </div>
      )}
      {run.summary && (
        <div className="mt-2">
          <div className="text-[11px] uppercase tracking-[0.08em] text-s-ink-3">The agent&apos;s summary</div>
          <p className="mt-0.5 whitespace-pre-wrap text-s-ink-2">{run.summary}</p>
        </div>
      )}
      {r && (
        <p className="mt-2 text-[11.5px] text-s-ink-3">
          {r.usage.steps} step{r.usage.steps === 1 ? "" : "s"} · {(r.usage.inputTokens + r.usage.outputTokens).toLocaleString()} tokens ·{" "}
          {r.usage.costUsd === null ? "cost not known" : `about ${usd(r.usage.costUsd)}`} · {r.usage.models.join(", ")}
          {r.checkpoints > 0 && ` · ${r.checkpoints} checkpoint${r.checkpoints === 1 ? "" : "s"}`}
        </p>
      )}
      <button
        type="button"
        onClick={onShowChanges}
        className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-full border border-s-line px-3 text-[12.5px] text-s-ink-2 hover:border-s-line-strong hover:text-s-ink"
      >
        <Undo2 className="h-3.5 w-3.5" /> Review diffs, restore or revert
      </button>
    </section>
  );
}

const LIMIT_TEXT: Record<LimitReason, { title: (p: { steps: number }) => string; body: string; go: string }> = {
  steps: { title: (p) => `The agent has taken ${p.steps} steps`, body: "Let it keep going? Each step counts like a chat message.", go: "Allow 10 more steps" },
  tokens: { title: () => "The agent has used its token budget", body: "Let it use more? Tokens count toward your plan's usage.", go: "Allow 300,000 more tokens" },
  time: { title: () => "The agent has been working a long time", body: "Let it keep going?", go: "Allow 15 more minutes" },
  tests: { title: () => "The tests keep failing", body: "The agent has tried several times without making the tests pass. Let it try again, or stop and look yourself.", go: "Allow 2 more attempts" },
  repeat: { title: () => "The agent is repeating itself", body: "It asked for the same actions three times in a row. Let it carry on with a different approach, or stop.", go: "Let it carry on" },
};

const ICONS: Record<string, ReactNode> = {
  status: <Bot className="h-3.5 w-3.5" />,
  note: <MessageSquare className="h-3.5 w-3.5" />,
  inspect: <Search className="h-3.5 w-3.5" />,
  plan: <ListChecks className="h-3.5 w-3.5" />,
  edit: <FileCode2 className="h-3.5 w-3.5" />,
  command: <TerminalIcon className="h-3.5 w-3.5" />,
  question: <CircleHelp className="h-3.5 w-3.5" />,
  answer: <MessageSquare className="h-3.5 w-3.5" />,
  approval: <ShieldCheck className="h-3.5 w-3.5" />,
  error: <AlertTriangle className="h-3.5 w-3.5" />,
  summary: <Check className="h-3.5 w-3.5" />,
  revert: <Undo2 className="h-3.5 w-3.5" />,
  git: <FileCode2 className="h-3.5 w-3.5" />,
};

function EventRow({ event: e }: { event: AgentEvent }) {
  const [open, setOpen] = useState(false);
  const d = e.detail ?? {};
  const output = typeof d.output === "string" ? d.output : null;
  const steps = Array.isArray(d.steps) ? (d.steps as string[]) : null;
  const failed = e.kind === "error" || (e.kind === "command" && (d.exitCode !== 0 || d.timedOut === true) && !d.blocked) || (e.kind === "command" && !!d.blocked);
  const passed = e.kind === "command" && d.exitCode === 0 && !d.timedOut;
  const expandable = !!output || (e.kind === "summary" && typeof d.summary === "string");
  return (
    <li className={cn("rounded-lg px-2 py-1 text-[12.5px] leading-snug", e.kind === "note" ? "text-s-ink-3" : "text-s-ink-2", (e.kind === "command" || e.kind === "plan") && "border border-s-line")}>
      <div className="flex items-start gap-2">
        <span className={cn("mt-0.5 shrink-0", failed ? "text-s-danger" : passed ? "text-emerald-500" : "text-s-ink-3")}>{ICONS[e.kind]}</span>
        {expandable ? (
          <button type="button" onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-start gap-1 text-left" aria-expanded={open}>
            <span className={cn("min-w-0 flex-1 break-words", e.kind === "command" && "font-mono text-[12px]")}>{e.title}</span>
            {open ? <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
          </button>
        ) : (
          <span className={cn("min-w-0 flex-1 break-words", e.kind === "plan" && "font-medium text-s-ink")}>{e.title}</span>
        )}
      </div>
      {steps && (
        <ol className="mt-1 list-decimal space-y-0.5 pl-9 text-s-ink-2">
          {steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      )}
      {open && output && (
        <pre className="s-scroll mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--s-code,transparent)] p-2 font-mono text-[11.5px] text-s-ink-2">
          {output || "(no output)"}
        </pre>
      )}
      {open && e.kind === "summary" && typeof d.summary === "string" && <p className="mt-1 whitespace-pre-wrap pl-5.5 text-s-ink-2">{d.summary}</p>}
    </li>
  );
}

function PendingCard({
  run,
  computerOn,
  onRespond,
  onStartComputer,
}: {
  run: RunView;
  computerOn: boolean;
  onRespond: (d: Decision, text?: string) => Promise<void>;
  onStartComputer: () => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [asking, setAsking] = useState(false);
  const p = run.pending!;
  const card = "rounded-xl border border-s-accent/50 bg-s-hover/30 p-3 text-[13px] leading-relaxed";
  const primary = "inline-flex h-8 items-center gap-1.5 rounded-full bg-s-accent px-3.5 text-[12.5px] font-medium text-s-accent-ink hover:brightness-110 disabled:opacity-40";
  const secondary = "inline-flex h-8 items-center gap-1.5 rounded-full border border-s-line px-3 text-[12.5px] text-s-ink-2 hover:border-s-line-strong hover:text-s-ink disabled:opacity-40";
  const feedback = (placeholder: string, label: string) => (
    <textarea
      value={text}
      onChange={(e) => setText(e.target.value)}
      rows={2}
      maxLength={4000}
      placeholder={placeholder}
      aria-label={label}
      className="mt-2 block w-full resize-y rounded-lg border border-s-line bg-transparent p-2 text-[13px] outline-none focus:border-s-line-strong"
    />
  );

  if (p.kind === "plan" && run.plan) {
    return (
      <div className={card}>
        <div className="font-medium text-s-ink">Approve the plan?</div>
        <p className="mt-1 text-s-ink-2">{run.plan.summary}</p>
        <ol className="mt-1.5 list-decimal space-y-0.5 pl-5 text-s-ink-2">
          {run.plan.steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
        {asking && feedback("What should change in the plan?", "Plan changes")}
        <div className="mt-2.5 flex flex-wrap gap-2">
          {!asking ? (
            <>
              <button type="button" className={primary} onClick={() => void onRespond("approve")}>
                <Check className="h-3.5 w-3.5" /> Approve and start
              </button>
              <button type="button" className={secondary} onClick={() => setAsking(true)}>
                Change the plan
              </button>
            </>
          ) : (
            <>
              <button type="button" className={primary} disabled={!text.trim()} onClick={() => void onRespond("reject", text)}>
                Send changes
              </button>
              <button type="button" className={secondary} onClick={() => setAsking(false)}>
                Cancel
              </button>
            </>
          )}
        </div>
      </div>
    );
  }
  if (p.kind === "command") {
    return (
      <div className={card}>
        <div className="font-medium text-s-ink">Allow this command?</div>
        <pre className="mt-1.5 whitespace-pre-wrap break-all rounded-md bg-[var(--s-code,transparent)] p-2 font-mono text-[12px] text-s-ink">{p.command}</pre>
        <p className="mt-1.5 text-[12px] text-s-ink-3">{p.reason} It runs in the project&apos;s own computer, which can only reach npm and PyPI.</p>
        {feedback("Optional: why not, or what to do instead", "Feedback")}
        <div className="mt-2.5 flex flex-wrap gap-2">
          <button type="button" className={primary} onClick={() => void onRespond("approve")}>
            <Check className="h-3.5 w-3.5" /> Run it
          </button>
          <button type="button" className={secondary} onClick={() => void onRespond("reject", text || undefined)}>
            Don&apos;t run
          </button>
        </div>
      </div>
    );
  }
  if (p.kind === "edits") {
    return (
      <div className={card}>
        <div className="font-medium text-s-ink">
          Review {p.changes.length} file change
          {p.changes.length === 1 ? "" : "s"}
        </div>
        <p className="text-[12px] text-s-ink-3">Nothing is saved until you approve.</p>
        <div className="mt-2 space-y-2">
          {p.changes.map((c) => (
            <FileDiff key={c.path} change={c} />
          ))}
        </div>
        {feedback("Optional: what to do differently", "Feedback")}
        <div className="mt-2.5 flex flex-wrap gap-2">
          <button type="button" className={primary} onClick={() => void onRespond("approve")}>
            <Check className="h-3.5 w-3.5" /> Save these changes
          </button>
          <button type="button" className={secondary} onClick={() => void onRespond("reject", text || undefined)}>
            Reject
          </button>
        </div>
      </div>
    );
  }
  if (p.kind === "question") {
    return (
      <div className={card}>
        <div className="font-medium text-s-ink">The agent asks</div>
        <p className="mt-1 whitespace-pre-wrap text-s-ink-2">{p.question}</p>
        {p.options.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {p.options.map((o) => (
              <button key={o} type="button" className={secondary} onClick={() => void onRespond("answer", o)}>
                {o}
              </button>
            ))}
          </div>
        )}
        {feedback("Type your answer", "Your answer")}
        <div className="mt-2.5 flex gap-2">
          <button type="button" className={primary} disabled={!text.trim()} onClick={() => void onRespond("answer", text)}>
            Answer
          </button>
        </div>
      </div>
    );
  }
  if (p.kind === "computer") {
    return (
      <div className={card}>
        <div className="font-medium text-s-ink">The agent needs the project&apos;s computer</div>
        <p className="mt-1 text-s-ink-2">
          To run <code className="font-mono text-[12px]">{p.command}</code>, the project&apos;s computer has to be on. Starting it uses workspace minutes from your plan.
        </p>
        <div className="mt-2.5 flex flex-wrap gap-2">
          {computerOn ? (
            <button type="button" className={primary} onClick={() => void onRespond("continue")}>
              Continue
            </button>
          ) : (
            <button type="button" className={primary} onClick={() => void onStartComputer()}>
              <Power className="h-3.5 w-3.5" /> Start the computer and continue
            </button>
          )}
          <button type="button" className={secondary} onClick={() => void onRespond("reject")}>
            Continue without running it
          </button>
        </div>
      </div>
    );
  }
  if (p.kind === "limit") {
    const t = LIMIT_TEXT[p.reason ?? "steps"];
    return (
      <div className={card}>
        <div className="font-medium text-s-ink">{t.title(p)}</div>
        <p className="mt-1 text-s-ink-2">
          {p.detail ? `${p.detail} ` : ""}
          {t.body}
        </p>
        <div className="mt-2.5 flex flex-wrap gap-2">
          <button type="button" className={primary} onClick={() => void onRespond("continue")}>
            {t.go}
          </button>
          <button type="button" className={secondary} onClick={() => void onRespond("stop")}>
            Stop here
          </button>
        </div>
      </div>
    );
  }
  return null;
}
