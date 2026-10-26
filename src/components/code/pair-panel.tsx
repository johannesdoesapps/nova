"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Bot, Check, CircleCheck, CircleDashed, CircleX, ClipboardList, FileCode2, Loader2, Play, RotateCcw, Send, ShieldCheck, Square, Undo2, X } from "lucide-react";
import { useCatalog } from "@/components/common/model-picker";
import { ModelSelector } from "@/components/studio/model-selector";
import { taskTitle } from "@/lib/code/agent/history";
import { ENDED_STATUSES, WORKING_STATUSES, type AgentEvent, type Decision, type RunView } from "@/lib/code/agent/types";
import { TASK_STATE_INFO, taskState } from "@/lib/code/agent/verdict";
import { DEFAULT_ROUNDS, MAX_ROUNDS, openFindings, type Agent, type PairFinding, type PairState } from "@/lib/code/pair/protocol";
import { cn } from "@/lib/utils";
import { PendingCard } from "./agent-panel";
import { api, CodeApiError, post } from "./api";
import { CODE_AUTO } from "./use-code-model";

/**
 * Pair coding in a project: an Architect and a Reviewer, each with its own model, take turns on one task
 * (plan → code → tests → review → revision → verification, up to a set number of rounds). This panel
 * starts a pair task, keeps it stepping while the page is open, and shows each agent's work in its own
 * column — with what it's writing right now — plus the findings, the tests, anything waiting for you,
 * and the final result. Files, diffs, the terminal and the preview are the workspace's.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Detail = {
  pair?: {
    agent?: Agent;
    phase?: string;
    round?: number;
    model?: string;
    plan?: PairState["plan"];
    findings?: PairFinding[];
    verdict?: string;
    summary?: string;
    files?: string[];
    notes?: string;
    responses?: { id: string; decision: string; reason: string }[];
    final?: PairState["final"];
    testAssessment?: string;
  };
};
const pairOf = (e: AgentEvent) => (e.detail as Detail | null)?.pair;

export interface PairSettingsInput {
  architect: string;
  reviewer: string;
  maxRounds: number;
  approvePlan: boolean;
  runTests: boolean;
}

/** Each agent's model, how many review rounds, and whether to approve the plan and run tests. */
export function PairSettingsForm({ value, onChange }: { value: PairSettingsInput; onChange: (v: PairSettingsInput) => void }) {
  const catalog = useCatalog();
  const box = "rounded-xl border border-s-line p-3";
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {(["architect", "reviewer"] as const).map((a) => (
        <div key={a} className={box}>
          <div className="flex items-center gap-2 text-[13px] font-medium text-s-ink">
            {a === "architect" ? <ClipboardList className="h-4 w-4 text-sky-500" aria-hidden /> : <ShieldCheck className="h-4 w-4 text-violet-500" aria-hidden />}
            {a === "architect" ? "Architect" : "Reviewer"}
          </div>
          <p className="mt-0.5 text-[12px] text-s-ink-3">{a === "architect" ? "Plans, writes the code, answers each finding." : "Reviews independently with evidence, checks each fix."}</p>
          <div className="mt-2">
            <ModelSelector models={catalog?.models ?? null} value={value[a]} onChange={(id) => onChange({ ...value, [a]: id })} auto={catalog?.auto ?? null} className="min-w-0 !shrink" />
          </div>
        </div>
      ))}
      <div className={cn(box, "sm:col-span-2 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-s-ink-2")}>
        <label className="flex items-center gap-2">
          Review rounds
          <select value={value.maxRounds} onChange={(e) => onChange({ ...value, maxRounds: Number(e.target.value) })} className="h-8 rounded-lg border border-s-line bg-transparent px-2 text-[13px]">
            {Array.from({ length: MAX_ROUNDS }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                up to {n}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={value.approvePlan} onChange={(e) => onChange({ ...value, approvePlan: e.target.checked })} className="h-4 w-4 accent-[var(--s-accent)]" />
          Approve the plan first
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={value.runTests} onChange={(e) => onChange({ ...value, runTests: e.target.checked })} className="h-4 w-4 accent-[var(--s-accent)]" />
          Run tests in the project&apos;s computer
        </label>
      </div>
      <PairCostNote value={value} models={catalog?.models ?? null} />
      {value.architect === value.reviewer && value.architect !== CODE_AUTO && (
        <p className="sm:col-span-2 text-[12px] text-amber-700 dark:text-amber-300">Both agents use the same model. A different model for the Reviewer usually catches more.</p>
      )}
    </div>
  );
}

export const DEFAULT_PAIR: PairSettingsInput = { architect: CODE_AUTO, reviewer: CODE_AUTO, maxRounds: DEFAULT_ROUNDS, approvePlan: true, runTests: true };

/** Start a pair task in a project; returns the new run. */
export async function startPair(projectId: string, request: string, s: PairSettingsInput, continueFrom?: string | null): Promise<RunView> {
  const r = await post<{ run: RunView }>(`/api/code/projects/${projectId}/agent`, {
    request,
    options: { modelId: null },
    pair: { architect: s.architect, reviewer: s.reviewer, maxRounds: s.maxRounds, approvePlan: s.approvePlan, runTests: s.runTests },
    ...(continueFrom ? { continueFrom } : {}),
  });
  return r.run;
}

export function PairPanel({
  projectId,
  initialRunId,
  computerOn,
  startComputer,
  onFilesChanged,
  onShowChanges,
  onOpenFile,
  onOpenPreview,
  onRunChange,
}: {
  projectId: string;
  /** The task to show; undefined: the project's latest pair task; null: a new one. */
  initialRunId?: string | null;
  computerOn: boolean;
  startComputer: () => Promise<boolean>;
  onFilesChanged: () => void;
  onShowChanges: (runId: string) => void;
  onOpenFile: (path: string) => void;
  onOpenPreview?: () => void;
  onRunChange: (run: RunView | null) => void;
}) {
  const [run, setRun] = useState<RunView | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<CodeApiError | null>(null);
  const [driving, setDriving] = useState(false);
  const [request, setRequest] = useState("");
  const [settings, setSettings] = useState<PairSettingsInput>(DEFAULT_PAIR);
  const [starting, setStarting] = useState(false);
  const [note, setNote] = useState("");
  const [noteSent, setNoteSent] = useState<string | null>(null);
  const [mobileAgent, setMobileAgent] = useState<Agent>("architect");
  const [continueFrom, setContinueFrom] = useState<string | null>(null);
  const lastSeq = useRef(0);
  const alive = useRef(true);
  const driveId = useRef(0);
  const shown = useRef<RunView | null>(null);
  const runChanged = useRef(onRunChange);
  runChanged.current = onRunChange;
  const filesChanged = useRef(onFilesChanged);
  filesChanged.current = onFilesChanged;

  const refresh = useCallback(async (id: string): Promise<RunView> => {
    const known = shown.current?.id === id ? shown.current : null;
    const r = await api<{ run: RunView; events: AgentEvent[] } | { unchanged: true; busy: boolean; stepStartedAt: string | null; events: AgentEvent[] }>(
      `/api/code/agent/${id}?after=${lastSeq.current}${known ? `&known=${encodeURIComponent(known.version)}` : ""}`,
    );
    const current = "unchanged" in r ? { ...known!, busy: r.busy, stepStartedAt: r.stepStartedAt } : r.run;
    if (!alive.current) return current;
    shown.current = current;
    setRun(current);
    if (!("unchanged" in r)) runChanged.current(current);
    const fresh = r.events.filter((e) => e.seq > lastSeq.current);
    if (fresh.length) {
      lastSeq.current = fresh[fresh.length - 1]!.seq;
      setEvents((ev) => [...ev, ...fresh]);
      if (fresh.some((e) => e.kind === "edit" || e.kind === "revert" || e.kind === "command")) filesChanged.current();
    }
    return current;
  }, []);

  const drive = useCallback(
    async (id: string) => {
      const me = ++driveId.current;
      setDriving(true);
      setError(null);
      try {
        let expectStep = (await refresh(id)).steps;
        for (;;) {
          if (!alive.current || driveId.current !== me) return;
          const watch = setInterval(() => void refresh(id).catch(() => {}), 1500);
          let res: { run: RunView; skipped?: string };
          try {
            res = await post(`/api/code/agent/${id}/step`, { expectStep });
          } finally {
            clearInterval(watch);
          }
          const latest = await refresh(id);
          expectStep = latest.steps;
          if (!WORKING_STATUSES.includes(latest.status)) return;
          if (res.skipped === "busy") await sleep(3000);
        }
      } catch (e) {
        if (alive.current) setError(e as CodeApiError);
      } finally {
        if (driveId.current === me) setDriving(false);
      }
    },
    [refresh],
  );

  // First load: the task asked for, or the project's latest pair task.
  useEffect(() => {
    alive.current = true;
    const load = async () => {
      if (initialRunId === null) return;
      let id = initialRunId;
      if (id === undefined) {
        const { runs } = await api<{ runs: RunView[] }>(`/api/code/projects/${projectId}/agent`);
        id = runs.find((r) => r.options.pair)?.id;
      }
      if (!id) return;
      const r = await refresh(id);
      // A task created a moment ago (from the start screen) begins at once; an older one waits for Continue.
      if (WORKING_STATUSES.includes(r.status) && r.steps === 0 && !r.busy) void drive(id);
    };
    load()
      .catch((e: CodeApiError) => alive.current && setError(e))
      .finally(() => alive.current && setLoaded(true));
    return () => {
      alive.current = false;
    };
  }, [projectId, initialRunId, refresh, drive]);

  // Not stepping it here (another tab, or waiting): keep it fresh.
  const ended = !!run && ENDED_STATUSES.includes(run.status);
  useEffect(() => {
    if (!run || ended || driving) return;
    const t = setInterval(() => void refresh(run.id).catch(() => {}), run.busy ? 2000 : 5000);
    return () => clearInterval(t);
  }, [run, ended, driving, refresh]);

  const start = async () => {
    if (!request.trim() || starting) return;
    setStarting(true);
    setError(null);
    try {
      const r = await startPair(projectId, request.trim(), settings, continueFrom);
      lastSeq.current = 0;
      setEvents([]);
      shown.current = r;
      setRun(r);
      runChanged.current(r);
      setRequest("");
      setContinueFrom(null);
      void drive(r.id);
    } catch (e) {
      setError(e as CodeApiError);
    } finally {
      setStarting(false);
    }
  };

  const respond = async (decision: Decision, text?: string) => {
    if (!run) return;
    setError(null);
    try {
      await post(`/api/code/agent/${run.id}/respond`, { decision, text });
      const latest = await refresh(run.id);
      if (WORKING_STATUSES.includes(latest.status)) void drive(latest.id);
    } catch (e) {
      setError(e as CodeApiError);
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

  const sendNote = async () => {
    if (!run || !note.trim()) return;
    try {
      await post(`/api/code/agent/${run.id}/note`, { text: note.trim() });
      setNoteSent(note.trim());
      setNote("");
      await refresh(run.id);
    } catch (e) {
      setError(e as CodeApiError);
    }
  };

  const undoAll = async () => {
    if (!run || !confirm("Undo every file change this pair task made? Files changed since by something else are left alone and listed.")) return;
    try {
      const r = await post<{ reverted: string[]; conflicts: string[] }>(`/api/code/agent/${run.id}/revert`, {});
      filesChanged.current();
      await refresh(run.id);
      if (r.conflicts.length) setError(new CodeApiError(`Undid ${r.reverted.length} file(s). Not undone because they changed since: ${r.conflicts.join(", ")}`, 409, null, null));
    } catch (e) {
      setError(e as CodeApiError);
    }
  };

  const s = run?.pair ?? null;
  const state = run ? taskState(run) : null;
  const live = s?.live && run && !ended ? s.live : null;
  const byAgent = useMemo(() => {
    const out: Record<Agent, AgentEvent[]> = { architect: [], reviewer: [] };
    for (const e of events) {
      const a = pairOf(e)?.agent;
      if (a) out[a].push(e);
    }
    return out;
  }, [events]);
  const general = events.filter((e) => !pairOf(e)?.agent && !(e.detail as { screenshot?: string } | null)?.screenshot);

  if (!loaded) return <div className="p-6 text-[13px] text-s-ink-3">Loading…</div>;

  // ---------------------------------------------------------------- no task yet
  if (!run || !s) {
    return (
      <div className="s-scroll h-full overflow-y-auto p-4 sm:p-6">
        <div className="mx-auto max-w-[820px]">
          <h2 className="text-[18px] font-medium text-s-ink">Pair coding</h2>
          <p className="mt-1 text-[13.5px] leading-relaxed text-s-ink-2">
            Two AI models work on your task: the <strong className="text-s-ink">Architect</strong> plans and writes the code; the <strong className="text-s-ink">Reviewer</strong> reviews it with
            evidence, runs the tests when it can, and checks every fix. They go back and forth until the review passes or the rounds you allow are used, and you can stop, approve or add instructions
            at any time.
          </p>
          {continueFrom && (
            <p className="mt-3 rounded-xl border border-s-line px-3 py-2 text-[12.5px] text-s-ink-2">
              This task continues the previous one: the Architect gets its request, summary and changed files.
            </p>
          )}
          {run && !s && (
            <p className="mt-3 rounded-xl border border-s-line px-3 py-2 text-[12.5px] text-s-ink-2">
              The session you opened is an ordinary coding-agent task, not a pair task.{" "}
              <a href={`/code/${projectId}?run=${run.id}`} className="underline underline-offset-2">
                Open it in Code
              </a>
              , or start a pair task below.
            </p>
          )}
          <label htmlFor="pair-request" className="mt-4 block text-[13px] font-medium text-s-ink">
            What should they build or change?
          </label>
          <textarea
            id="pair-request"
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            rows={4}
            maxLength={8000}
            placeholder="e.g. A REST API for a todo list in Node.js with input validation and tests"
            className="mt-1.5 block w-full resize-y s-card rounded-2xl bg-transparent p-3 text-[14px] outline-none placeholder:text-s-ink-3 focus:border-s-line-strong"
          />
          <div className="mt-3">
            <PairSettingsForm value={settings} onChange={setSettings} />
          </div>
          {error && <ErrorLine error={error} onClose={() => setError(null)} />}
          <button
            type="button"
            onClick={() => void start()}
            disabled={!request.trim() || starting}
            className="mt-4 inline-flex h-10 items-center gap-2 rounded-full bg-s-accent px-5 text-[14px] font-medium text-s-accent-ink transition hover:brightness-110 disabled:opacity-40"
          >
            {starting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />} Start pair task
          </button>
          <p className="mt-2 text-[12px] text-s-ink-3">Each agent call counts toward your plan like a coding-agent step. Code runs only on this project&apos;s private computer.</p>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------- a task
  const open = openFindings(s);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-s-line px-3 py-2.5 sm:px-4">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "rounded-full border px-2 py-0.5 text-[12px]",
              state === "verified" ? "border-emerald-500/50 text-emerald-700 dark:text-emerald-300" : state === "failed" ? "border-s-danger/50 text-s-danger" : "border-s-line text-s-ink-2",
            )}
          >
            {state ? TASK_STATE_INFO[state].label : ""}
          </span>
          <span className="text-[12.5px] text-s-ink-3">
            Round {Math.min(s.round, s.settings.maxRounds)} of up to {s.settings.maxRounds} · {open.length} open finding{open.length === 1 ? "" : "s"} · {run.steps} steps
            {run.usage.costUsd !== null ? ` · $${run.usage.costUsd.toFixed(run.usage.costUsd < 0.01 ? 4 : 2)}` : ""}
          </span>
          <span className="ml-auto flex items-center gap-2">
            {!ended && (
              <button
                type="button"
                onClick={() => void stop()}
                className="inline-flex h-8 items-center gap-1.5 rounded-full border border-s-line px-3 text-[12.5px] text-s-ink-2 hover:border-s-line-strong hover:text-s-ink"
              >
                <Square className="h-3.5 w-3.5" aria-hidden /> Stop
              </button>
            )}
            {ended && (
              <button
                type="button"
                onClick={() => {
                  setContinueFrom(run.id);
                  setRun(null);
                  setEvents([]);
                  lastSeq.current = 0;
                  shown.current = null;
                  runChanged.current(null);
                }}
                className="inline-flex h-8 items-center gap-1.5 rounded-full border border-s-line px-3 text-[12.5px] text-s-ink-2 hover:border-s-line-strong hover:text-s-ink"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Request revisions
              </button>
            )}
          </span>
        </div>
        <p className="mt-1 line-clamp-2 text-[13.5px] text-s-ink">{taskTitle(run.request)}</p>
      </div>

      <div className="s-scroll min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-4">
        {run.pending && !driving && <PendingCard run={run} computerOn={computerOn} onRespond={respond} onStartComputer={async () => void (await startComputer())} />}
        {!ended && !driving && WORKING_STATUSES.includes(run.status) && !run.busy && (
          <div className="mb-3 flex flex-wrap items-center gap-2 s-card rounded-2xl p-3 text-[13px] text-s-ink-2">
            The agents are paused (the page was reloaded or a step didn&apos;t finish). Nothing is lost.
            <button type="button" onClick={() => void drive(run.id)} className="inline-flex h-8 items-center gap-1.5 rounded-full bg-s-accent px-3.5 text-[12.5px] font-medium text-s-accent-ink">
              <Play className="h-3.5 w-3.5" aria-hidden /> Continue
            </button>
          </div>
        )}
        {error && <ErrorLine error={error} onClose={() => setError(null)} />}

        {/* Phones: one agent at a time. */}
        <div role="tablist" aria-label="Agent" className="mb-2 flex gap-1 lg:hidden">
          {(["architect", "reviewer"] as const).map((a) => (
            <button
              key={a}
              role="tab"
              aria-selected={mobileAgent === a}
              onClick={() => setMobileAgent(a)}
              className={cn("h-8 flex-1 rounded-full border text-[12.5px]", mobileAgent === a ? "border-s-line-strong bg-s-hover text-s-ink" : "border-s-line text-s-ink-3")}
            >
              {a === "architect" ? "Architect" : "Reviewer"}
              {live?.agent === a ? " · working" : ""}
            </button>
          ))}
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          {(["architect", "reviewer"] as const).map((a) => (
            <AgentColumn
              key={a}
              agent={a}
              model={s.models[a]}
              events={byAgent[a]}
              live={live?.agent === a ? live : null}
              className={cn(mobileAgent !== a && "hidden lg:flex")}
              onOpenFile={onOpenFile}
            />
          ))}
        </div>

        <Findings findings={s.findings} />
        <Tests tests={s.tests} />

        {general.length > 0 && (
          <details className="mt-3 s-card rounded-2xl p-3 text-[12.5px]">
            <summary className="cursor-pointer text-s-ink-2">Activity ({general.length})</summary>
            <ul className="mt-2 space-y-1 text-s-ink-3">
              {general.map((e) => (
                <li key={e.id}>
                  <time className="mr-2 tabular-nums" suppressHydrationWarning>
                    {new Date(e.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}
                  </time>
                  {e.title}
                </li>
              ))}
            </ul>
          </details>
        )}

        {ended && <FinalCard run={run} s={s} onShowChanges={() => onShowChanges(run.id)} onOpenFile={onOpenFile} onOpenPreview={onOpenPreview} onUndo={() => void undoAll()} />}
      </div>

      {!ended && (
        <div className="shrink-0 border-t border-s-line p-2.5 sm:px-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void sendNote();
            }}
            className="flex items-end gap-2"
          >
            <label htmlFor="pair-note" className="sr-only">
              Instructions for the agents
            </label>
            <textarea
              id="pair-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={1}
              maxLength={4000}
              placeholder="Add instructions — the next agent to work gets them"
              className="min-h-9 flex-1 resize-y rounded-xl border border-s-line bg-transparent px-3 py-2 text-[13px] outline-none placeholder:text-s-ink-3 focus:border-s-line-strong"
            />
            <button type="submit" disabled={!note.trim()} aria-label="Send instructions" className="grid h-9 w-9 place-items-center rounded-full bg-s-accent text-s-accent-ink disabled:opacity-40">
              <Send className="h-4 w-4" />
            </button>
          </form>
          {noteSent && <p className="mt-1 text-[12px] text-s-ink-3">Sent: “{noteSent.slice(0, 120)}” — the next agent call gets it.</p>}
        </div>
      )}
    </div>
  );
}

function ErrorLine({ error, onClose }: { error: CodeApiError; onClose: () => void }) {
  return (
    <div role="alert" className="mb-3 mt-3 flex items-start gap-2 rounded-xl border border-s-danger/40 px-3 py-2 text-[13px] text-s-danger">
      <p className="min-w-0 flex-1">
        {error.message}{" "}
        {error.upgrade && (
          <a href="/pricing" className="underline">
            See plans
          </a>
        )}
      </p>
      <button type="button" onClick={onClose} aria-label="Dismiss" className="shrink-0 text-s-ink-3 hover:text-s-ink">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

function AgentColumn({
  agent,
  model,
  events,
  live,
  className,
  onOpenFile,
}: {
  agent: Agent;
  model?: string;
  events: AgentEvent[];
  live: PairState["live"];
  className?: string;
  onOpenFile: (p: string) => void;
}) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [events.length, live?.text.length]);
  return (
    <section
      aria-label={agent === "architect" ? "Architect" : "Reviewer"}
      className={cn("flex min-h-[220px] flex-col rounded-2xl border p-3", agent === "architect" ? "border-sky-500/30" : "border-violet-500/30", className)}
    >
      <header className="flex items-center gap-2">
        {agent === "architect" ? <ClipboardList className="h-4 w-4 text-sky-500" aria-hidden /> : <ShieldCheck className="h-4 w-4 text-violet-500" aria-hidden />}
        <h3 className="text-[13.5px] font-medium text-s-ink">{agent === "architect" ? "Architect" : "Reviewer"}</h3>
        <span className="truncate text-[12px] text-s-ink-3">{model ?? ""}</span>
        {live && (
          <span className="ml-auto inline-flex items-center gap-1 text-[12px] text-s-ink-2" role="status">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />{" "}
            {live.phase === "review" ? "reviewing" : live.phase === "plan" ? "planning" : live.phase === "final" ? "writing the summary" : "writing code"}
          </span>
        )}
      </header>
      <div className="mt-2 min-h-0 flex-1 space-y-2 text-[13px]">
        {events.length === 0 && !live && <p className="text-s-ink-3">{agent === "architect" ? "Waiting to plan." : "Waits for the Architect's first version."}</p>}
        {events.map((e) => (
          <AgentEventCard key={e.id} e={e} onOpenFile={onOpenFile} />
        ))}
        {live && (
          <pre aria-live="off" className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-s-hover/60 p-2 font-mono text-[11.5px] leading-snug text-s-ink-2">
            {live.text || "…"}
          </pre>
        )}
        <div ref={end} />
      </div>
    </section>
  );
}

function AgentEventCard({ e, onOpenFile }: { e: AgentEvent; onOpenFile: (p: string) => void }) {
  const d = (e.detail as Detail | null)?.pair;
  if (d?.plan) {
    const p = d.plan;
    return (
      <div className="rounded-xl border border-s-line p-2.5">
        <div className="text-[12px] font-medium uppercase tracking-[0.06em] text-s-ink-3">Plan</div>
        <p className="mt-0.5 text-s-ink">{p.summary}</p>
        {p.architecture && <p className="mt-1 text-[12.5px] text-s-ink-2">{p.architecture}</p>}
        {p.tasks.length > 0 && (
          <ol className="mt-1 list-decimal pl-5 text-[12.5px] text-s-ink-2">
            {p.tasks.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ol>
        )}
        {p.decisions.length > 0 && (
          <ul className="mt-1 space-y-0.5 text-[12px] text-s-ink-3">
            {p.decisions.map((x, i) => (
              <li key={i}>
                <span className="text-s-ink-2">{x.decision}</span> — {x.why}
              </li>
            ))}
          </ul>
        )}
        {p.testCommand && (
          <p className="mt-1 text-[12px] text-s-ink-3">
            Tests: <code className="font-mono">{p.testCommand}</code>
          </p>
        )}
      </div>
    );
  }
  if (d?.findings && d.verdict) {
    return (
      <div className="rounded-xl border border-s-line p-2.5">
        <div className="flex items-center gap-1.5 text-[12.5px] font-medium">
          {d.verdict === "approve" ? (
            <CircleCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden />
          ) : (
            <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" aria-hidden />
          )}
          Round {d.round}: {d.verdict === "approve" ? "approved" : "changes requested"}
        </div>
        {d.summary && <p className="mt-0.5 text-[12.5px] text-s-ink-2">{d.summary}</p>}
        {d.findings.length > 0 && (
          <ul className="mt-1 space-y-0.5 text-[12.5px]">
            {d.findings.map((f) => (
              <li key={f.id}>
                <span className="font-mono text-s-ink-3">{f.id}</span> <Sev s={f.severity} /> {f.title}
              </li>
            ))}
          </ul>
        )}
        {d.testAssessment && <p className="mt-1 text-[12px] text-s-ink-3">Tests: {d.testAssessment}</p>}
      </div>
    );
  }
  if (d?.responses) {
    return (
      <div className="rounded-xl border border-s-line p-2.5">
        <div className="text-[12.5px] font-medium">{e.title}</div>
        <ul className="mt-1 space-y-1 text-[12.5px] text-s-ink-2">
          {d.responses.map((r) => (
            <li key={r.id}>
              <span className="font-mono text-s-ink-3">{r.id}</span> {r.decision === "accept" ? "Accepted" : "Rejected"}: {r.reason}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (d?.files) {
    return (
      <div className="rounded-xl border border-s-line p-2.5">
        <div className="text-[12.5px] font-medium">
          {d.files.length ? `${d.phase === "implement" ? "Wrote" : "Revised"} ${d.files.length} file${d.files.length === 1 ? "" : "s"}` : "No files changed"}
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          {d.files.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onOpenFile(p)}
              className="inline-flex items-center gap-1 rounded-md border border-s-line px-1.5 py-0.5 font-mono text-[11.5px] text-s-ink-2 hover:text-s-ink"
            >
              <FileCode2 className="h-3 w-3" aria-hidden /> {p}
            </button>
          ))}
        </div>
        {d.notes && <p className="mt-1 whitespace-pre-wrap text-[12.5px] text-s-ink-2">{d.notes}</p>}
      </div>
    );
  }
  return <p className={cn("text-[12.5px]", e.kind === "error" ? "text-s-danger" : "text-s-ink-2")}>{e.title}</p>;
}

function Sev({ s }: { s: PairFinding["severity"] }) {
  return (
    <span
      className={cn(
        "rounded px-1 text-[11px] uppercase tracking-wide",
        s === "critical" ? "bg-s-danger/15 text-s-danger" : s === "major" ? "bg-amber-500/15 text-amber-700 dark:text-amber-300" : "bg-s-hover text-s-ink-3",
      )}
    >
      {s}
    </span>
  );
}

/** Every finding across rounds: severity, where, the evidence, the Architect's answer and where it stands. */
function Findings({ findings }: { findings: PairFinding[] }) {
  const [openOnly, setOpenOnly] = useState(false);
  if (!findings.length) return null;
  const list = openOnly ? findings.filter((f) => f.status === "open") : findings;
  const icon = { open: CircleDashed, fixed: CircleCheck, rejected: CircleX } as const;
  return (
    <section aria-label="Review findings" className="mt-3 s-card rounded-2xl p-3">
      <div className="flex items-center gap-2">
        <h3 className="text-[13.5px] font-medium text-s-ink">Findings</h3>
        <span className="text-[12px] text-s-ink-3">
          {findings.filter((f) => f.status === "open").length} open · {findings.filter((f) => f.status === "fixed").length} fixed · {findings.filter((f) => f.status === "rejected").length} rejected
        </span>
        <label className="ml-auto flex items-center gap-1.5 text-[12px] text-s-ink-2">
          <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} className="h-3.5 w-3.5" /> Open only
        </label>
      </div>
      <ul className="mt-2 space-y-1.5">
        {list.map((f) => {
          const I = icon[f.status];
          return (
            <li key={f.id}>
              <details className="rounded-xl border border-s-line px-2.5 py-1.5">
                <summary className="flex cursor-pointer items-center gap-1.5 text-[12.5px]">
                  <I
                    className={cn(
                      "h-3.5 w-3.5 shrink-0",
                      f.status === "fixed" ? "text-emerald-600 dark:text-emerald-400" : f.status === "rejected" ? "text-s-ink-3" : "text-amber-600 dark:text-amber-400",
                    )}
                    aria-hidden
                  />
                  <span className="font-mono text-s-ink-3">{f.id}</span>
                  <Sev s={f.severity} />
                  <span className="min-w-0 flex-1 truncate text-s-ink">{f.title}</span>
                  <span className="shrink-0 text-s-ink-3">{f.status === "open" ? "Open" : f.status === "fixed" ? `Fixed (round ${f.closedRound})` : "Rejected"}</span>
                </summary>
                <div className="mt-1.5 space-y-1 text-[12.5px] text-s-ink-2">
                  <p>
                    <span className="text-s-ink-3">{f.category}</span>
                    {f.file && (
                      <span className="ml-2 font-mono text-s-ink-3">
                        {f.file}
                        {f.line ? `:${f.line}` : ""}
                      </span>
                    )}
                  </p>
                  <p>
                    <span className="text-s-ink-3">Evidence: </span>
                    <span className="whitespace-pre-wrap font-mono text-[12px]">{f.evidence}</span>
                  </p>
                  {f.suggestion && (
                    <p>
                      <span className="text-s-ink-3">Suggestion: </span>
                      {f.suggestion}
                    </p>
                  )}
                  {f.response && (
                    <p>
                      <span className="text-s-ink-3">Architect {f.response.decision === "accept" ? "accepted" : "rejected"}: </span>
                      {f.response.reason}
                    </p>
                  )}
                </div>
              </details>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Tests({ tests }: { tests: PairState["tests"] }) {
  if (!tests.length) return null;
  return (
    <section aria-label="Test runs" className="mt-3 s-card rounded-2xl p-3">
      <h3 className="text-[13.5px] font-medium text-s-ink">Tests</h3>
      <ul className="mt-1.5 space-y-1 text-[12.5px]">
        {tests.map((t, i) => (
          <li key={i}>
            <details>
              <summary className="cursor-pointer">
                <span className={cn("font-medium", t.skipped ? "text-s-ink-3" : t.passed ? "text-emerald-600 dark:text-emerald-400" : "text-s-danger")}>
                  {t.skipped ? "Not run" : t.passed ? "Passed" : `Failed (exit ${t.exitCode})`}
                </span>{" "}
                <code className="font-mono text-s-ink-2">{t.command}</code>{" "}
                <span className="text-s-ink-3">
                  · {t.round === 1 ? "first version" : `revision ${t.round - 1}`}, read in review {t.round}
                </span>
                {t.skipped && <span className="text-s-ink-3"> — {t.skipped}</span>}
              </summary>
              {t.outputTail && <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-s-hover/60 p-2 font-mono text-[11.5px] text-s-ink-2">{t.outputTail}</pre>}
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}

function FinalCard({
  run,
  s,
  onShowChanges,
  onOpenFile,
  onOpenPreview,
  onUndo,
}: {
  run: RunView;
  s: PairState;
  onShowChanges: () => void;
  onOpenFile: (p: string) => void;
  onOpenPreview?: () => void;
  onUndo: () => void;
}) {
  const f = s.final;
  const files = run.report?.files ?? [];
  return (
    <section aria-label="Result" className="mt-3 rounded-2xl border border-s-line-strong p-4 text-[13.5px]">
      <h3 className="flex items-center gap-2 text-[15px] font-medium text-s-ink">
        <Bot className="h-4 w-4" aria-hidden /> {run.status === "completed" ? "Result" : run.status === "failed" ? "The task stopped with an error" : "Stopped"}
      </h3>
      {run.error && <p className="mt-1 text-s-danger">{run.error}</p>}
      {f && (
        <>
          <p className="mt-1 text-s-ink-2">
            <span className="text-s-ink-3">Architect&apos;s summary: </span>
            {f.summary}
          </p>
          {f.howItWorks && <p className="mt-1 text-s-ink-2">{f.howItWorks}</p>}
          {f.setup.length > 0 && (
            <>
              <h4 className="mt-2 text-[12px] font-medium uppercase tracking-[0.06em] text-s-ink-3">Setup</h4>
              <ol className="mt-0.5 list-decimal pl-5 text-s-ink-2">
                {f.setup.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ol>
            </>
          )}
          <p className="mt-2 text-[12.5px] text-s-ink-3">
            {f.runCommand && (
              <>
                Run: <code className="font-mono text-s-ink-2">{f.runCommand}</code>{" "}
              </>
            )}
            {f.testCommand && (
              <>
                Test: <code className="font-mono text-s-ink-2">{f.testCommand}</code>
              </>
            )}
          </p>
          {f.knownIssues.length > 0 && (
            <>
              <h4 className="mt-2 text-[12px] font-medium uppercase tracking-[0.06em] text-s-ink-3">Known issues</h4>
              <ul className="mt-0.5 list-disc pl-5 text-s-ink-2">
                {f.knownIssues.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
      {run.report && run.report.unresolved.length > 0 && (
        <p className="mt-2 text-[12.5px] text-amber-700 dark:text-amber-300">
          Accepted with {run.report.unresolved.length} finding(s) still open: {run.report.unresolved.join("; ")}
        </p>
      )}
      {files.length > 0 && (
        <ul className="mt-2 space-y-0.5 font-mono text-[12.5px]">
          {files.map((x) => (
            <li key={x.path}>
              <button type="button" onClick={() => onOpenFile(x.path)} className="text-s-ink-2 underline-offset-2 hover:text-s-ink hover:underline">
                {x.path}
              </button>{" "}
              <span className="text-emerald-600 dark:text-emerald-400">+{x.added}</span> <span className="text-s-danger">−{x.removed}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={onShowChanges} className="inline-flex h-8 items-center gap-1.5 rounded-full bg-s-accent px-3.5 text-[12.5px] font-medium text-s-accent-ink">
          <Check className="h-3.5 w-3.5" aria-hidden /> Review changes
        </button>
        {onOpenPreview && (
          <button type="button" onClick={onOpenPreview} className="inline-flex h-8 items-center gap-1.5 rounded-full border border-s-line px-3 text-[12.5px] text-s-ink-2 hover:text-s-ink">
            <Play className="h-3.5 w-3.5" aria-hidden /> Preview
          </button>
        )}
        {files.length > 0 && (
          <button type="button" onClick={onUndo} className="inline-flex h-8 items-center gap-1.5 rounded-full border border-s-line px-3 text-[12.5px] text-s-ink-2 hover:text-s-ink">
            <Undo2 className="h-3.5 w-3.5" aria-hidden /> Undo all changes
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * How much a pair task can use, before it starts: the most calls each agent makes with these settings, and
 * what one costs in units with the chosen models. Agent steps carry the project's files: Orbis's measured
 * average step is about 1.5× a typical message (see the pricing page). Auto picks per request, so no number.
 */
function PairCostNote({ value, models }: { value: PairSettingsInput; models: { id: string; displayName: string; units?: number }[] | null }) {
  const r = value.maxRounds;
  const architectCalls = r + 2;
  const reviewerCalls = r;
  const unitsOf = (id: string) => models?.find((m) => m.id === id)?.units;
  const a = unitsOf(value.architect);
  const b = unitsOf(value.reviewer);
  const most = a !== undefined && b !== undefined ? Math.round((architectCalls * a + reviewerCalls * b) * 1.5) : null;
  return (
    <p className="sm:col-span-2 text-[12px] leading-relaxed text-s-ink-3">
      With up to {r} round{r === 1 ? "" : "s"}: at most {architectCalls} Architect calls and {reviewerCalls} Reviewer call{reviewerCalls === 1 ? "" : "s"}, each charged like a coding-agent step of its
      size.
      {most !== null
        ? ` With these models that's roughly up to ${most.toLocaleString("en-US")} units for an average-sized project; big projects use more, and it often finishes in fewer rounds.`
        : " With Auto, each call uses a coding model within your plan; the model menu shows each model's units for a typical message."}
    </p>
  );
}
