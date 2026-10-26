"use client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  Eye,
  File as FileIcon,
  FilePlus2,
  FileText,
  Folder,
  History,
  ListChecks,
  PanelRightOpen,
  PanelLeft,
  Code2,
  Download,
  FolderOpen,
  FolderPlus,
  Maximize2,
  Minimize2,
  Monitor,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Play,
  Plus,
  Power,
  RotateCw,
  Search,
  Settings2,
  Smartphone,
  Sparkles,
  BookMarked,
  Tablet,
  Square,
  SquareArrowOutUpRight,
  Terminal as TerminalIcon,
  Trash2,
  X,
} from "lucide-react";
import { useCatalog } from "@/components/common/model-picker";
import { StudioHeader, useStudio } from "@/components/studio/frame";
import { ModelSelector } from "@/components/studio/model-selector";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "@/components/studio/ui";
import { isWebTask } from "@/lib/code/agent/protocol";
import type { RunView } from "@/lib/code/agent/types";
import { EXAMPLE_PROJECT, validProjectPath, type FileChange, type ProjectSummary } from "@/lib/code/projects";
import { cn } from "@/lib/utils";
import { AgentPanel, SessionsList } from "./agent-panel";
import { PairPanel } from "./pair-panel";
import { api, CodeApiError, plainText, post, takeBuildRequest, type AiResult, type BuildRequest, type Allowance, type JobRead, type ProjectData, type Session } from "./api";
import { ChangesPanel } from "./changes-panel";
import { MemoryPanel } from "./memory-panel";
import { FileDiff } from "./diff-view";
import { minutesLine } from "./projects-view";

const CodeEditor = dynamic(() => import("./editor"), { ssr: false, loading: () => <div className="s-skeleton m-4 h-6 w-1/2" /> });

type PreviewSize = "full" | "tablet" | "phone";
/** The same widths the browser check uses for tablet and phone. */
const PREVIEW_SIZES: { id: PreviewSize; label: string; width: number | null; icon: ReactNode }[] = [
  { id: "full", label: "Full width", width: null, icon: <Monitor /> },
  { id: "tablet", label: "Tablet width (768px)", width: 768, icon: <Tablet /> },
  { id: "phone", label: "Phone width (390px)", width: 390, icon: <Smartphone /> },
];

const OPEN_FIRST = ["index.html", "main.py", "index.js", "app.py", "src/index.js", "src/main.ts", "README.md"];
const TERMINAL_KEEP = 200_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Entry {
  key: number;
  command: string;
  jobId: string | null;
  output: string;
  done: boolean;
  exitCode: number | null;
  note?: string;
}

/** Phones show one pane at a time. */
type Pane = "agent" | "sessions" | "files" | "editor" | "changes" | "memory" | "preview" | "terminal" | "ai";
/** Larger screens: the optional panel beside the agent. */
type Side = "editor" | "changes" | "memory" | "preview" | "terminal" | "ai";

/** Sizes the user dragged, remembered in this browser (and in memory when storage is unavailable). */
const sizeMemory = new Map<string, number>();
const sizeListeners = new Set<() => void>();
function useStoredSize(key: string, initial: number, min: number, max: number): [number, (n: number) => void] {
  const read = () => {
    if (sizeMemory.has(key)) return sizeMemory.get(key)!;
    try {
      const v = Number(localStorage.getItem(key));
      if (v >= min && v <= max) return v;
    } catch {}
    return initial;
  };
  const value = useSyncExternalStore(
    (cb) => {
      sizeListeners.add(cb);
      return () => sizeListeners.delete(cb);
    },
    read,
    () => initial,
  );
  const set = useCallback(
    (n: number) => {
      const v = Math.round(Math.min(max, Math.max(min, n)));
      sizeMemory.set(key, v);
      try {
        localStorage.setItem(key, String(v));
      } catch {}
      sizeListeners.forEach((l) => l());
    },
    [key, min, max],
  );
  return [value, set];
}

/** A drag handle between panels (arrow keys work too). `sign` is -1 when dragging toward the start shrinks the next panel. */
function Resizer({ axis, value, onChange, label, sign = 1 }: { axis: "x" | "y"; value: number; onChange: (n: number) => void; label: string; sign?: 1 | -1 }) {
  const start = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const from = axis === "x" ? e.clientX : e.clientY;
    const base = value;
    const move = (ev: PointerEvent) => onChange(base + sign * ((axis === "x" ? ev.clientX : ev.clientY) - from));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.userSelect = "";
    };
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-label={label}
      aria-valuenow={value}
      tabIndex={0}
      onPointerDown={start}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 48 : 16;
        const less = axis === "x" ? "ArrowLeft" : "ArrowUp";
        const more = axis === "x" ? "ArrowRight" : "ArrowDown";
        if (e.key === less) onChange(value - sign * step);
        if (e.key === more) onChange(value + sign * step);
      }}
      className={cn(
        "group relative z-10 shrink-0 outline-none",
        axis === "x" ? "-mx-[3px] w-[7px] cursor-col-resize" : "-my-[3px] h-[7px] cursor-row-resize",
      )}
    >
      <span className={cn("absolute bg-transparent transition group-hover:bg-s-accent/60 group-focus-visible:bg-s-accent", axis === "x" ? "inset-y-0 left-[3px] w-px" : "inset-x-0 top-[3px] h-px")} />
    </div>
  );
}

/** Phones get one pane at a time, larger screens all of them; only one layout is rendered. */
const WIDE = "(min-width: 768px)";
function useWide(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(WIDE);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(WIDE).matches,
    () => true,
  );
}

function Btn({ children, onClick, disabled, title, primary, className }: { children: ReactNode; onClick?: () => void; disabled?: boolean; title?: string; primary?: boolean; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[12.5px] transition disabled:opacity-40",
        primary ? "bg-s-accent font-medium text-s-accent-ink hover:brightness-110" : "border border-s-line text-s-ink-2 hover:border-s-line-strong hover:text-s-ink",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Folders and files from flat paths, folders first. */
type Node = { name: string; path: string; children?: Node[] };
function buildTree(paths: string[]): Node[] {
  const root: Node = { name: "", path: "", children: [] };
  for (const p of paths) {
    const parts = p.split("/");
    let cur = root;
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/");
      if (i === parts.length - 1) cur.children!.push({ name: part, path });
      else {
        let next = cur.children!.find((c) => c.children && c.name === part);
        if (!next) cur.children!.push((next = { name: part, path, children: [] }));
        cur = next;
      }
    });
  }
  const sort = (n: Node[]): Node[] => n.sort((a, b) => Number(!!b.children) - Number(!!a.children) || a.name.localeCompare(b.name)).map((x) => (x.children ? { ...x, children: sort(x.children) } : x));
  return sort(root.children!);
}

