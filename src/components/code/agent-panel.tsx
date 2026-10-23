"use client";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  CircleHelp,
  Eye,
  FileCode2,
  FileText,
  ImageIcon,
  Lightbulb,
  FlaskConical,
  Globe,
  ListChecks,
  Loader2,
  MessageSquare,
  MonitorSmartphone,
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
import { Menu, MenuItem } from "@/components/studio/ui";
import { isOlderView, TASK_STATE_INFO, taskState } from "@/lib/code/agent/verdict";
import { VerificationPanel } from "./verification-panel";
import type { ModelWithStatus } from "@/lib/ai/types";
import { DEFAULT_STEP_LIMIT, ENDED_STATUSES, STEP_LIMIT_INCREMENT, WORKING_STATUSES, type AgentEvent, type Decision, type LimitReason, type RunOptions, type RunView } from "@/lib/code/agent/types";
import { formatBytes, type AttachmentMeta } from "@/lib/code/attachments";
import { cn } from "@/lib/utils";
import { useAttachments } from "./attachments";
import { PromptBar } from "./prompt-bar";
import { useCodeModel } from "./use-code-model";
import { api, CodeApiError, post } from "./api";
import { FileDiff } from "./diff-view";
import { InfinityMark } from "@/components/brand/infinity";
import { WorkingStatus } from "@/components/studio/generating";
import { useAnimatedLogo } from "@/components/studio/prefs";

/**
 * The coding agent, the main view of a Code project: describe a task, follow
 * what the agent actually does (grouped into plain-English stages, with the
 * technical detail one click away), answer when it needs you, and review
 * the result. The page drives the run step by step (each request says which
 * step it expects, so a retry never repeats one), so the agent works while
 * this page is open; Stop ends it at once.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type RunDetail = { run: RunView; events: AgentEvent[]; attachments?: AttachmentMeta[] };
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

/** Follow-ups for a website project: each starts a real change to the existing site. */
export const WEB_EXAMPLES: { label: string; task: string; start: boolean }[] = [
  { label: "Make the design more premium", task: "Make the design more premium: refine typography, spacing, colour and details. Keep the content and features.", start: true },
  { label: "Add a pricing section", task: "Add a pricing section with three plans (clearly marked as sample prices), linked from the navigation.", start: true },
  { label: "Make the navigation sticky", task: "Make the navigation bar stick to the top while scrolling, on desktop and phones.", start: true },
  { label: "Fix the mobile layout", task: "Check the site at phone sizes and fix anything that's cramped, overflowing or hard to tap.", start: true },
  { label: "Add dark mode", task: "Add a dark mode that follows the visitor's system setting, with a toggle to switch.", start: true },
  { label: "Change the colours…", task: "Change the colours to ", start: false },
];

const MODE_KEY = "orbis.code.mode";
const noSubscribe = () => () => {};
const readMode = (): ModeId => {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return MODES.some((m) => m.id === v) ? (v as ModeId) : "plan";
  } catch {
    return "plan";
  }
};

// ---------------------------------------------------------------- stages

export type StageId = "understand" | "explore" | "plan" | "edit" | "check" | "preview" | "review";

export const STAGE_LABEL: Record<StageId, string> = {
  understand: "Understanding your request",
  explore: "Exploring the project",
  plan: "Planning the changes",
  edit: "Editing files",
  check: "Running checks",
  preview: "Checking the site in a browser",
  review: "Reviewing the results",
};

