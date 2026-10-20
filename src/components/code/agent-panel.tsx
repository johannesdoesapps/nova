"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Eye,
  FileCode2,
  FlaskConical,
  ListChecks,
  Loader2,
  MessageSquare,
  Plus,
  Power,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal as TerminalIcon,
  Undo2,
  X,
} from "lucide-react";
import { useCatalog } from "@/components/common/model-picker";
import { ModelSelector } from "@/components/studio/model-selector";
import { VERIFICATION_LABEL } from "@/lib/code/agent/report";
import { ENDED_STATUSES, STATUS_LABEL, WORKING_STATUSES, type AgentEvent, type Decision, type LimitReason, type RunOptions, type RunReport, type RunView } from "@/lib/code/agent/types";
import { cn } from "@/lib/utils";
import { api, CodeApiError, post } from "./api";
import { FileDiff } from "./diff-view";

/**
 * The coding agent, the main view of a Code project: describe a task, follow
 * what the agent actually does (grouped into plain-English stages, with the
 * technical detail one click away), answer when it needs you, and review
 * the result. The page drives the run step by step (each request says which
 * step it expects, so a retry never repeats one), so the agent works while
 * this page is open; Stop ends it at once.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type RunDetail = { run: RunView; events: AgentEvent[] };
type RevertResult = { ok: boolean; reverted: string[]; conflicts: string[] };

// ---------------------------------------------------------------- permission modes

export type ModeId = "read" | "plan" | "review" | "auto";

/** What the agent may do, as presets of the run's real options; the server enforces every one. */
export const MODES: { id: ModeId; label: string; short: string; detail: string; options: Omit<RunOptions, "modelId"> }[] = [
  {
    id: "plan",
    label: "Ask first",
    short: "Recommended",
    detail: "Reads your project and shows a plan. Once you approve it, it edits files and runs tests, builds and installs. It asks before any other command.",
    options: { approvePlans: true, reviewEdits: false, commands: "safe", readOnly: false },
  },
  {
    id: "review",
    label: "Review every change",
    short: "Most control",
    detail: "Shows the plan, then each set of edits and every command for your approval before anything changes.",
    options: { approvePlans: true, reviewEdits: true, commands: "ask", readOnly: false },
  },
  {
    id: "auto",
    label: "Work on its own",
    short: "Fastest",
    detail:
      "Edits files and runs tests, builds and installs without stopping to ask. It still asks before other commands, never runs blocked ones (like deleting the project or pushing to GitHub), and every change can be undone.",
    options: { approvePlans: false, reviewEdits: false, commands: "safe", readOnly: false },
  },
  {
    id: "read",
    label: "Read-only",
    short: "Explain only",
    detail: "Reads your files and answers questions. It can't edit files or run commands — Orbis refuses them.",
    options: { approvePlans: false, reviewEdits: false, commands: "off", readOnly: true },
  },
];

export function modeOf(o: Pick<RunOptions, "approvePlans" | "reviewEdits" | "commands" | "readOnly">): (typeof MODES)[number] | null {
  return MODES.find((m) => m.options.readOnly === !!o.readOnly && m.options.approvePlans === o.approvePlans && m.options.reviewEdits === o.reviewEdits && m.options.commands === o.commands) ?? null;
}

/** First-use examples: each starts a real task (or, when it needs your details, fills the box). */
export const EXAMPLES: { label: string; task: string; mode?: ModeId; start: boolean }[] = [
  { label: "Explain this project to me", task: "Explain this project to me: what it does, how it's organised, and how to run it.", mode: "read", start: true },
  { label: "Find and fix a bug", task: "Find the most likely bug in this project, fix it, and run the tests (or the app) to check the fix.", start: true },
  { label: "Run the tests and fix failures", task: "Run the tests. If any fail, find the cause, fix it, and run them again until they pass.", start: true },
  { label: "Improve this page's design", task: "Improve the design of the main page: clearer layout, spacing, typography and colours. Keep the content the same.", start: true },
  { label: "Build a new feature", task: "Build a new feature: ", start: false },
];

const MODE_KEY = "orbis.code.mode";
const readMode = (): ModeId => {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return MODES.some((m) => m.id === v) ? (v as ModeId) : "plan";
  } catch {
    return "plan";
  }
};

// ---------------------------------------------------------------- stages

export type StageId = "understand" | "explore" | "plan" | "edit" | "check" | "review";