/** A code project: files, editor, terminal, preview and changes, with the coding agent — or, with `pair`, two agents (pair coding). */
export function CodeWorkspace({ id, pair = false }: { id: string; pair?: boolean }) {
  const { theme } = useStudio();
  const catalog = useCatalog();
  const wide = useWide();
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [active, setActive] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [allowance, setAllowance] = useState<Allowance | null>(null);
  const [loadError, setLoadError] = useState<CodeApiError | null>(null);
  const [error, setError] = useState<CodeApiError | null>(null);
  const [starting, setStarting] = useState(false);
  const [saving, setSaving] = useState<"idle" | "saving" | "error">("idle");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [command, setCommand] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [histAt, setHistAt] = useState<number | null>(null);
  // The agent is the main view; the editor, changes, preview, terminal and quick edit open beside it on demand.
  const [right, setRight] = useState<Side | null>(null);
  const [focusRun, setFocusRun] = useState<string | null>(null);
  // Files and sessions stay out of the way until there's a task (or the user opens them).
  const [filesOpen, setFilesOpenState] = useState(false);
  const filesTouched = useRef(false);
  const setFilesOpen = (open: boolean) => {
    filesTouched.current = true;
    setFilesOpenState(open);
  };
  const [leftTab, setLeftTab] = useState<"files" | "sessions">("files");
  const [leftW, setLeftW] = useStoredSize("orbis.code.left", 240, 180, 420);
  const [rightW, setRightW] = useStoredSize("orbis.code.right2", 520, 320, 900);
  const [pane, setPane] = useState<Pane>("agent");
  // Coding sessions (agent runs): which one is open, and a counter so the list refreshes.
  const params = useSearchParams();
  // From History: "?run=<id>" opens that task; "?continue=<id>" opens a new task that continues a finished one.
  const [select, setSelect] = useState<{ runId: string | null; n: number } | null>(() =>
    params.get("run") ? { runId: params.get("run"), n: 0 } : params.get("continue") ? { runId: null, n: 0 } : null,
  );
  const [continueFrom] = useState(() => params.get("continue"));
  const [activeRun, setActiveRun] = useState<RunView | null>(null);
  const [sessionsVersion, setSessionsVersion] = useState(0);
  // A workflow from project memory fills the next session's request.
  const [draftRequest, setDraftRequest] = useState<string | null>(null);
  const initialRequest = draftRequest ?? (params.get("task") === "example" ? EXAMPLE_PROJECT.task : undefined);
  // "Build website": the request comes from the start screen (kept for this page, so later URL changes don't matter).
  const [buildRequest] = useState<BuildRequest | undefined>(() => (params.get("build") === "1" ? takeBuildRequest(id) : undefined));
  // The live site: whether it answers on the preview port (asked from the computer, not assumed).
  const [site, setSite] = useState<{ http: number; running: boolean; exitCode: number | null } | null>(null);
  const [siteWaiting, setSiteWaiting] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [newFile, setNewFile] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [previewKey, setPreviewKey] = useState(0);
  /** The preview's width: the panel's, or a tablet's or phone's (to see the site as those screens do). */
  const [previewSize, setPreviewSize] = useState<PreviewSize>("full");
  /** The preview fills the window (the same frame, so the page isn't reloaded). */
  const [previewLarge, setPreviewLarge] = useState(false);
  useEffect(() => {
    if (!previewLarge) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPreviewLarge(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previewLarge]);
  // AI
  const [instruction, setInstruction] = useState("");
  const [modelId, setModelId] = useState("auto:coding");
  const [asking, setAsking] = useState(false);
  const [ai, setAi] = useState<AiResult | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);

  const draftsRef = useRef(drafts);
  useEffect(() => {
    draftsRef.current = drafts;
  }, [drafts]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const alive = useRef(true);
  const termEnd = useRef<HTMLDivElement>(null);
  const entryKey = useRef(0);

  const applyData = useCallback((d: ProjectData, keepActive = true) => {
    setProject(d.project);
    setSaved(Object.fromEntries(d.files.map((f) => [f.path, f.content])));
    setSession(d.session);
    setActive((cur) => {
      if (keepActive && cur && d.files.some((f) => f.path === cur)) return cur;
      return OPEN_FIRST.find((p) => d.files.some((f) => f.path === p)) ?? d.files[0]?.path ?? null;
    });
  }, []);

  const reload = useCallback(async () => {
    const d = await api<ProjectData>(`/api/code/projects/${id}`);
    if (alive.current) applyData(d);
  }, [id, applyData]);

  useEffect(() => {
    alive.current = true;
    api<ProjectData>(`/api/code/projects/${id}`)
      .then((d) => alive.current && applyData(d, false))
      .catch((e: CodeApiError) => alive.current && setLoadError(e));
    api<{ allowance: Allowance }>(`/api/code/projects/${id}/session`)
      .then((s) => alive.current && setAllowance(s.allowance))
      .catch(() => {});
    const t = setInterval(() => setNow(Date.now()), 1000);
    const pending = timers.current;
    // Edits still waiting for their save (typed in the last 0.8 s) are sent now when you leave, rather than dropped.
    const sendPending = () => {
      const paths = [...pending.keys()];
      if (!paths.length) return;
      paths.forEach((p) => clearTimeout(pending.get(p)));
      pending.clear();
      const changes = paths.map((path) => ({ path, content: draftsRef.current[path] })).filter((c) => c.content !== undefined);
      if (!changes.length) return;
      const body = JSON.stringify({ changes });
      // keepalive lets the request outlive a closing tab, but only for small bodies (browsers cap it at 64 KB).
      void fetch(`/api/code/projects/${id}/files`, { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: body.length < 60_000 }).catch(() => {});
    };
    window.addEventListener("pagehide", sendPending);
    return () => {
      alive.current = false;
      clearInterval(t);
      window.removeEventListener("pagehide", sendPending);
      sendPending();
    };
  }, [id, applyData]);

  // While the computer runs, check its state every 30 seconds (it stops on its own when its time ends).
  useEffect(() => {
    if (!session) return;
    const t = setInterval(() => {
      api<{ session: Session | null; allowance: Allowance }>(`/api/code/projects/${id}/session`)
        .then((s) => {
          if (!alive.current) return;
          setSession(s.session);
          setAllowance(s.allowance);
        })
        .catch(() => {});
    }, 30_000);
    return () => clearInterval(t);
  }, [id, session]);

  useEffect(() => {
    termEnd.current?.scrollIntoView({ block: "end" });
  }, [entries]);

  const secondsLeft = session ? Math.max(0, Math.round((Date.parse(session.endsAt) - now) / 1000)) : 0;
  const running = !!session && secondsLeft > 0;
  const content = (p: string) => drafts[p] ?? saved[p] ?? "";
  const paths = useMemo(() => [...new Set([...Object.keys(saved), ...Object.keys(drafts)])].sort(), [saved, drafts]);
  // A website project: the agent shows website examples and the preview opens on its own.
  const web = useMemo(() => isWebTask(buildRequest?.request ?? "", Object.entries(saved).map(([path, content]) => ({ path, content })), project?.template ?? ""), [buildRequest, saved, project?.template]);
  const tree = useMemo(() => buildTree(paths), [paths]);

  // ------------------------------------------------------------ saving

  const save = useCallback(
    async (path: string) => {
      const value = draftsRef.current[path];
      if (value === undefined) return;
      setSaving("saving");
      try {
        await post(`/api/code/projects/${id}/files`, { changes: [{ path, content: value }] });
        setSaved((s) => ({ ...s, [path]: value }));
        setDrafts((d) => {
          if (d[path] !== value) return d;
          const rest = { ...d };
          delete rest[path];
          return rest;
        });
        setSaving("idle");
      } catch (e) {
        setSaving("error");
        setError(e as CodeApiError);
      }
    },
    [id],
  );

  const edit = (path: string, value: string) => {
    setDrafts((d) => ({ ...d, [path]: value }));
    const t = timers.current.get(path);
    if (t) clearTimeout(t);
    timers.current.set(
      path,
      setTimeout(() => {
        timers.current.delete(path);
        void save(path);
      }, 800),
    );
  };

  const flush = async () => {
    const pending = [...timers.current.keys()];
    pending.forEach((p) => clearTimeout(timers.current.get(p)));
    timers.current.clear();
    await Promise.all(Object.keys(draftsRef.current).map((p) => save(p)));
  };

  const changeFiles = async (changes: { path: string; content: string | null }[]) => {
    await post(`/api/code/projects/${id}/files`, { changes });
    setSaved((s) => {
      const n = { ...s };
      for (const c of changes) {
        if (c.content === null) delete n[c.path];
        else n[c.path] = c.content;
      }
      return n;
    });
    setDrafts((d) => {
      const n = { ...d };
      for (const c of changes) delete n[c.path];
      return n;
    });
  };

  const createFile = async (raw: string) => {
    const path = raw.trim().replace(/^\.\//, "");
    if (!validProjectPath(path)) return setError(new CodeApiError("Use a plain file path like src/app.js.", 400, "bad_request", null));
    if (path in saved) return setActive(path);
    try {
      await changeFiles([{ path, content: "" }]);
      setActive(path);
      setNewFile(null);
      setPane("editor");
      setRight("editor");
    } catch (e) {
      setError(e as CodeApiError);
    }
  };

  const renameFile = async (path: string) => {
    const next = prompt("New name for this file", path)?.trim();
    if (!next || next === path) return;
    if (!validProjectPath(next)) return setError(new CodeApiError("Use a plain file path like src/app.js.", 400, "bad_request", null));
    try {
      await changeFiles([
        { path, content: null },
        { path: next, content: content(path) },
      ]);
      if (active === path) setActive(next);
    } catch (e) {
      setError(e as CodeApiError);
    }
  };

  const deleteFile = async (path: string) => {
    if (!confirm(`Delete ${path}?`)) return;
    try {
      await changeFiles([{ path, content: null }]);
      if (active === path) setActive(null);
    } catch (e) {
      setError(e as CodeApiError);
    }
  };

  // ------------------------------------------------------------ computer

  const sessionAction = async (action: "start" | "extend" | "stop"): Promise<Session | null> => {
    setError(null);
    if (action !== "stop") setStarting(true);
    try {
      const r = await post<{ session: Session | null; allowance?: Allowance }>(`/api/code/projects/${id}/session`, { action });
      setSession(r.session);
      if (r.allowance) setAllowance(r.allowance);
      if (action === "stop") setEntries((es) => es.map((e) => (e.done ? e : { ...e, done: true, note: "Stopped with the computer." })));
      return r.session;
    } catch (e) {
      setError(e as CodeApiError);
      return null;
    } finally {
      setStarting(false);
    }
  };

  const poll = async (key: number, jobId: string) => {
    let offset = 0;
    const started = Date.now();
    while (alive.current) {
      await sleep(Date.now() - started < 10_000 ? 700 : 1500);
      let r: JobRead;
      try {
        r = await api<JobRead>(`/api/code/projects/${id}/exec?job=${jobId}&offset=${offset}`);
      } catch (e) {
        const err = e as CodeApiError;
        if (err.stopped) setSession(null);
        setEntries((es) => es.map((x) => (x.key === key ? { ...x, done: true, note: err.stopped ? "The computer stopped." : err.message } : x)));
        return;
      }
      offset = r.offset;
      const text = plainText(r.output);
      let note: string | undefined;
      if (r.sync) {
        const parts = [
          r.sync.changed.length ? `saved ${r.sync.changed.join(", ")}` : "",
          r.sync.deleted.length ? `removed ${r.sync.deleted.join(", ")}` : "",
          r.sync.skipped.length ? `not saved (binary, too large or over the limits): ${r.sync.skipped.slice(0, 10).join(", ")}` : "",
          r.sync.error ?? "",
        ].filter(Boolean);
        note = parts.length ? `Project files: ${parts.join("; ")}.` : undefined;
        if (r.sync.changed.length || r.sync.deleted.length) await reload().catch(() => {});
      }
      setEntries((es) =>
        es.map((x) => (x.key === key ? { ...x, output: (x.output + text).slice(-TERMINAL_KEEP), done: r.done, exitCode: r.exitCode, note: note ?? x.note } : x)),
      );
      if (r.done) return;
    }
  };

  const run = async (cmd: string, preview = false) => {
    const c = cmd.trim();
    if (!c) return;
    setError(null);
    setPane("terminal");
    setRight("terminal");
    setHistory((h) => [...h.filter((x) => x !== c), c].slice(-50));
    setHistAt(null);
    const key = ++entryKey.current;
    setEntries((es) => [...es.slice(-30), { key, command: c, jobId: null, output: "", done: false, exitCode: null }]);
    await flush();
    let live = running ? session : null;
    if (!live) {
      setEntries((es) => es.map((x) => (x.key === key ? { ...x, note: "Starting the computer…" } : x)));
      live = await sessionAction("start");
      if (!live) {
        setEntries((es) => es.map((x) => (x.key === key ? { ...x, done: true, note: "The computer didn't start." } : x)));
        return;
      }
    }
    try {
      const { jobId } = await post<{ jobId: string }>(`/api/code/projects/${id}/exec`, { command: c, ...(preview ? { preview: true } : {}) });
      setEntries((es) => es.map((x) => (x.key === key ? { ...x, jobId, note: undefined } : x)));
      void poll(key, jobId);
    } catch (e) {
      setEntries((es) => es.map((x) => (x.key === key ? { ...x, done: true, note: (e as Error).message } : x)));
    }
  };

  const stopJob = async (e: Entry) => {
    if (!e.jobId) return;
    try {
      await api(`/api/code/projects/${id}/exec?job=${e.jobId}`, { method: "DELETE" });
    } catch (err) {
      setError(err as CodeApiError);
    }
  };

  /** Ask the computer whether the site answers; with `wait`, keep asking until it does, its server stops, or 90 s pass. */
  const checkSite = useCallback(
    async (wait = false) => {
      const until = Date.now() + 90_000;
      if (wait) setSiteWaiting(true);
      try {
        for (;;) {
          const r = await api<{ preview: { http: number; running: boolean; exitCode: number | null; url: string | null } | null }>(`/api/code/projects/${id}/preview`).catch(() => null);
          if (!alive.current) return;
          const p = r?.preview ?? null;
          setSite(p);
          if (!wait || !p || p.http > 0 || (!p.running && p.exitCode !== null) || Date.now() > until) return p;
          await sleep(1500);
        }
      } finally {
        if (wait) setSiteWaiting(false);
      }
    },
    [id],
  );

  const showPreview = useCallback(() => {
    if (wide) {
      setRight("preview");
      // On a laptop-sized screen the site and the agent need the room more than the file list.
      if (window.innerWidth < 1360) setFilesOpen(false);
    } else setPane("preview");
    setPreviewKey((k) => k + 1);
  }, [wide]);

  /** Run the project: its Run command becomes the live preview's server (replacing a running one, the agent's included). */
  const runProject = async () => {
    if (!project) return;
    if (!project.runCommand.trim()) return editRunCommand();
    await run(project.runCommand, true);
    const p = await checkSite(true);
    if (p && p.http > 0) showPreview();
  };

  // When the computer is on, find out whether the site is up (so the preview shows the real state).
  useEffect(() => {
    if (running) void checkSite();
  }, [running, checkSite]);

  // The agent started the preview, checked it, or changed the site: show it fresh (reloads are spaced out while it edits).
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onPreview = useCallback(
    (what: "started" | "checked" | "changed") => {
      if (what === "started") {
        void api<{ session: Session | null }>(`/api/code/projects/${id}/session`)
          .then((s) => alive.current && setSession(s.session))
          .catch(() => {});
        void checkSite();
        showPreview();
        return;
      }
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
      reloadTimer.current = setTimeout(() => setPreviewKey((k) => k + 1), 1200);
    },
    [id, checkSite, showPreview],
  );

  const editRunCommand = async () => {
    if (!project) return;
    const next = prompt("Command the Run button uses (for example: python3 main.py, or npm install && npm start)", project.runCommand);
    if (next === null) return;
    try {
      const r = await api<{ project: ProjectSummary }>(`/api/code/projects/${id}`, { method: "PATCH", body: JSON.stringify({ runCommand: next.trim() }) });
      setProject(r.project);
    } catch (e) {
      setError(e as CodeApiError);
    }
  };

  const renameProject = async () => {
    if (!project) return;
    const next = prompt("Project name", project.name)?.trim();
    if (!next || next === project.name) return;
    try {
      const r = await api<{ project: ProjectSummary }>(`/api/code/projects/${id}`, { method: "PATCH", body: JSON.stringify({ name: next }) });
      setProject(r.project);
    } catch (e) {
      setError(e as CodeApiError);
    }
  };

  const describeProject = async () => {
    if (!project) return;
    const next = prompt("What is this project for? (shown in Projects and History; leave empty to remove)", project.description ?? "");
    if (next === null || next.trim() === (project.description ?? "")) return;
    try {
      const r = await api<{ project: ProjectSummary }>(`/api/code/projects/${id}`, { method: "PATCH", body: JSON.stringify({ description: next.trim().slice(0, 500) }) });
      setProject(r.project);
    } catch (e) {
      setError(e as CodeApiError);
    }
  };

  // ------------------------------------------------------------ AI

  const askAi = async () => {
    if (!instruction.trim() || asking) return;
    setAsking(true);
    setAi(null);
    setError(null);
    try {
      await flush();
      const r = await post<AiResult>(`/api/code/projects/${id}/ai`, { instruction, activePath: active, modelId, requestId: crypto.randomUUID() });
      setAi(r);
      setPicked(new Set(r.changes.map((c) => c.path)));
    } catch (e) {
      setError(e as CodeApiError);
    } finally {
      setAsking(false);
    }
  };

  const accept = async () => {
    if (!ai) return;
    const chosen = ai.changes.filter((c) => picked.has(c.path));
    if (!chosen.length) return;
    setApplying(true);
    try {
      await changeFiles(chosen.map((c) => ({ path: c.path, content: c.after })));
      const opened = chosen.find((c) => c.after !== null);
      if (opened && (!active || !chosen.some((c) => c.path === active))) setActive(opened.path);
      if (active && chosen.some((c) => c.path === active && c.after === null)) setActive(null);
      setAi(null);
      setInstruction("");
    } catch (e) {
      setError(e as CodeApiError);
    } finally {
      setApplying(false);
    }
  };

  const startComputer = async () => !!(running || (await sessionAction("start")));
  const openFile = (path: string) => {
    setActive(path);
    setPane("editor");
    setRight("editor");
  };
  const onRunChange = useCallback((r: RunView | null) => {
    if (r && !filesTouched.current) setFilesOpenState(true);
    setActiveRun((prev) => {
      // A new session, or one whose status changed: the sessions list shows it.
      if (prev?.id !== r?.id || prev?.status !== r?.status) setSessionsVersion((v) => v + 1);
      return r;
    });
  }, []);
  const openSession = (runId: string | null, draft: string | null = null) => {
    setDraftRequest(draft);
    setSelect((s) => ({ runId, n: (s?.n ?? 0) + 1 }));
    setPane("agent");
  };
  const showChanges = (runId: string) => {
    setFocusRun(runId);
    setRight("changes");
    setPane("changes");
  };
  const reloadFiles = useCallback(() => void reload().catch(() => {}), [reload]);

  // ------------------------------------------------------------ render

  if (loadError) {
    return (
      <>
        <StudioHeader>
          <Link href="/code" className="text-[14px] font-medium text-s-ink-2 hover:text-s-ink">
            Code
          </Link>
        </StudioHeader>
        <div className="grid flex-1 place-items-center px-6 text-center">
          <div>
            <p className="text-[15px] text-s-ink-2">{loadError.status === 401 ? "Sign in to open your projects." : loadError.message}</p>
            <Link href={loadError.status === 401 ? `/login?next=/code/${id}` : "/code"} className="mt-4 inline-flex h-10 items-center rounded-full bg-s-accent px-5 text-[14px] font-medium text-s-accent-ink">
              {loadError.status === 401 ? "Sign in" : "All projects"}
            </Link>
          </div>
        </div>
      </>
    );
  }

  const mm = Math.floor(secondsLeft / 60);
  const ss = String(secondsLeft % 60).padStart(2, "0");
  const block = allowance?.blockMinutes ?? 10;

  const status = (
    <span className={cn("hidden items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12px] xl:inline-flex", running ? "border-emerald-500/40 text-s-ink" : "border-s-line text-s-ink-3")}>
      <span className={cn("h-1.5 w-1.5 rounded-full", running ? "bg-emerald-500" : "bg-s-ink-3")} />
      {starting ? "Starting…" : running ? `Computer on · ${mm}:${ss} left` : "Computer off"}
    </span>
  );

  const treeView = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[11.5px] text-s-ink-3">
          {paths.length} file{paths.length === 1 ? "" : "s"} · the agent can read and change these
        </span>
        <button type="button" onClick={() => setNewFile("")} aria-label="New file" title="New file" className="grid h-7 w-7 place-items-center rounded-lg text-s-ink-2 hover:bg-s-hover">
          <FilePlus2 className="h-4 w-4" />
        </button>
      </div>
      {newFile !== null && (
        <form
          className="px-2 pb-2"
          onSubmit={(e) => {
            e.preventDefault();
            void createFile(newFile);
          }}
        >
          <input
            autoFocus
            value={newFile}
            onChange={(e) => setNewFile(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setNewFile(null)}
            onBlur={() => !newFile && setNewFile(null)}
            placeholder="path/name.ext"
            aria-label="New file path"
            className="h-8 w-full rounded-lg border border-s-line-strong bg-transparent px-2 font-mono text-[12.5px] outline-none"
          />
        </form>
      )}
      <FileSearch
        files={{ ...saved, ...drafts }}
        onOpen={openFile}
      >
        <div className="s-scroll min-h-0 flex-1 overflow-y-auto px-1 pb-3">
          {paths.length === 0 && project && <p className="px-3 py-2 text-[12.5px] text-s-ink-3">No files yet.</p>}
          <TreeList
            nodes={tree}
            depth={0}
            active={active}
            dirty={drafts}
            collapsed={collapsed}
            onToggle={(p) => setCollapsed((c) => (c.has(p) ? new Set([...c].filter((x) => x !== p)) : new Set([...c, p])))}
            onOpen={openFile}
            onRename={renameFile}
            onDelete={deleteFile}
          />
        </div>
      </FileSearch>
    </div>
  );

  const editorView = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-s-line px-3">
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-s-ink-2">{active ?? "No file open"}</span>
        <span className="shrink-0 text-[11.5px] text-s-ink-3">
          {saving === "saving" ? "Saving…" : saving === "error" ? <span className="text-s-danger">Not saved</span> : Object.keys(drafts).length ? "Unsaved" : active ? "Saved" : ""}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {active ? (
          <CodeEditor path={active} value={content(active)} onChange={(v) => edit(active, v)} dark={theme.resolved === "dark"} />
        ) : (
          <div className="grid h-full place-items-center p-6 text-center text-[13.5px] text-s-ink-3">Choose a file on the left, or create one.</div>
        )}
      </div>
    </div>
  );

  const terminalView = (
    <div className="flex h-full min-h-0 flex-col bg-[var(--s-code,transparent)]">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-s-line px-3">
        <TerminalIcon className="h-3.5 w-3.5 text-s-ink-3" />
        <span className="text-[11.5px] font-medium uppercase tracking-[0.08em] text-s-ink-3">Terminal</span>
        <span className="ml-auto text-[11.5px] text-s-ink-3">{running ? "Packages install from npm and PyPI; other sites are blocked." : "Runs on the workspace computer"}</span>
        {entries.length > 0 && (
          <button type="button" onClick={() => setEntries((es) => es.filter((e) => !e.done))} className="text-[11.5px] text-s-ink-3 hover:text-s-ink">
            Clear
          </button>
        )}
      </div>
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-[12px] leading-[1.5]">
        {entries.length === 0 && <p className="text-s-ink-3">Type a command below (for example: ls, python3 main.py, npm install express), or press Run.</p>}
        {entries.map((e) => (
          <div key={e.key} className="mb-2">
            <div className="flex items-center gap-2">
              <span className="text-s-ink-3">$</span>
              <span className="min-w-0 flex-1 truncate text-s-ink">{e.command}</span>
              {!e.done && e.jobId && (
                <button type="button" onClick={() => void stopJob(e)} className="inline-flex shrink-0 items-center gap-1 rounded-full border border-s-line px-2 py-0.5 text-[11px] text-s-ink-2 hover:border-s-line-strong">
                  <Square className="h-3 w-3" /> Stop
                </button>
              )}
              {!e.done && <span className="shrink-0 text-[11px] text-s-ink-3">running…</span>}
              {e.done && e.exitCode !== null && <span className={cn("shrink-0 text-[11px]", e.exitCode === 0 ? "text-s-ink-3" : "text-s-danger")}>exit {e.exitCode}</span>}
            </div>
            {e.output && <pre className="whitespace-pre-wrap break-words text-s-ink-2">{e.output}</pre>}
            {e.note && <p className="mt-0.5 text-[11.5px] text-s-ink-3">{e.note}</p>}
          </div>
        ))}
        <div ref={termEnd} />
      </div>
      <form
        className="flex shrink-0 items-center gap-2 border-t border-s-line px-3 py-2"
        onSubmit={(e) => {
          e.preventDefault();
          const c = command;
          setCommand("");
          void run(c);
        }}
      >
        <span className="font-mono text-[12px] text-s-ink-3">$</span>
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp" && history.length) {
              e.preventDefault();
              const i = histAt === null ? history.length - 1 : Math.max(0, histAt - 1);
              setHistAt(i);
              setCommand(history[i]!);
            } else if (e.key === "ArrowDown" && histAt !== null) {
              e.preventDefault();
              const i = histAt + 1;
              if (i >= history.length) {
                setHistAt(null);
                setCommand("");
              } else {
                setHistAt(i);
                setCommand(history[i]!);
              }
            }
          }}
          maxLength={2000}
          placeholder={running ? "Type a command and press Enter" : "Type a command (starts the computer)"}
          aria-label="Terminal command"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent font-mono text-[12.5px] outline-none placeholder:text-s-ink-3"
        />
      </form>
    </div>
  );

  const previewView = (
    <div
      className={cn("flex h-full min-h-0 flex-col", previewLarge && "fixed inset-0 z-50 h-auto bg-s-bg")}
      {...(previewLarge ? { role: "dialog", "aria-modal": true, "aria-label": "Preview, large view" } : {})}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-s-line px-3">
        <Eye className="h-3.5 w-3.5 text-s-ink-3" />
        <span className="min-w-0 flex-1 truncate text-[12px] text-s-ink-3">{running && session?.previewUrl ? session.previewUrl.replace(/^https?:\/\//, "") : "Preview"}</span>
        {running && (
          <span
            className={cn("shrink-0 text-[11.5px]", site?.http ? "text-emerald-600 dark:text-emerald-400" : "text-s-ink-3")}
            title="Asked from the project's computer: does anything answer on port 3000?"
          >
            {siteWaiting ? "Starting…" : site?.http ? "Running" : site ? (site.running ? "Not answering yet" : "Not running") : ""}
          </span>
        )}
        {running && session?.previewUrl && (
          <>
            <button
              type="button"
              onClick={() => {
                setPreviewKey((k) => k + 1);
                void checkSite();
              }}
              aria-label="Reload preview"
              className="grid h-7 w-7 place-items-center rounded-lg text-s-ink-2 hover:bg-s-hover"
            >
              <RotateCw className="h-3.5 w-3.5" />
            </button>
            <div role="group" aria-label="Preview width" className="flex shrink-0 items-center rounded-lg border border-s-line">
              {PREVIEW_SIZES.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setPreviewSize(v.id)}
                  aria-pressed={previewSize === v.id}
                  aria-label={v.label}
                  title={v.label}
                  className={cn("grid h-6 w-7 place-items-center text-s-ink-3 first:rounded-l-lg last:rounded-r-lg hover:text-s-ink [&_svg]:h-3.5 [&_svg]:w-3.5", previewSize === v.id && "bg-s-hover text-s-ink")}
                >
                  {v.icon}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setPreviewLarge((x) => !x)}
              aria-label={previewLarge ? "Close the large view" : "Open a large view of the preview"}
              title={previewLarge ? "Close the large view (Esc)" : "Large view"}
              className="grid h-7 w-7 place-items-center rounded-lg text-s-ink-2 hover:bg-s-hover"
            >
              {previewLarge ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </button>
            <a href={session.previewUrl} target="_blank" rel="noreferrer" aria-label="Open preview in a new tab" className="grid h-7 w-7 place-items-center rounded-lg text-s-ink-2 hover:bg-s-hover">
              <SquareArrowOutUpRight className="h-3.5 w-3.5" />
            </a>
          </>
        )}
      </div>
      {running && session?.previewUrl && (site === null || site.http > 0 || siteWaiting) ? (
        <div className={cn("flex min-h-0 flex-1 justify-center overflow-auto", previewSize !== "full" && "bg-s-hover/60 p-3")}>
          <iframe
            key={previewKey}
            src={session.previewUrl}
            title="Live preview"
            style={previewSize === "full" ? undefined : { width: PREVIEW_SIZES.find((v) => v.id === previewSize)!.width ?? undefined, flex: "none" }}
            className={cn("h-full min-h-0 bg-white", previewSize === "full" ? "w-full" : "rounded-lg border border-s-line shadow-sm")}
            sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals"
          />
        </div>
      ) : (
        <div className="grid flex-1 place-items-center p-6 text-center text-[13px] leading-relaxed text-s-ink-3">
          <div>
            <p>
              {running && site && !site.running && site.exitCode !== null
                ? `The app's server stopped (exit code ${site.exitCode}). Its output is in the terminal.`
                : running && site
                  ? "Nothing answers on port 3000 yet."
                  : "Nothing is running yet."}
            </p>
            <p className="mt-1">
              Press <strong className="text-s-ink-2">Run</strong> to start the site (apps show here when they listen on port 3000), or ask the agent to build one.
            </p>
            {project?.runCommand && (
              <button type="button" onClick={() => void runProject()} className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-full border border-s-line px-3 text-[12.5px] text-s-ink-2 hover:text-s-ink">
                <Play className="h-3.5 w-3.5" aria-hidden /> Run {project.runCommand.length > 40 ? "" : project.runCommand}
              </button>
            )}
          </div>
        </div>
      )}
      <p className="shrink-0 border-t border-s-line px-3 py-1.5 text-[11px] text-s-ink-3">The preview address is public while the computer is on. Don&apos;t put secrets in your project.</p>
    </div>
  );

  const stale = (c: FileChange) => (c.before ?? null) !== ((drafts[c.path] ?? saved[c.path]) ?? null);
  const aiView = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-s-line px-3">
        <Sparkles className="h-3.5 w-3.5 text-s-ink-3" />
        <span className="text-[11.5px] font-medium uppercase tracking-[0.08em] text-s-ink-3">Quick edit</span>
      </div>
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto p-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void askAi();
          }}
        >
          <label htmlFor="ai-ask" className="sr-only">
            What should the AI change?
          </label>
          <textarea
            id="ai-ask"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void askAi();
              }
            }}
            rows={4}
            maxLength={8000}
            placeholder={active ? `What should change? (e.g. “Add a dark mode toggle”, “Fix the error in ${active}”)` : "What should the AI build or change?"}
            className="block w-full resize-y rounded-xl border border-s-line bg-transparent p-2.5 text-[13.5px] leading-relaxed outline-none placeholder:text-s-ink-3 focus:border-s-line-strong"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <ModelSelector models={catalog?.models ?? null} value={modelId} onChange={setModelId} auto={catalog?.auto ?? null} />
            <Btn primary disabled={!instruction.trim() || asking} onClick={() => void askAi()} className="ml-auto">
              <Sparkles className="h-3.5 w-3.5" /> {asking ? "Thinking…" : "Ask AI"}
            </Btn>
          </div>
        </form>
        <p className="mt-2 text-[11.5px] leading-snug text-s-ink-3">One request, one set of proposed changes: the AI sees your files and nothing changes until you accept. For work that needs planning, running tests and fixing failures, use the Agent. Each request counts like a chat message.</p>

        {ai && (
          <div className="mt-4 space-y-3">
            <div className="rounded-xl border border-s-line p-3 text-[13px] leading-relaxed">
              <div className="text-[11px] uppercase tracking-[0.08em] text-s-ink-3">{ai.model}</div>
              {ai.summary && <p className="mt-1 text-s-ink">{ai.summary}</p>}
              {ai.message && <p className={cn("mt-1", ai.ok ? "text-s-ink-2" : "text-s-danger")}>{ai.message}</p>}
              {ai.ok && ai.changes.length === 0 && <p className="mt-1 text-s-ink-3">No file changes.</p>}
            </div>
            {ai.changes.map((c) => (
              <FileDiff
                key={c.path}
                change={c}
                stale={stale(c)}
                checked={picked.has(c.path)}
                onToggle={() => setPicked((s) => (s.has(c.path) ? new Set([...s].filter((x) => x !== c.path)) : new Set([...s, c.path])))}
              />
            ))}
            {ai.changes.length > 0 && (
              <div className="flex gap-2">
                <Btn primary disabled={!picked.size || applying} onClick={() => void accept()}>
                  {applying ? "Applying…" : picked.size === ai.changes.length ? "Accept all" : `Accept ${picked.size}`}
                </Btn>
                <Btn onClick={() => setAi(null)}>
                  <X className="h-3.5 w-3.5" /> Reject
                </Btn>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );

  const agentView = pair ? (
    <PairPanel
      key={select?.n ?? 0}
      projectId={id}
      initialRunId={select ? select.runId : undefined}
      computerOn={running}
      startComputer={startComputer}
      onFilesChanged={reloadFiles}
      onShowChanges={showChanges}
      onOpenFile={openFile}
      onOpenPreview={() => {
        showPreview();
        void checkSite();
      }}
      onRunChange={onRunChange}
    />
  ) : (
    <AgentPanel
      key={select?.n ?? 0}
      projectId={id}
      computerOn={running}
      startComputer={startComputer}
      onFilesChanged={reloadFiles}
      onShowChanges={showChanges}
      initialRunId={select ? select.runId : undefined}
      onRunChange={onRunChange}
      initialRequest={initialRequest}
      onOpenFile={openFile}
      web={web}
      onPreview={onPreview}
      onOpenPreview={() => {
        showPreview();
        void checkSite();
      }}
      autoStart={buildRequest?.request}
      autoAttachments={buildRequest?.attachments}
      autoModel={buildRequest?.modelId}
      autoSiteTemplate={buildRequest?.siteTemplate}
      autoComputer={!!buildRequest}
      continueFrom={select?.n === 0 ? continueFrom : null}
    />
  );
  const sessionsView = <SessionsList projectId={id} activeId={activeRun?.id ?? null} version={sessionsVersion} onOpen={(runId) => openSession(runId)} onNew={() => openSession(null)} />;
  const changesView = <ChangesPanel key={focusRun ?? "all"} projectId={id} sourceRepo={project?.sourceRepo ?? null} focusRun={focusRun} onFilesChanged={reloadFiles} />;
  const memoryView = (
    <MemoryPanel
      projectId={id}
      version={sessionsVersion}
      onRunWorkflow={(request) => openSession(null, request)}
    />
  );
  const sideView = (s: Side) => (s === "editor" ? editorView : s === "changes" ? changesView : s === "memory" ? memoryView : s === "preview" ? previewView : s === "terminal" ? terminalView : aiView);

  const SIDES: { id: Side; label: string; icon: ReactNode; hint: string }[] = [
    { id: "editor", label: "Editor", icon: <FileIcon className="h-4 w-4" />, hint: "Read and edit the project's files" },
    { id: "changes", label: "Changes", icon: <History className="h-4 w-4" />, hint: "What each session changed: diffs, checkpoints, undo, push to GitHub" },
    { id: "memory", label: "Memory", icon: <BookMarked className="h-4 w-4" />, hint: "Notes and workflows the agent uses in this project" },
    { id: "preview", label: "Preview", icon: <Eye className="h-4 w-4" />, hint: "See your running app" },
    { id: "terminal", label: "Terminal", icon: <TerminalIcon className="h-4 w-4" />, hint: "Run commands on the project's computer" },
    { id: "ai", label: "Quick edit", icon: <Sparkles className="h-4 w-4" />, hint: "One-shot AI edit you accept or reject (advanced)" },
  ];
  const PANES: { id: Pane; label: string }[] = [{ id: "agent", label: pair ? "Pair" : "Agent" }, { id: "sessions", label: "Sessions" }, { id: "files", label: "Files" }, ...SIDES.map((x) => ({ id: x.id as Pane, label: x.label }))];

  const leftPanel = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 gap-1 p-1.5" role="tablist" aria-label="Project">
        {(
          [
            { id: "files", label: "Files", icon: <FileIcon className="h-3.5 w-3.5" /> },
            { id: "sessions", label: "Sessions", icon: <ListChecks className="h-3.5 w-3.5" /> },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={leftTab === t.id}
            onClick={() => setLeftTab(t.id)}
            className={cn("inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg text-[12.5px]", leftTab === t.id ? "bg-s-hover text-s-ink" : "text-s-ink-3 hover:text-s-ink")}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">{leftTab === "files" ? treeView : sessionsView}</div>
    </div>
  );

  return (
    <>
      <StudioHeader
        actions={
          <div className="flex items-center gap-1">
            {/* Panels (larger screens; on phones they're the tabs below). */}
            {wide && (
              <>
                <HeaderIcon label={filesOpen && leftTab === "files" ? "Hide files" : "Files"} pressed={filesOpen && leftTab === "files"} onClick={() => (filesOpen && leftTab === "files" ? setFilesOpen(false) : (setFilesOpen(true), setLeftTab("files")))} className="hidden lg:inline-grid">
                  <PanelLeft />
                </HeaderIcon>
                <HeaderIcon label="Tasks" pressed={filesOpen && leftTab === "sessions"} onClick={() => (filesOpen && leftTab === "sessions" ? setFilesOpen(false) : (setFilesOpen(true), setLeftTab("sessions")))} className="hidden lg:inline-grid">
                  <ListChecks />
                </HeaderIcon>
                <HeaderIcon label="Changes" pressed={right === "changes"} onClick={() => setRight(right === "changes" ? null : "changes")} className="hidden lg:inline-grid">
                  <History />
                </HeaderIcon>
                <span className="mx-1 hidden h-5 w-px bg-s-line lg:block" aria-hidden />
              </>
            )}
            {status}
            {running ? (
              <Btn onClick={() => void sessionAction("stop")} title="Turn the project's computer off" className="max-sm:hidden">
                <Power className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Stop</span>
              </Btn>
            ) : (
              <Btn onClick={() => void sessionAction("start")} disabled={starting} title={`Turn on the project's private computer for ${block} minutes (to run code, tests and the preview)`} className="max-sm:hidden">
                <Power className="h-3.5 w-3.5" /> <span className="hidden sm:inline">{starting ? "Starting…" : "Start computer"}</span>
              </Btn>
            )}
            <Btn onClick={() => void runProject()} disabled={starting || !project} title={project?.runCommand ? `Runs: ${project.runCommand}` : "Set the command Run uses"}>
              <Play className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Run</span>
            </Btn>
          </div>
        }
        menu={
          <>
            {/* Phones: the computer switch lives here, so the header has room for the project's name. */}
            <MenuItem icon={<Power />} onClick={() => void sessionAction(running ? "stop" : "start")} disabled={starting} className="sm:hidden">
              {running ? "Turn the computer off" : starting ? "Starting the computer…" : "Start computer"}
            </MenuItem>
            {running && (
              <MenuItem icon={<Plus />} onClick={() => void sessionAction("extend")} disabled={starting}>
                Keep the computer on {block} more min
              </MenuItem>
            )}
            <MenuItem icon={<Settings2 />} hint={project?.runCommand ? `Now: ${project.runCommand}` : "Not set"} onClick={() => void editRunCommand()}>
              Run command…
            </MenuItem>
            <MenuItem icon={<Eye />} onClick={() => (wide ? setRight("preview") : setPane("preview"))}>
              Preview
            </MenuItem>
            <MenuItem icon={<TerminalIcon />} onClick={() => (wide ? setRight("terminal") : setPane("terminal"))}>
              Terminal
            </MenuItem>
            <MenuItem icon={<History />} hint="Diffs, undo, push to GitHub" onClick={() => (wide ? setRight("changes") : setPane("changes"))}>
              Changes
            </MenuItem>
          </>
        }
      >
        <ProjectMenu
          name={project?.name ?? "…"}
          projectId={id}
          unsaved={Object.keys(drafts).length > 0}
          onRename={() => void renameProject()}
          onDescribe={() => void describeProject()}
          described={!!project?.description}
          onRunCommand={() => void editRunCommand()}
          onMemory={() => (wide ? setRight("memory") : setPane("memory"))}
        />
      </StudioHeader>
      <h1 className="sr-only">{project ? `${project.name} — ${pair ? "Pair Coding" : "Code"}` : "Code project"}</h1>

      {error && (
        <div className="mx-3 mb-2 flex items-start gap-2 rounded-xl border border-s-line px-3 py-2 text-[13px] text-s-danger sm:mx-4" role="alert">
          <p className="min-w-0 flex-1">
            {error.message}{" "}
            {error.upgrade && (
              <Link href="/pricing" className="underline">
                See plans
              </Link>
            )}
          </p>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss" className="shrink-0 text-s-ink-3 hover:text-s-ink">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {!wide ? (
        <>
          {/* Phones: one pane at a time; the agent stays mounted so a session keeps going. */}
          <div className="flex shrink-0 gap-1 overflow-x-auto px-3 pb-2" role="tablist" aria-label="Workspace panes">
            {PANES.map((p) => (
              <button
                key={p.id}
                type="button"
                role="tab"
                aria-selected={pane === p.id}
                onClick={() => setPane(p.id)}
                className={cn("shrink-0 rounded-full px-3 py-1 text-[12.5px]", pane === p.id ? "bg-s-hover text-s-ink" : "text-s-ink-3")}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-hidden border-t border-s-line">
            <div className={cn("h-full min-h-0", pane !== "agent" && "hidden")}>{agentView}</div>
            {pane === "sessions" && sessionsView}
            {pane === "files" && treeView}
            {pane !== "agent" && pane !== "sessions" && pane !== "files" && sideView(pane)}
          </div>
        </>
      ) : (
        /* Larger screens: files and sessions | the agent | an optional panel (editor, changes, preview, terminal, quick edit). */
        <div className="flex min-h-0 flex-1 border-t border-s-line">
          {filesOpen && (
            <>
              <aside className="flex min-w-[160px] shrink flex-col border-r border-s-line" style={{ width: leftW }} aria-label="Project files and sessions">
                {leftPanel}
              </aside>
              <Resizer axis="x" value={leftW} onChange={setLeftW} label="Resize files panel" />
            </>
          )}
          {/* The agent keeps room to read; the panels beside it give way first. */}
          <section className="flex min-w-[400px] flex-1 flex-col" aria-label="Coding agent">
            <div className="min-h-0 flex-1">{agentView}</div>
            <div className="flex h-7 shrink-0 items-center gap-1 border-t border-s-line px-1.5">
              <button type="button" onClick={() => setFilesOpen(!filesOpen)} aria-pressed={filesOpen} title={filesOpen ? "Hide files and sessions" : "Show files and sessions"} className="grid h-6 w-6 place-items-center rounded text-s-ink-3 hover:bg-s-hover hover:text-s-ink">
                {filesOpen ? <PanelLeftClose className="h-3.5 w-3.5" /> : <PanelLeftOpen className="h-3.5 w-3.5" />}
              </button>
              {allowance && running && <span className="ml-1 truncate text-[11px] text-s-ink-3">{minutesLine(allowance)} · counted in {block}-minute blocks</span>}
            </div>
          </section>
          {right && <Resizer axis="x" value={rightW} onChange={setRightW} label="Resize side panel" sign={-1} />}
          <aside className={cn("flex flex-col border-l border-s-line", right ? "min-w-[300px] shrink" : "w-12 shrink-0")} style={right ? { width: rightW } : undefined} aria-label="Tools">
            <div className={cn("flex shrink-0 items-center gap-1 border-b border-s-line p-1.5", !right && "flex-col border-b-0")} role="tablist" aria-label="Tools">
              {!right && <PanelRightOpen className="mb-1 mt-1 h-4 w-4 text-s-ink-3" aria-hidden />}
              {SIDES.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  role="tab"
                  onClick={() => setRight(right === r.id ? null : r.id)}
                  aria-selected={right === r.id}
                  aria-label={r.label}
                  title={`${r.label} — ${r.hint}`}
                  className={cn("inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12.5px]", right === r.id ? "bg-s-hover text-s-ink" : "text-s-ink-3 hover:text-s-ink")}
                >
                  {r.icon}
                  {right && <span className={cn(right !== r.id && rightW < 560 && "sr-only")}>{r.label}</span>}
                </button>
              ))}
              {right && (
                <button type="button" onClick={() => setRight(null)} aria-label="Close panel" title="Close panel" className="ml-auto grid h-8 w-8 place-items-center rounded-lg text-s-ink-3 hover:bg-s-hover hover:text-s-ink">
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            {right && <div className="min-h-0 flex-1">{sideView(right)}</div>}
          </aside>
        </div>
      )}
      {allowance && running && !wide && <p className="shrink-0 border-t border-s-line px-4 py-1 text-[11px] text-s-ink-3">{minutesLine(allowance)} · counted in {block}-minute blocks.</p>}
    </>
  );
}

/** Search file names and contents; while there's a query, its matches replace the file tree. */
function FileSearch({ files, onOpen, children }: { files: Record<string, string>; onOpen: (path: string) => void; children: ReactNode }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (!q) return null;
    const names: string[] = [];
    const lines: { path: string; line: number; text: string }[] = [];
    for (const [path, content] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
      if (path.toLowerCase().includes(q)) names.push(path);
      if (lines.length >= 100) continue;
      content.split("\n").forEach((text, i) => {
        if (lines.length < 100 && text.length < 2000 && text.toLowerCase().includes(q)) lines.push({ path, line: i + 1, text: text.trim().slice(0, 120) });
      });
    }
    return { names, lines };
  }, [files, q]);
  return (
    <>
      <div className="px-2 pb-1.5">
        <label className="relative block">
          <span className="sr-only">Search files</span>
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-s-ink-3" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            placeholder="Search files"
            className="h-7 w-full rounded-lg border border-s-line bg-transparent pl-7 pr-2 text-[12.5px] outline-none placeholder:text-s-ink-3 focus:border-s-line-strong"
          />
        </label>
      </div>
      {results ? (
        <div className="s-scroll min-h-0 flex-1 overflow-y-auto px-1 pb-3 text-[12.5px]" aria-live="polite">
          {results.names.length === 0 && results.lines.length === 0 && <p className="px-3 py-2 text-s-ink-3">No matches.</p>}
          {results.names.length > 0 && (
            <ul className="mb-2">
              {results.names.map((p) => (
                <li key={p}>
                  <button type="button" onClick={() => onOpen(p)} className="flex w-full items-center gap-1.5 truncate rounded-lg px-2 py-1 text-left text-s-ink-2 hover:bg-s-hover">
                    <FileIcon className="h-3.5 w-3.5 shrink-0 text-s-ink-3" />
                    <span className="truncate">{p}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {results.lines.length > 0 && (
            <ul>
              {results.lines.map((m) => (
                <li key={`${m.path}:${m.line}`}>
                  <button type="button" onClick={() => onOpen(m.path)} className="block w-full rounded-lg px-2 py-1 text-left hover:bg-s-hover">
                    <span className="block truncate text-[11.5px] text-s-ink-3">
                      {m.path}:{m.line}
                    </span>
                    <span className="block truncate font-mono text-[11.5px] text-s-ink-2">{m.text}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        children
      )}
    </>
  );
}

function TreeList(p: {
  nodes: Node[];
  depth: number;
  active: string | null;
  dirty: Record<string, string>;
  collapsed: Set<string>;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
  onRename: (path: string) => void;
  onDelete: (path: string) => void;
}) {
  return (
    <ul>
      {p.nodes.map((n) =>
        n.children ? (
          <li key={n.path}>
            <button type="button" onClick={() => p.onToggle(n.path)} className="flex w-full items-center gap-1 rounded-lg py-1 pr-2 text-left text-[12.5px] text-s-ink-2 hover:bg-s-hover" style={{ paddingLeft: 8 + p.depth * 12 }} aria-expanded={!p.collapsed.has(n.path)}>
              {p.collapsed.has(n.path) ? <ChevronRight className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
              <Folder className="h-3.5 w-3.5 shrink-0 text-s-ink-3" />
              <span className="truncate">{n.name}</span>
            </button>
            {!p.collapsed.has(n.path) && <TreeList {...p} nodes={n.children} depth={p.depth + 1} />}
          </li>
        ) : (
          <li key={n.path} className="group relative">
            <button
              type="button"
              onClick={() => p.onOpen(n.path)}
              className={cn("flex w-full items-center gap-1.5 rounded-lg py-1 pr-14 text-left text-[12.5px]", p.active === n.path ? "bg-s-hover text-s-ink" : "text-s-ink-2 hover:bg-s-hover/60")}
              style={{ paddingLeft: 22 + p.depth * 12 }}
              aria-current={p.active === n.path ? "true" : undefined}
            >
              <FileIcon className="h-3.5 w-3.5 shrink-0 text-s-ink-3" />
              <span className="truncate">{n.name}</span>
              {n.path in p.dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-s-ink-3" title="Unsaved changes"><span className="sr-only">(unsaved)</span></span>}
            </button>
            <span className="absolute right-1 top-1/2 hidden -translate-y-1/2 gap-0.5 group-focus-within:flex group-hover:flex">
              <button type="button" onClick={() => p.onRename(n.path)} aria-label={`Rename ${n.path}`} className="grid h-6 w-6 place-items-center rounded text-s-ink-3 hover:text-s-ink">
                <Pencil className="h-3 w-3" />
              </button>
              <button type="button" onClick={() => p.onDelete(n.path)} aria-label={`Delete ${n.path}`} className="grid h-6 w-6 place-items-center rounded text-s-ink-3 hover:text-s-danger">
                <Trash2 className="h-3 w-3" />
              </button>
            </span>
          </li>
        ),
      )}
    </ul>
  );
}

/** A compact icon action in the top bar. */
function HeaderIcon({ label, pressed, onClick, className, children }: { label: string; pressed?: boolean; onClick: () => void; className?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      className={cn("grid h-8 w-8 place-items-center rounded-lg border transition-colors [&_svg]:h-4 [&_svg]:w-4", pressed ? "border-s-line-strong bg-s-hover text-s-ink" : "border-transparent text-s-ink-3 hover:bg-s-hover hover:text-s-ink", className)}
    >
      {children}
    </button>
  );
}

/** The project's name in the top bar, with a menu: rename, memory, Run command, and switching to another project. */
/** Start a download (the server names the file). */
function downloadFile(href: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = "";
  document.body.append(a);
  a.click();
  a.remove();
}

function ProjectMenu({
  name,
  projectId,
  unsaved,
  onRename,
  onDescribe,
  described,
  onRunCommand,
  onMemory,
}: {
  name: string;
  projectId: string;
  /** Edits not saved yet: the download has only saved files. */
  unsaved: boolean;
  onRename: () => void;
  onDescribe: () => void;
  described: boolean;
  onRunCommand: () => void;
  onMemory: () => void;
}) {
  const router = useRouter();
  const [others, setOthers] = useState<{ id: string; name: string }[] | null>(null);
  useEffect(() => {
    let alive = true;
    api<{ projects: { id: string; name: string }[] }>("/api/code/projects")
      .then((r) => alive && setOthers(r.projects.filter((p) => p.id !== projectId).slice(0, 6)))
      .catch(() => alive && setOthers([]));
    return () => {
      alive = false;
    };
  }, [projectId]);
  return (
    <Menu
      label="Project"
      align="start"
      width={260}
      buttonTitle="Project menu"
      buttonClassName="inline-flex min-w-0 max-w-full items-center gap-1 rounded-lg px-2 py-1 text-[14px] font-medium text-s-ink transition hover:bg-s-hover"
      button={
        <>
          <span className="truncate">{name}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-s-ink-3" aria-hidden />
        </>
      }
    >
      <MenuItem icon={<Pencil />} onClick={onRename}>
        Rename project…
      </MenuItem>
      <MenuItem icon={<FileText />} onClick={onDescribe}>
        {described ? "Edit description…" : "Add a description…"}
      </MenuItem>
      <MenuItem icon={<History />} hint="Every task in this project" onClick={() => router.push(`/history?tab=tasks&project=${projectId}`)}>
        Task history
      </MenuItem>
      <MenuItem icon={<BookMarked />} hint="Notes and workflows for the agent" onClick={onMemory}>
        Project memory
      </MenuItem>
      <MenuItem icon={<Settings2 />} onClick={onRunCommand}>
        Run command…
      </MenuItem>
      <MenuItem icon={<Download />} hint={unsaved ? "Saved files only: save your edits first" : "All its files, to open on your computer"} onClick={() => downloadFile(`/api/code/projects/${projectId}/download`)}>
        Download as .zip
      </MenuItem>
      <MenuSeparator />
      {others && others.length > 0 && <MenuLabel>Switch project</MenuLabel>}
      {others?.map((p) => (
        <MenuItem key={p.id} icon={<Code2 />} onClick={() => router.push(`/code/${p.id}`)}>
          {p.name}
        </MenuItem>
      ))}
      <MenuItem icon={<FolderOpen />} onClick={() => router.push("/code")}>
        All projects
      </MenuItem>
      <MenuItem icon={<FolderPlus />} onClick={() => router.push("/code?new=1")}>
        New project
      </MenuItem>
    </Menu>
  );
}