const STAGE_ICON: Record<StageId, ReactNode> = {
  understand: <Bot className="h-4 w-4" />,
  explore: <Search className="h-4 w-4" />,
  plan: <ListChecks className="h-4 w-4" />,
  edit: <FileCode2 className="h-4 w-4" />,
  check: <TerminalIcon className="h-4 w-4" />,
  preview: <MonitorSmartphone className="h-4 w-4" />,
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
  // Starting and checking the live preview (and its screenshots).
  if (e.detail?.preview || typeof e.detail?.screenshot === "string" || (e.kind === "status" && /preview|Run command/.test(e.title))) return "preview";
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
    case "preview": {
      const checks = b.events.filter((e) => e.detail?.preview && e.kind === "inspect");
      if (checks.length) return checks[checks.length - 1]!.title;
      const started = b.events.filter((e) => e.detail?.preview && e.kind === "command");
      return started.length ? started[started.length - 1]!.title : (b.events[0]?.title ?? "");
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
  /** A website project: website examples and wording. */
  web?: boolean;
  /** The agent started the preview, checked it, or changed files the preview shows. */
  onPreview?: (what: "started" | "checked" | "changed") => void;
  onOpenPreview?: () => void;
  /** Start this request straight away ("Build website"), working on its own. */
  autoStart?: string;
  /** Attachments already uploaded for `autoStart`. */
  autoAttachments?: string[];
  /** The model picked on the start screen for `autoStart`. */
  autoModel?: string;
  /** Start the project's computer without asking when the run needs it (the user asked for a build). */
  autoComputer?: boolean;
}

export function AgentPanel({
  projectId,
  computerOn,
  startComputer,
  onFilesChanged,
  onShowChanges,
  initialRunId,
  onRunChange,
  initialRequest,
  onOpenFile,
  web,
  onPreview,
  onOpenPreview,
  autoStart,
  autoAttachments,
  autoModel,
  autoComputer,
}: AgentPanelProps) {
  const animated = useAnimatedLogo();
  const [run, setRun] = useState<RunView | null>(null);
  const [runAttachments, setRunAttachments] = useState<AttachmentMeta[]>([]);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [driving, setDriving] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [error, setError] = useState<CodeApiError | null>(null);
  const [starting, setStarting] = useState(false);
  // The prompt bar: what to ask, how the agent may work, which model, and attachments.
  const attachments = useAttachments(projectId);
  const catalog = useCatalog();
  const [text, setText] = useState(initialRequest ?? "");
  // The remembered mode is read after hydration (the server can't know it), so the first render matches.
  const savedMode = useSyncExternalStore(noSubscribe, readMode, () => "plan" as ModeId);
  const [chosenMode, setModeState] = useState<ModeId | null>(null);
  const mode = chosenMode ?? savedMode;
  const [modelId, setModelId] = useCodeModel(catalog);
  const box = useRef<HTMLTextAreaElement>(null);
  /** A message typed while the agent works, sent when it finishes (and the run it was typed for). */
  const [queued, setQueued] = useState<string | null>(null);
  const queuedFor = useRef<string | null>(null);

  const alive = useRef(true);
  const lastSeq = useRef(0);
  const latestView = useRef<RunView | null>(null);
  /** The run this page was stepping when the connection dropped (stepped again when it's back). */
  const interrupted = useRef<string | null>(null);
  const driveId = useRef(0);
  const feedEnd = useRef<HTMLDivElement>(null);
  const filesChanged = useRef(onFilesChanged);
  const runChanged = useRef(onRunChange);
  const previewChanged = useRef(onPreview);
  useEffect(() => {
    filesChanged.current = onFilesChanged;
    runChanged.current = onRunChange;
    previewChanged.current = onPreview;
  }, [onFilesChanged, onRunChange, onPreview]);

  /** Fetch the run and its new activity; reload files when the agent touched them. */
  const refresh = useCallback(async (runId: string): Promise<RunView> => {
    const r = await api<RunDetail>(`/api/code/agent/${runId}?after=${lastSeq.current}`);
    if (!alive.current) return r.run;
    if (r.attachments) setRunAttachments(r.attachments);
    // A slower, older response never replaces a newer state of the same run (the page shows what the server last said).
    if (!isOlderView(latestView.current, r.run)) {
      latestView.current = r.run;
      setRun(r.run);
      runChanged.current(r.run);
    }
    const fresh = r.events.filter((e) => e.seq > lastSeq.current);
    if (fresh.length) {
      lastSeq.current = Math.max(...fresh.map((e) => e.seq));
      setEvents((es) => [...es.filter((e) => !fresh.some((f) => f.seq === e.seq)), ...fresh].sort((a, b) => a.seq - b.seq));
      const touched = fresh.some((e) => e.kind === "edit" || e.kind === "revert" || (e.kind === "command" && Array.isArray(e.detail?.changed) && (e.detail.changed as unknown[]).length));
      if (touched) filesChanged.current();
      if (fresh.some((e) => e.kind === "command" && e.detail?.preview && e.detail.state === "running")) previewChanged.current?.("started");
      else if (fresh.some((e) => e.kind === "inspect" && e.detail?.preview)) previewChanged.current?.("checked");
      else if (touched) previewChanged.current?.("changed");
    }
    return r.run;
  }, []);

  const open = useCallback(
    async (runId: string) => {
      lastSeq.current = 0;
      latestView.current = null;
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
        if (driveId.current === me) {
          setError(e as CodeApiError);
          if (typeof navigator !== "undefined" && !navigator.onLine) interrupted.current = runId;
        }
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

  // While this page isn't stepping the run itself (a step from before it loaded, another tab, an answer given
  // elsewhere), keep its state fresh so it shows what the run is doing now — and Continue when it's ready to go on.
  const runEnded = !!run && ENDED_STATUSES.includes(run.status);
  useEffect(() => {
    if (!run || runEnded || driving || answering) return;
    const t = setInterval(() => void refresh(run.id).catch(() => {}), run.busy ? 3000 : 5000);
    return () => clearInterval(t);
  }, [run, runEnded, driving, answering, refresh]);

  useEffect(() => {
    feedEnd.current?.scrollIntoView({ block: "end" });
  }, [events.length, run?.status]);

  const start = async (request: string, mode: ModeId, modelId: string, attachments: string[] = []): Promise<boolean> => {
    if (!request.trim() || starting) return false;
    setStarting(true);
    setError(null);
    try {
      const preset = MODES.find((m) => m.id === mode)!;
      const r = await post<{ run: RunView; attachments?: AttachmentMeta[] }>(`/api/code/projects/${projectId}/agent`, { request, options: { modelId, ...preset.options }, ...(attachments.length ? { attachments } : {}) });
      lastSeq.current = 0;
      setEvents([]);
      setRunAttachments(r.attachments ?? []);
      latestView.current = r.run;
      setRun(r.run);
      runChanged.current(r.run);
      void drive(r.run.id);
      return true;
    } catch (e) {
      setError(e as CodeApiError);
      return false;
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

  // "Build website": the request starts as soon as the panel is ready, once.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!loaded || run || !autoStart || autoStarted.current) return;
    autoStarted.current = true;
    void start(autoStart, "auto", autoModel ?? "auto:coding", autoAttachments ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once when the panel is ready
  }, [loaded, run, autoStart]);

  // The user asked for a build, which needs the computer: start it rather than ask (once per run).
  const autoComputerFor = useRef<string | null>(null);
  const busyNow = driving || answering || !!run?.busy;
  useEffect(() => {
    if (!autoComputer || !run || run.pending?.kind !== "computer" || busyNow || autoComputerFor.current === run.id) return;
    autoComputerFor.current = run.id;
    void startAndContinue();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to the run waiting for the computer
  }, [autoComputer, run?.id, run?.pending?.kind, busyNow]);

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

  /** "Re-run checks": the server queues the checks, then this page steps the run through them like any other step. */
  const rerun = async () => {
    if (!run) return;
    setError(null);
    try {
      const r = await post<{ run: RunView }>(`/api/code/agent/${run.id}/verify`, {});
      await refresh(r.run.id);
      void drive(r.run.id);
    } catch (e) {
      setError(e as CodeApiError);
    }
  };

  // Verification needs no decisions and no AI, so a run left verifying (a reload, a dropped step) carries on by itself;
  // a run this page was stepping when the connection dropped carries on when it's back.
  const verifying = !!run && taskState(run) === "verifying";
  useEffect(() => {
    if (!run || driving || answering || run.busy || !WORKING_STATUSES.includes(run.status)) return;
    if (verifying) {
      const t = setTimeout(() => void drive(run.id), 0);
      return () => clearTimeout(t);
    }
    const resume = () => {
      if (interrupted.current === run.id && navigator.onLine && document.visibilityState === "visible") {
        interrupted.current = null;
        setError(null);
        void drive(run.id);
      }
    };
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [run, verifying, driving, answering, drive]);

  const ended = !!run && ENDED_STATUSES.includes(run.status);
  const working = !!run && WORKING_STATUSES.includes(run.status);
  const busy = driving || answering || !!run?.busy;
  const blocks = useMemo(() => groupStages(events), [events]);
  const readOnly = !!run && (!!run.options.readOnly || (run.options.approvePlans && !run.plan?.approved && !ended));
  const runMode = run ? modeOf(run.options) : null;
  const inProgress = !!run && !ended;

  const setMode = (m: ModeId) => {
    setModeState(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* the choice just isn't remembered */
    }
  };

  /** Start a task (a new one, or a follow-up: the agent already knows the project and what was just done). */
  const send = async (request: string, m: ModeId = mode): Promise<boolean> => {
    if (attachments.busy) return false;
    const ok = await start(request, m, modelId, attachments.ids);
    if (ok) attachments.reset();
    return ok;
  };

  const submit = (t: string) => {
    if (inProgress) {
      // While the agent works, Enter queues the message for when it finishes.
      queuedFor.current = run!.id;
      setQueued((q) => (q ? `${q}\n\n${t}` : t));
      setText("");
      return;
    }
    // The box clears at once; if the task doesn't start, the text comes back.
    setText("");
    void send(t).then((ok) => !ok && setText((cur) => (cur.trim() ? cur : t)));
  };

  const fill = (task: string) => {
    setText(task);
    requestAnimationFrame(() => {
      box.current?.focus();
      box.current?.setSelectionRange(task.length, task.length);
    });
  };

  // Send the queued message once the run it was typed for finishes; if it stopped or failed, or another
  // session was opened, put it back in the box instead. (Deferred a tick: state changes after this render.)
  useEffect(() => {
    if (!queued) return;
    const other = !run || run.id !== queuedFor.current;
    if (!other && (!ended || busy || starting)) return;
    const restore = () => setText((t) => (t.trim() ? t : queued));
    const timer = setTimeout(() => {
      setQueued(null);
      if (other || run.status !== "completed") return restore();
      void send(queued).then((ok) => !ok && restore());
    }, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to the run finishing
  }, [queued, run?.id, run?.status, ended, busy, starting]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto" aria-live="polite">
        <div className="mx-auto flex min-h-full w-full max-w-[780px] flex-col px-4 pb-6 pt-4 sm:px-6">
          {!loaded && <div className="s-skeleton h-24 w-full rounded-2xl" />}

          {loaded && !run && !(autoStart && !error) && <StartScreen web={web} />}
          {loaded && !run && autoStart && !error && (
            <WorkingStatus kind="build" fallback={<Loader2 className="h-4 w-4 animate-spin" aria-hidden />} className="flex items-center gap-3 px-1 pt-10 text-[14px] text-s-ink-2" />
          )}

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
                    {TASK_STATE_INFO[taskState(run)].label}
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
                  {runMode && <span className="text-[11.5px] text-s-ink-3">{runMode.label}</span>}
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
                {runAttachments.length > 0 && (
                  <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Attached to this task">
                    {runAttachments.map((a) => (
                      <li key={a.id} className="inline-flex max-w-[220px] items-center gap-1.5 rounded-full border border-s-line px-2.5 py-1 text-[12px] text-s-ink-2" title={`${a.name} · ${formatBytes(a.size)}`}>
                        {a.kind === "image" ? <ImageIcon className="h-3.5 w-3.5 shrink-0" aria-hidden /> : <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden />}
                        <span className="truncate">{a.name.split("/").pop()}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {run.usage.modelCalls > 0 && <UsageLine run={run} />}
              </header>

              <ol className="space-y-2" aria-label="Progress">
                {blocks.map((b, i) => (
                  <StageRow key={`${b.stage}-${b.events[0]?.seq ?? i}`} block={b} current={i === blocks.length - 1 && !ended && !run.pending} />
                ))}
              </ol>

              {(driving || run.busy) && !ended && (
                run.pending?.kind === "job" ? (
                  <p role="status" className="flex items-center gap-2.5 px-1 text-[13px] text-s-ink-3">
                    {animated ? <InfinityMark wide animate weight={7} className="h-3 w-5 shrink-0" /> : <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />} Running {run.pending.command}…
                  </p>
                ) : (
                  <WorkingStatus kind="agent" fallback={<Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />} className="flex items-center gap-2.5 px-1 text-[13px] text-s-ink-3" />
                )
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

              {ended && <VerificationPanel run={run} onShowChanges={() => onShowChanges(run.id)} onOpenFile={onOpenFile} onRerun={rerun} onUndo={undoAll} onOpenPreview={onOpenPreview} />}
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

      <div className="shrink-0 px-3 pb-2 pt-1 sm:px-6">
        <div className="mx-auto w-full max-w-[780px]">
          {!inProgress && <FirstTip />}
          {queued && (
            <div className="mb-2 flex items-start gap-2 rounded-xl border border-dashed border-s-line px-3 py-2 text-[12.5px] text-s-ink-2" role="status">
              <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-s-ink-3" aria-hidden />
              <p className="min-w-0 flex-1">
                <span className="text-s-ink-3">Queued — sends when the agent finishes:</span> <span className="line-clamp-2 whitespace-pre-wrap text-s-ink">{queued}</span>
              </p>
              <button
                type="button"
                onClick={() => {
                  setText((t) => (t.trim() ? `${t}\n\n${queued}` : queued));
                  setQueued(null);
                }}
                className="shrink-0 rounded-full px-2 py-0.5 text-s-ink-3 hover:bg-s-hover hover:text-s-ink"
              >
                Edit
              </button>
              <button type="button" onClick={() => setQueued(null)} aria-label="Remove the queued message" className="shrink-0 text-s-ink-3 hover:text-s-ink">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          <PromptBar
            id="agent-ask"
            label={run ? "Ask for a follow-up change" : "What would you like to build or fix?"}
            inputRef={box}
            value={text}
            onChange={setText}
            onSubmit={submit}
            sending={starting}
            disabled={!loaded}
            attachments={attachments}
            placeholder={inProgress ? "Enter to queue a message for when the agent finishes" : run ? "Ask for a follow-up change — Enter to send" : "Enter to send, Shift+Enter for a new line"}
            onStop={working ? () => void stop() : undefined}
            working={busy || starting || working}
            footerLeft={
              <>
                <ModeMenu mode={mode} onChange={setMode} disabled={starting} />
                {!inProgress && <IdeasMenu web={web} disabled={starting || !loaded} onPick={(e) => (e.start ? void send(e.task, e.mode ?? mode) : fill(e.task))} />}
              </>
            }
            footerRight={<ModelSelector models={catalog?.models ?? null} value={modelId} onChange={setModelId} auto={catalog?.auto ?? null} className="min-w-0 !shrink" />}
          />
          {!inProgress && <StepEstimate models={catalog?.models ?? null} modelId={modelId} readOnly={mode === "read"} />}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the task box

function StartScreen({ web }: { web?: boolean }) {
  return (
    <div className="s-in grid flex-1 place-items-center py-10">
      <h2 className="text-center font-serif text-[clamp(28px,4vw,38px)] leading-[1.1]">{web ? "What should change on your site?" : "What would you like to build or fix?"}</h2>
    </div>
  );
}

/** Example tasks, behind a bulb under the prompt bar: each starts a real task, or fills in the box when it needs your details. */
function IdeasMenu({ web, disabled, onPick }: { web?: boolean; disabled?: boolean; onPick: (e: (typeof EXAMPLES)[number]) => void }) {
  const examples: (typeof EXAMPLES)[number][] = web ? WEB_EXAMPLES : EXAMPLES;
  return (
    <Menu
      label="Ideas"
      side="auto"
      width={290}
      disabled={disabled}
      buttonLabel="Example tasks"
      buttonTitle="Example tasks"
      buttonClassName="grid h-8 w-8 place-items-center rounded-full text-s-ink-3 transition hover:bg-s-hover hover:text-s-ink disabled:opacity-50 [&_svg]:h-4 [&_svg]:w-4"
      button={<Lightbulb />}
    >
      {examples.map((e) => (
        <MenuItem
          key={e.label}
          icon={e.mode === "read" ? <Eye /> : e.start ? <Sparkles /> : <Plus />}
          hint={e.start ? (e.mode === "read" ? "Starts now · read-only" : "Starts now") : "Fills in the box; add the details"}
          onClick={() => onPick(e)}
        >
          {e.label}
        </MenuItem>
      ))}
    </Menu>
  );
}

const TIP_KEY = "orbis.code.tip";
const tipListeners = new Set<() => void>();
const tipSeen = () => {
  try {
    return localStorage.getItem(TIP_KEY) === "1";
  } catch {
    return true;
  }
};

/** Shown once, until dismissed: the two things new users miss. One quiet line, not a card. */
function FirstTip() {
  const seen = useSyncExternalStore(
    (l) => {
      tipListeners.add(l);
      return () => tipListeners.delete(l);
    },
    tipSeen,
    () => true,
  );
  if (seen) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(TIP_KEY, "1");
    } catch {
      /* shown again next time */
    }
    tipListeners.forEach((l) => l());
  };
  return (
    <p className="mb-2 flex items-start gap-2 px-2 text-[12.5px] leading-snug text-s-ink-3" role="note">
      <Lightbulb className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        Tip: press <span className="text-s-ink-2">+</span> to attach files or a screenshot of what you want. While the agent works you can keep typing — Enter queues your next message.
      </span>
      <button type="button" onClick={dismiss} aria-label="Dismiss tip" className="shrink-0 hover:text-s-ink">
        <X className="h-3.5 w-3.5" />
      </button>
    </p>
  );
}

/** What the agent may do, under the prompt bar. */
function ModeMenu({ mode, onChange, disabled }: { mode: ModeId; onChange: (m: ModeId) => void; disabled?: boolean }) {
  const current = MODES.find((m) => m.id === mode)!;
  return (
    <Menu
      label="What the agent may do"
      side="auto"
      width={330}
      disabled={disabled}
      buttonLabel={`What the agent may do: ${current.label}`}
      buttonTitle="What the agent may do"
      buttonClassName="inline-flex h-8 max-w-full items-center gap-1 rounded-full px-2 text-[12.5px] text-s-ink-2 transition hover:bg-s-hover hover:text-s-ink disabled:opacity-50"
      button={
        <>
          <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="truncate">{current.label}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden />
        </>
      }
    >
      {MODES.map((m) => (
        <MenuItem key={m.id} role="menuitemradio" checked={mode === m.id} right={mode === m.id ? <Check /> : undefined} hint={m.detail} onClick={() => onChange(m.id)} className="[&>span>span:first-child]:whitespace-normal">
          {m.label} <span className="text-s-ink-3">· {m.short}</span>
        </MenuItem>
      ))}
      <p className="mx-2.5 mb-1 mt-2 border-t border-s-line pt-2 text-[11.5px] leading-snug text-s-ink-3">
        In every mode the agent works only on this project&apos;s files and its private computer. Files like <code className="font-mono">.env</code> are never shown to the AI; it never deploys,
        publishes or pushes on its own; every change can be undone. The computer is isolated, but no setup is perfectly secure: keep real passwords and keys out of your files. Each step
        counts like one chat message on your plan.
      </p>
    </Menu>
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
  const output = typeof d.output === "string" ? d.output : typeof d.report === "string" ? d.report : null;
  const shot = typeof d.screenshot === "string" ? d.screenshot : null;
  const steps = Array.isArray(d.steps) ? (d.steps as string[]) : null;
  const failed = e.kind === "error" || (e.kind === "command" && (d.exitCode !== 0 || d.timedOut === true) && !d.blocked) || (e.kind === "command" && !!d.blocked);
  const passed = e.kind === "command" && d.exitCode === 0 && !d.timedOut;
  const expandable = !!output || !!shot || (e.kind === "summary" && typeof d.summary === "string");
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
      {open && shot && (
        // eslint-disable-next-line @next/next/no-img-element -- a screenshot from the activity log (data URL), not an optimisable asset
        <img src={`data:image/jpeg;base64,${shot}`} alt={e.title} className="mt-1.5 max-h-[420px] w-auto max-w-full rounded-md border border-s-line" />
      )}
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

/** Ask for a change to what was just built: a new session on the same project, in the same mode and model, with the earlier work as context. */
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
        <div className="font-medium text-s-ink">{p.preview ? "Start the preview with this command?" : "Allow this command?"}</div>
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
          {p.preview ? "To start the live preview with" : "To run"} <code className="font-mono text-[12px]">{p.command}</code>, the project&apos;s private computer has to be on. Starting it uses
          workspace minutes from your plan.
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
                  {TASK_STATE_INFO[taskState(r)].label} · {new Date(r.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
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

/**
 * Before a task: what it can use. Each step is one model call, charged like a
 * message to that model; the agent stops to ask after DEFAULT_STEP_LIMIT
 * steps. An upper bound, not a prediction: most tasks take fewer steps.
 */
function StepEstimate({ models, modelId, readOnly }: { models: ModelWithStatus[] | null; modelId: string; readOnly: boolean }) {
  if (!models) return null;
  const usable = models.filter((m) => m.available && !m.locked && m.units !== undefined);
  if (!usable.length) return null;
  const auto = modelId.startsWith("auto");
  const chosen = usable.find((m) => m.id === modelId);
  const lo = Math.min(...usable.map((m) => m.units!));
  const hi = Math.max(...usable.map((m) => m.units!));
  const per = auto ? (lo === hi ? `${lo}` : `${lo}–${hi}`) : chosen ? `${chosen.units}` : null;
  if (per === null) return null;
  const max = auto ? hi * DEFAULT_STEP_LIMIT : chosen!.units! * DEFAULT_STEP_LIMIT;
  return (
    <p className="mt-1 px-2 text-[11.5px] leading-snug text-s-ink-3">
      Each step uses {per} unit{per === "1" ? "" : "s"} ({auto ? "Auto picks the model per step" : chosen!.displayName}). It stops to ask after {DEFAULT_STEP_LIMIT} steps, so a task uses at most{" "}
      {max} units before you decide to give it {STEP_LIMIT_INCREMENT} more{readOnly ? "" : "; computer time for running code is counted separately"}. Most tasks use fewer.
    </p>
  );
}