export const STAGE_LABEL: Record<StageId, string> = {
  understand: "Understanding your request",
  explore: "Exploring the project",
  plan: "Planning the changes",
  edit: "Editing files",
  check: "Running checks",
  review: "Reviewing the results",
};

const STAGE_ICON: Record<StageId, ReactNode> = {
  understand: <Bot className="h-4 w-4" />,
  explore: <Search className="h-4 w-4" />,
  plan: <ListChecks className="h-4 w-4" />,
  edit: <FileCode2 className="h-4 w-4" />,
  check: <TerminalIcon className="h-4 w-4" />,
  review: <Check className="h-4 w-4" />,
};

export interface StageBlock {
  stage: StageId;
  /** The agent's own words (what it learned, what it will do next). */
  notes: AgentEvent[];
  events: AgentEvent[];
}

/** Which stage an event belongs to; null for events that join the current stage (notes, answers, errors). */
function stageOfEvent(e: AgentEvent): StageId | null {
  if (e.kind === "status" && e.title.startsWith("Started with")) return "understand";
  // Looking at its own diff or status is the agent reviewing its work, not exploring the project.
  if (e.kind === "inspect") return /^(Checked the run's changes|Looked at the diff)/.test(e.title) ? "review" : "explore";
  if (e.kind === "plan") return "plan";
  if (e.kind === "edit" || e.kind === "revert" || e.kind === "git") return "edit";
  if (e.kind === "command") return "check";
  if (e.kind === "summary") return "review";
  return null;
}

/**
 * Group the activity log into stages, in the order they happened. A stage
 * appears only when an event of that kind exists; the agent's notes go with
 * the stage that follows them.
 */
export function groupStages(events: AgentEvent[]): StageBlock[] {
  const blocks: StageBlock[] = [];
  let notes: AgentEvent[] = [];
  for (const e of events) {
    if (e.kind === "note") {
      notes.push(e);
      continue;
    }
    const stage = stageOfEvent(e);
    const last = blocks[blocks.length - 1];
    if (stage && (!last || last.stage !== stage)) {
      blocks.push({ stage, notes, events: [e] });
      notes = [];
    } else if (last) {
      last.notes.push(...notes);
      last.events.push(e);
      notes = [];
    } else {
      blocks.push({ stage: "understand", notes, events: [e] });
      notes = [];
    }
  }
  if (notes.length) {
    const last = blocks[blocks.length - 1];
    if (last) last.notes.push(...notes);
    else blocks.push({ stage: "understand", notes, events: [] });
  }
  return blocks;
}

/** One line on what a stage did, from its events. */
export function stageSummary(b: StageBlock): string {
  const n = (k: AgentEvent["kind"]) => b.events.filter((e) => e.kind === k).length;
  const plural = (c: number, w: string) => `${c} ${w}${c === 1 ? "" : "s"}`;
  switch (b.stage) {
    case "understand":
      return b.events.find((e) => e.title.startsWith("Started with"))?.title ?? "";
    case "explore": {
      const reads = b.events.filter((e) => e.title.startsWith("Read "));
      const files = new Set(reads.flatMap((e) => e.title.slice(5).split(", ")));
      const searches = b.events.filter((e) => e.title.startsWith("Searched")).length;
      return [files.size && `read ${plural(files.size, "file")}`, searches && plural(searches, "search")].filter(Boolean).join(", ") || (b.events[0]?.title ?? "");
    }
    case "plan":
      return b.events.find((e) => e.kind === "plan")?.title ?? "";
    case "edit": {
      const edits = b.events.filter((e) => e.kind === "edit");
      return edits.length ? `${plural(new Set(edits.map((e) => (e.detail?.path as string) ?? e.title)).size, "file")} changed` : (b.events[0]?.title ?? "");
    }
    case "check": {
      const ran = b.events.filter((e) => e.kind === "command");
      const tests = ran.filter((e) => e.detail?.tests);
      if (tests.length) return tests[tests.length - 1]!.title;
      const blocked = ran.filter((e) => e.detail?.blocked).length;
      return [ran.length - blocked && `ran ${plural(ran.length - blocked, "command")}`, blocked && `${blocked} blocked`].filter(Boolean).join(", ");
    }
    case "review":
      return n("summary") ? "Finished" : "Checked its changes";
  }
}

// ---------------------------------------------------------------- the panel

export interface AgentPanelProps {
  projectId: string;
  computerOn: boolean;
  /** Start the project's computer; true when it's running. */
  startComputer: () => Promise<boolean>;
  /** The agent saved, changed or reverted files: reload them. */
  onFilesChanged: () => void;
  onShowChanges: (runId: string) => void;
  /** The session to show: a run id, null for a new one, or undefined for the project's open session (if any). The workspace remounts the panel to switch. */
  initialRunId?: string | null;
  /** The session shown changed (or its status did). */
  onRunChange: (run: RunView | null) => void;
  /** Text to start the box with (for example from "Try an example"). */
  initialRequest?: string;
  onOpenFile: (path: string) => void;
  /** The project's test command, when it has one. */
  testCommand: string | null;
  onRunTests: () => void;
}

export function AgentPanel({ projectId, computerOn, startComputer, onFilesChanged, onShowChanges, initialRunId, onRunChange, initialRequest, onOpenFile, testCommand, onRunTests }: AgentPanelProps) {
  const [run, setRun] = useState<RunView | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [driving, setDriving] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [error, setError] = useState<CodeApiError | null>(null);
  const [starting, setStarting] = useState(false);

  const alive = useRef(true);
  const lastSeq = useRef(0);
  const driveId = useRef(0);
  const feedEnd = useRef<HTMLDivElement>(null);
  const filesChanged = useRef(onFilesChanged);
  const runChanged = useRef(onRunChange);
  useEffect(() => {
    filesChanged.current = onFilesChanged;
    runChanged.current = onRunChange;
  }, [onFilesChanged, onRunChange]);

  /** Fetch the run and its new activity; reload files when the agent touched them. */
  const refresh = useCallback(async (runId: string): Promise<RunView> => {
    const r = await api<RunDetail>(`/api/code/agent/${runId}?after=${lastSeq.current}`);
    if (!alive.current) return r.run;
    setRun(r.run);
    runChanged.current(r.run);
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

  // First load: the session asked for, a new one, or the project's open session (if any).
  useEffect(() => {
    alive.current = true;
    const load =
      initialRunId === undefined
        ? api<{ runs: RunView[] }>(`/api/code/projects/${projectId}/agent`).then(async ({ runs }) => {
            const latest = runs[0];
            if (latest && !ENDED_STATUSES.includes(latest.status)) await open(latest.id);
          })
        : initialRunId === null
          ? Promise.resolve().then(() => runChanged.current(null))
          : refresh(initialRunId).then(() => undefined);
    load.catch((e: CodeApiError) => alive.current && e.status !== 401 && setError(e)).finally(() => alive.current && setLoaded(true));
    // Unmounting (another session was opened) ends this view's stepping loop; the run carries on when reopened.
    return () => {
      alive.current = false;
    };
  }, [projectId, initialRunId, open, refresh]);

  // A step running from before this page loaded (or in another tab): watch it until it ends.
  useEffect(() => {
    if (!run?.busy || driving) return;
    const t = setInterval(() => void refresh(run.id).catch(() => {}), 3000);
    return () => clearInterval(t);
  }, [run?.busy, run?.id, driving, refresh]);

  useEffect(() => {
    feedEnd.current?.scrollIntoView({ block: "end" });
  }, [events.length, run?.status]);

  const start = async (request: string, mode: ModeId, modelId: string) => {
    if (!request.trim() || starting) return;
    setStarting(true);
    setError(null);
    try {
      const preset = MODES.find((m) => m.id === mode)!;
      const r = await post<{ run: RunView }>(`/api/code/projects/${projectId}/agent`, { request, options: { modelId, ...preset.options } });
      lastSeq.current = 0;
      setEvents([]);
      setRun(r.run);
      runChanged.current(r.run);
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

  const undoAll = async () => {
    if (!run) return;
    setError(null);
    try {
      let r = await post<RevertResult>(`/api/code/agent/${run.id}/revert`, {});
      if (!r.ok && r.conflicts.length) {
        if (!confirm(`These files changed after the agent finished:\n\n${r.conflicts.join("\n")}\n\nUndo anyway? Those later changes will be lost.`)) return;
        r = await post<RevertResult>(`/api/code/agent/${run.id}/revert`, { force: true });
      }
      onFilesChanged();
      await refresh(run.id);
    } catch (e) {
      setError(e as CodeApiError);
    }
  };

  const ended = !!run && ENDED_STATUSES.includes(run.status);
  const working = !!run && WORKING_STATUSES.includes(run.status);
  const busy = driving || answering || !!run?.busy;
  const blocks = useMemo(() => groupStages(events), [events]);
  const readOnly = !!run && (!!run.options.readOnly || (run.options.approvePlans && !run.plan?.approved && !ended));
  const mode = run ? modeOf(run.options) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto" aria-live="polite">
        <div className="mx-auto w-full max-w-[780px] px-4 pb-6 pt-4 sm:px-6">
          {!loaded && <div className="s-skeleton h-24 w-full rounded-2xl" />}

          {loaded && !run && <Composer initialRequest={initialRequest} starting={starting} onStart={start} />}

          {run && (
            <div className="space-y-3">
              <header className="rounded-2xl border border-s-line bg-s-hover/40 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full border px-2 py-px text-[11.5px]",
                      working || busy ? "border-s-accent/50 text-s-ink" : run.status === "failed" ? "border-s-danger/50 text-s-danger" : "border-s-line text-s-ink-3",
                    )}
                  >
                    {(busy || working) && !ended && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
                    {STATUS_LABEL[run.status]}
                  </span>
                  {readOnly && (
                    <span
                      className="inline-flex items-center gap-1 rounded-full border border-s-line px-2 py-px text-[11.5px] text-s-ink-3"
                      title={
                        run.options.readOnly ? "This session can't change files or run commands." : "The agent can read your files but can't change them or run commands until you approve its plan."
                      }
                    >
                      <ShieldCheck className="h-3 w-3" aria-hidden /> Read-only
                    </span>
                  )}
                  {mode && <span className="text-[11.5px] text-s-ink-3">{mode.label}</span>}
                  {!ended && (
                    <button
                      type="button"
                      onClick={() => void stop()}
                      className="ml-auto inline-flex h-7 items-center gap-1 rounded-full border border-s-line px-2.5 text-[12px] text-s-ink-2 hover:border-s-danger hover:text-s-danger"
                    >
                      <Square className="h-3 w-3" aria-hidden /> Stop agent
                    </button>
                  )}
                </div>
                <p className="mt-2 whitespace-pre-wrap text-[14.5px] leading-relaxed text-s-ink">{run.request}</p>
                {run.usage.modelCalls > 0 && <UsageLine run={run} />}
              </header>

              <ol className="space-y-2" aria-label="Progress">
                {blocks.map((b, i) => (
                  <StageRow key={`${b.stage}-${b.events[0]?.seq ?? i}`} block={b} current={i === blocks.length - 1 && !ended && !run.pending} />
                ))}
              </ol>

              {(driving || run.busy) && !ended && (
                <p className="flex items-center gap-2 px-1 text-[13px] text-s-ink-3">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> {run.pending?.kind === "job" ? `Running ${run.pending.command}…` : "Working…"}
                </p>
              )}

              {run.pending && !busy && <PendingCard run={run} computerOn={computerOn} onRespond={respond} onStartComputer={startAndContinue} />}

              {working && !busy && !error && (
                <div className="rounded-2xl border border-s-line p-3 text-[13px]">
                  <p className="text-s-ink-2">The agent is paused (the page was reloaded or a step didn&apos;t finish). Nothing is lost.</p>
                  <button
                    type="button"
                    onClick={() => void drive(run.id)}
                    className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-full bg-s-accent px-3.5 text-[12.5px] font-medium text-s-accent-ink"
                  >
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Continue
                  </button>
                </div>
              )}

              {ended && <ReportCard run={run} onShowChanges={() => onShowChanges(run.id)} onOpenFile={onOpenFile} testCommand={testCommand} onRunTests={onRunTests} onUndo={undoAll} />}
              {ended && (
                <button
                  type="button"
                  onClick={() => {
                    setRun(null);
                    setEvents([]);
                    lastSeq.current = 0;
                    onRunChange(null);
                  }}
                  className="inline-flex h-9 items-center gap-1.5 rounded-full border border-s-line px-4 text-[13px] text-s-ink-2 hover:border-s-line-strong hover:text-s-ink"
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden /> Start a new task
                </button>
              )}
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
    </div>
  );
}

// ---------------------------------------------------------------- the task box

function Composer({ initialRequest, starting, onStart }: { initialRequest?: string; starting: boolean; onStart: (request: string, mode: ModeId, modelId: string) => Promise<void> }) {
  const catalog = useCatalog();
  const [request, setRequest] = useState(initialRequest ?? "");
  const [mode, setModeState] = useState<ModeId>(readMode);
  const [modelId, setModelId] = useState("auto:coding");
  const [choosing, setChoosing] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const setMode = (m: ModeId) => {
    setModeState(m);
    setChoosing(false);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* the choice just isn't remembered */
    }
  };
  const current = MODES.find((m) => m.id === mode)!;

  const example = (e: (typeof EXAMPLES)[number]) => {
    if (e.start) return void onStart(e.task, e.mode ?? mode, modelId);
    setRequest(e.task);
    requestAnimationFrame(() => {
      box.current?.focus();
      box.current?.setSelectionRange(e.task.length, e.task.length);
    });
  };

  return (
    <div className="s-in pt-[min(8vh,64px)]">
      <h2 className="text-center font-serif text-[clamp(28px,4vw,38px)] leading-[1.1]">What would you like to build or fix?</h2>
      <p className="mx-auto mt-2 max-w-[560px] text-center text-[14px] leading-relaxed text-s-ink-3">
        Describe it in plain English. The agent explores the project, makes the changes, runs the checks and shows you what changed.
      </p>
      <form
        className="glass-strong glass-edge mt-6 rounded-[24px] p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void onStart(request, mode, modelId);
        }}
      >
        <label htmlFor="agent-ask" className="sr-only">
          What would you like to build or fix?
        </label>
        <textarea
          id="agent-ask"
          ref={box}
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void onStart(request, mode, modelId);
            }
          }}
          rows={3}
          maxLength={8000}
          placeholder="What would you like to build or fix?"
          className="block w-full resize-none bg-transparent px-2 py-1.5 text-[15px] leading-relaxed outline-none placeholder:text-s-ink-3"
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setChoosing(!choosing)}
            aria-expanded={choosing}
            aria-controls="agent-modes"
            title="What the agent may do"
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-s-line px-3 text-[12.5px] text-s-ink-2 hover:border-s-line-strong hover:text-s-ink"
          >
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> {current.label} <ChevronDown className={cn("h-3.5 w-3.5 transition", choosing && "rotate-180")} aria-hidden />
          </button>
          <ModelSelector models={catalog?.models ?? null} value={modelId} onChange={setModelId} auto={catalog?.auto ?? null} />
          <button
            type="submit"
            disabled={!request.trim() || starting}
            className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-full bg-s-accent px-4 text-[13px] font-medium text-s-accent-ink transition hover:brightness-110 disabled:opacity-40"
          >
            {starting ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <ArrowUp className="h-3.5 w-3.5" aria-hidden />} {starting ? "Starting…" : "Start"}
          </button>
        </div>
        {choosing && (
          <fieldset id="agent-modes" className="mt-3 space-y-1.5 border-t border-s-line pt-3">
            <legend className="sr-only">What the agent may do</legend>
            {MODES.map((m) => (
              <label key={m.id} className={cn("flex cursor-pointer gap-3 rounded-xl border p-2.5", mode === m.id ? "border-s-line-strong bg-s-hover" : "border-transparent hover:bg-s-hover/60")}>
                <input type="radio" name="agent-mode" value={m.id} checked={mode === m.id} onChange={() => setMode(m.id)} className="mt-1 accent-[var(--s-accent)]" />
                <span>
                  <span className="text-[13.5px] font-medium text-s-ink">{m.label}</span> <span className="text-[12px] text-s-ink-3">· {m.short}</span>
                  <span className="mt-0.5 block text-[12.5px] leading-snug text-s-ink-2">{m.detail}</span>
                </span>
              </label>
            ))}
          </fieldset>
        )}
      </form>

      <div className="mt-4">
        <p className="text-[12px] font-medium uppercase tracking-[0.08em] text-s-ink-3">Try</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {EXAMPLES.map((e) => (
            <button
              key={e.label}
              type="button"
              disabled={starting}
              onClick={() => example(e)}
              title={e.start ? `Starts: “${e.task}”${e.mode === "read" ? " (read-only)" : ""}` : "Fills in the box; add the details"}
              className="inline-flex items-center gap-1.5 rounded-full border border-s-line px-3 py-1.5 text-[13px] text-s-ink-2 transition hover:border-s-line-strong hover:text-s-ink disabled:opacity-40"
            >
              {e.mode === "read" ? <Eye className="h-3.5 w-3.5" aria-hidden /> : e.start ? <Sparkles className="h-3.5 w-3.5" aria-hidden /> : <Plus className="h-3.5 w-3.5" aria-hidden />}
              {e.label}
            </button>
          ))}
        </div>
      </div>

      <p className="mt-6 flex items-start gap-2 text-[12px] leading-relaxed text-s-ink-3">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>
          The agent works only on this project&apos;s files and its private computer — never your device or your other projects. Files like <code className="font-mono">.env</code> are never shown to
          the AI. It never deploys, publishes or pushes on its own, and every change can be undone. Each step counts like one chat message on your plan.
        </span>
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- progress

function StageRow({ block, current }: { block: StageBlock; current: boolean }) {
  const [open, setOpen] = useState(false);
  const failed = block.events.some((e) => e.kind === "error");
  const summary = stageSummary(block);
  const id = `stage-${block.stage}-${block.events[0]?.seq ?? 0}`;
  return (
    <li className="rounded-2xl border border-s-line px-3.5 py-2.5">
      <div className="flex items-center gap-2.5">
        <span
          className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-full", failed ? "bg-s-danger/10 text-s-danger" : current ? "bg-s-hover text-s-ink" : "bg-s-hover text-s-ink-3")}
          aria-hidden
        >
          {current ? <Loader2 className="h-4 w-4 animate-spin" /> : STAGE_ICON[block.stage]}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium text-s-ink">{STAGE_LABEL[block.stage]}</div>
          {summary && <div className={cn("truncate text-[12.5px]", failed ? "text-s-danger" : "text-s-ink-3")}>{summary}</div>}
        </div>
        {block.events.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            aria-controls={id}
            className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[12px] text-s-ink-3 hover:bg-s-hover hover:text-s-ink"
          >
            Details {open ? <ChevronDown className="h-3.5 w-3.5" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden />}
          </button>
        )}
      </div>
      {block.notes.length > 0 && (
        <div className="mt-2 space-y-1 pl-[38px]">
          {block.notes.map((n) => (
            <p key={n.id} className="text-[13.5px] leading-relaxed text-s-ink-2">
              {n.title}
            </p>
          ))}
        </div>
      )}
      {block.events
        .filter((e) => e.kind === "error" || (e.kind === "command" && e.detail?.blocked))
        .map((e) => (
          <p key={e.id} className="mt-1.5 flex items-start gap-1.5 pl-[38px] text-[13px] text-s-danger">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            {e.kind === "command" ? `Orbis blocked a command: ${(e.detail?.command as string) ?? ""} — ${e.detail?.blocked as string}` : e.title}
          </p>
        ))}
      {open && (
        <ol id={id} className="mt-2 space-y-1 border-t border-s-line pt-2" aria-label={`${STAGE_LABEL[block.stage]} details`}>
          {block.events.map((e) => (
            <EventRow key={e.id} event={e} />
          ))}
        </ol>
      )}
    </li>
  );
}

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
    <li className={cn("rounded-lg px-2 py-1 text-[12.5px] leading-snug", e.kind === "note" ? "text-s-ink-3" : "text-s-ink-2")}>
      <div className="flex items-start gap-2">
        <span className={cn("mt-0.5 shrink-0", failed ? "text-s-danger" : passed ? "text-emerald-500" : "text-s-ink-3")} aria-hidden>
          {ICONS[e.kind]}
        </span>
        {expandable ? (
          <button type="button" onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-start gap-1 text-left" aria-expanded={open}>
            <span className={cn("min-w-0 flex-1 break-words", e.kind === "command" && "font-mono text-[12px]")}>{e.title}</span>
            {open ? <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> : <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />}
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

// ---------------------------------------------------------------- usage and report

const minutes = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`);
const usd = (n: number) => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

/** Tokens used against the run's budget, estimated cost and working time. */
function UsageLine({ run }: { run: RunView }) {
  const used = run.usage.inputTokens + run.usage.outputTokens;
  return (
    <p className="mt-1.5 text-[11.5px] text-s-ink-3">
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

/** The end of a session: built by the server from what actually ran and changed; the agent's own words are labelled as such. */
function ReportCard({
  run,
  onShowChanges,
  onOpenFile,
  testCommand,
  onRunTests,
  onUndo,
}: {
  run: RunView;
  onShowChanges: () => void;
  onOpenFile: (path: string) => void;
  testCommand: string | null;
  onRunTests: () => void;
  onUndo: () => Promise<void>;
}) {
  const r = run.report;
  const title = run.status === "completed" ? "Done" : run.status === "failed" ? "Stopped with an error" : "Stopped";
  const changed = r ? r.files.filter((f) => f.change !== "deleted") : [];
  const secondary = "inline-flex h-8 items-center gap-1.5 rounded-full border border-s-line px-3 text-[12.5px] text-s-ink-2 hover:border-s-line-strong hover:text-s-ink";
  return (
    <section aria-label="Run report" className={cn("rounded-2xl border p-4 text-[13.5px] leading-relaxed", run.status === "failed" ? "border-s-danger/40" : "border-s-line-strong")}>
      <div className="flex flex-wrap items-center gap-2 text-[15px] font-medium text-s-ink">
        {run.status === "completed" ? (
          <Check className="h-4 w-4 text-emerald-500" aria-hidden />
        ) : run.status === "failed" ? (
          <AlertTriangle className="h-4 w-4 text-s-danger" aria-hidden />
        ) : (
          <Square className="h-3.5 w-3.5" aria-hidden />
        )}
        {title}
        {r && <span className={cn("rounded-full border px-2 py-px text-[12px] font-normal", VERIFY_STYLE[r.verification])}>{VERIFICATION_LABEL[r.verification]}</span>}
      </div>
      {run.error && <p className="mt-1 text-s-danger">{run.error}</p>}

      {run.summary && (
        <div className="mt-3">
          <h3 className="text-[11px] font-medium uppercase tracking-[0.08em] text-s-ink-3">What the agent says it did</h3>
          <p className="mt-1 whitespace-pre-wrap text-s-ink-2">{run.summary}</p>
        </div>
      )}

      {r?.tests && (
        <div className="mt-3">
          <h3 className="text-[11px] font-medium uppercase tracking-[0.08em] text-s-ink-3">Checks that ran</h3>
          <p className="mt-1 text-s-ink-2">
            <code className="font-mono text-[12.5px]">{r.tests.command}</code> —{" "}
            {r.tests.passed !== null || r.tests.failed !== null ? `${r.tests.passed ?? 0} passed, ${r.tests.failed ?? 0} failed` : `exit code ${r.tests.exitCode ?? "none"}`}
            {!r.tests.afterLastEdit && <span className="text-amber-600 dark:text-amber-400"> (before the last change)</span>}
          </p>
          {r.tests.failures.length > 0 && <p className="text-s-danger">Failing: {r.tests.failures.join("; ")}</p>}
        </div>
      )}
      {r && !r.tests && r.files.length > 0 && <p className="mt-3 text-[13px] text-s-ink-3">No tests ran in this session, so the changes aren&apos;t verified.</p>}

      {r && (
        <div className="mt-3">
          <h3 className="text-[11px] font-medium uppercase tracking-[0.08em] text-s-ink-3">Files changed</h3>
          {r.files.length === 0 ? (
            <p className="mt-1 text-[13px] text-s-ink-3">No files were changed.</p>
          ) : (
            <ul className="mt-1 space-y-0.5 font-mono text-[12.5px]">
              {r.files.map((f) => (
                <li key={f.path} className="flex items-center gap-2">
                  {f.change === "deleted" ? (
                    <span className="min-w-0 flex-1 truncate text-s-ink-3 line-through">{f.path}</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onOpenFile(f.path)}
                      title={`Open ${f.path}`}
                      className="min-w-0 flex-1 truncate text-left text-s-ink-2 underline-offset-2 hover:text-s-ink hover:underline"
                    >
                      {f.path}
                    </button>
                  )}
                  <span className="shrink-0 text-[11.5px] text-s-ink-3">{f.change === "created" ? "new" : f.change === "deleted" ? "deleted" : ""}</span>
                  <span className="shrink-0 text-emerald-600 dark:text-emerald-400">+{f.added}</span>
                  <span className="shrink-0 text-s-danger">−{f.removed}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {r && r.unresolved.length > 0 && (
        <div className="mt-3">
          <h3 className="text-[11px] font-medium uppercase tracking-[0.08em] text-s-ink-3">Still open</h3>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-s-ink-2">
            {r.unresolved.map((u, i) => (
              <li key={i}>{u}</li>
            ))}
          </ul>
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

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onShowChanges}
          className="inline-flex h-8 items-center gap-1.5 rounded-full bg-s-accent px-3.5 text-[12.5px] font-medium text-s-accent-ink transition hover:brightness-110"
        >
          <FileCode2 className="h-3.5 w-3.5" aria-hidden /> Review changes
        </button>
        {changed.length > 0 && (
          <button type="button" onClick={() => onOpenFile(changed[0]!.path)} className={secondary}>
            Open {changed.length === 1 ? changed[0]!.path.split("/").pop() : "changed files"}
          </button>
        )}
        {testCommand && (
          <button type="button" onClick={onRunTests} title={`Runs ${testCommand} in the terminal`} className={secondary}>
            <FlaskConical className="h-3.5 w-3.5" aria-hidden /> Run tests
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

// ---------------------------------------------------------------- waiting for you

const LIMIT_TEXT: Record<LimitReason, { title: (p: { steps: number }) => string; body: string; go: string }> = {
  steps: { title: (p) => `The agent has taken ${p.steps} steps`, body: "Let it keep going? Each step counts like a chat message.", go: "Allow 10 more steps" },
  tokens: { title: () => "The agent has used its token budget", body: "Let it use more? Tokens count toward your plan's usage.", go: "Allow 300,000 more tokens" },
  time: { title: () => "The agent has been working a long time", body: "Let it keep going?", go: "Allow 15 more minutes" },
  tests: { title: () => "The tests keep failing", body: "The agent has tried several times without making the tests pass. Let it try again, or stop and look yourself.", go: "Allow 2 more attempts" },
  repeat: { title: () => "The agent is repeating itself", body: "It asked for the same actions three times in a row. Let it carry on with a different approach, or stop.", go: "Let it carry on" },
};

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
  const card = "rounded-2xl border border-s-accent/50 bg-s-hover/30 p-4 text-[13.5px] leading-relaxed";
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
        <p className="mt-2 text-[12px] text-s-ink-3">Nothing has changed yet. Approving lets the agent edit files and run checks as planned.</p>
        {asking && feedback("What should change in the plan?", "Plan changes")}
        <div className="mt-2.5 flex flex-wrap gap-2">
          {!asking ? (
            <>
              <button type="button" className={primary} onClick={() => void onRespond("approve")}>
                <Check className="h-3.5 w-3.5" aria-hidden /> Approve and start
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
        <p className="mt-1.5 text-[12px] text-s-ink-3">{p.reason} It runs on the project&apos;s private computer, which can only reach npm and PyPI.</p>
        {feedback("Optional: why not, or what to do instead", "Feedback")}
        <div className="mt-2.5 flex flex-wrap gap-2">
          <button type="button" className={primary} onClick={() => void onRespond("approve")}>
            <Check className="h-3.5 w-3.5" aria-hidden /> Run it
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
          Review {p.changes.length} file change{p.changes.length === 1 ? "" : "s"}
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
            <Check className="h-3.5 w-3.5" aria-hidden /> Save these changes
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
          To run <code className="font-mono text-[12px]">{p.command}</code>, the project&apos;s private computer has to be on. Starting it uses workspace minutes from your plan.
        </p>
        <div className="mt-2.5 flex flex-wrap gap-2">
          {computerOn ? (
            <button type="button" className={primary} onClick={() => void onRespond("continue")}>
              Continue
            </button>
          ) : (
            <button type="button" className={primary} onClick={() => void onStartComputer()}>
              <Power className="h-3.5 w-3.5" aria-hidden /> Start the computer and continue
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

/** The project's coding sessions, newest first, to reopen one or start another. */
export function SessionsList({ projectId, activeId, version, onOpen, onNew }: { projectId: string; activeId: string | null; version: number; onOpen: (runId: string) => void; onNew: () => void }) {
  const [runs, setRuns] = useState<(RunView & { changedFiles: number })[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    api<{ runs: (RunView & { changedFiles: number })[] }>(`/api/code/projects/${projectId}/agent`)
      .then((r) => alive && setRuns(r.runs))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [projectId, version]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-2 pb-2">
        <button
          type="button"
          onClick={onNew}
          className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-s-line text-[12.5px] text-s-ink-2 hover:border-s-line-strong hover:text-s-ink"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden /> New session
        </button>
      </div>
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto px-1 pb-3">
        {failed && <p className="px-3 py-2 text-[12.5px] text-s-ink-3">Sessions couldn&apos;t load.</p>}
        {!runs && !failed && <div className="s-skeleton mx-2 h-10" />}
        {runs?.length === 0 && <p className="px-3 py-2 text-[12.5px] leading-relaxed text-s-ink-3">No sessions yet. Each task you give the agent becomes a session you can come back to.</p>}
        <ul className="space-y-0.5">
          {runs?.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => onOpen(r.id)}
                aria-current={r.id === activeId ? "true" : undefined}
                className={cn("w-full rounded-lg px-2.5 py-2 text-left transition", r.id === activeId ? "bg-s-hover" : "hover:bg-s-hover/60")}
              >
                <span className="line-clamp-2 text-[12.5px] text-s-ink">{r.request}</span>
                <span className="mt-0.5 block text-[11px] text-s-ink-3">
                  {STATUS_LABEL[r.status]} · {new Date(r.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                  {r.changedFiles > 0 && ` · ${r.changedFiles} file${r.changedFiles === 1 ? "" : "s"}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
