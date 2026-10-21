"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, MessageSquarePlus, Pause, Play, Plus, Sparkles, Square, Trash2 } from "lucide-react";
import { useCatalog } from "@/components/common/model-picker";
import { Markdown } from "@/components/common/markdown";
import { CopyButton, Dots } from "@/components/council/response-card";
import { useApp } from "@/components/layout/app-context";
import { StudioHeader } from "@/components/studio/frame";
import { ProjectInstructions } from "./project-instructions";
import { ModelSelector } from "@/components/studio/model-selector";
import { jsonFetch, postNdjson } from "@/hooks/use-ndjson";
import { TASK_STATUSES, type TaskStatus } from "@/lib/missions/schema";
import { cn, relativeTime } from "@/lib/utils";
import { MISSION_LABEL, StatusPill, TASK_LABEL, progressOf } from "./mission-bits";

interface Mission {
  id: string;
  name: string;
  description: string | null;
  goal: string | null;
  status: "active" | "paused" | "completed" | "archived";
  created_at: string;
}
interface Task {
  id: string;
  title: string;
  description: string;
  milestone: string | null;
  status: TaskStatus;
  priority: "low" | "medium" | "high";
  ai_suitable: boolean;
  output: string | null;
  output_model: string | null;
  completed_at: string | null;
  updated_at: string;
}
interface Run {
  id: string;
  task_id: string;
  model_id: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  error: string | null;
  started_at: string;
}
interface Note {
  id: string;
  title: string;
  content: string;
  created_at: string;
}
interface Data {
  mission: Mission;
  tasks: Task[];
  runs: Run[];
  notes: Note[];
  conversations: { id: string; title: string; updated_at: string }[];
}
type Live = { text: string; status: "running" | "error"; error?: string };

export function MissionView({ id }: { id: string }) {
  const { user } = useApp();
  const router = useRouter();
  const catalog = useCatalog();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modelId, setModelId] = useState("auto");
  const [open, setOpen] = useState<string | null>(null);
  const [live, setLive] = useState<Record<string, Live>>({});
  const aborts = useRef<Record<string, AbortController>>({});
  const [version, setVersion] = useState(0);
  const reload = () => setVersion((v) => v + 1);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    jsonFetch<Data>(`/api/missions/${id}`)
      .then((d) => alive && setData(d))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [id, user, version]);

  const groups = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of data?.tasks ?? []) {
      const k = t.milestone ?? "Tasks";
      map.set(k, [...(map.get(k) ?? []), t]);
    }
    return [...map.entries()];
  }, [data]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { pending: 0, in_progress: 0, completed: 0, blocked: 0, cancelled: 0 };
    for (const t of data?.tasks ?? []) c[t.status] = (c[t.status] ?? 0) + 1;
    return c;
  }, [data]);
  const progress = progressOf(counts);

  const setTask = (t: Task) => setData((d) => d && { ...d, tasks: d.tasks.map((x) => (x.id === t.id ? t : x)) });

  const patchTask = async (taskId: string, patch: Record<string, unknown>) => {
    try {
      const r = await jsonFetch<{ task: Task }>(`/api/missions/tasks/${taskId}`, { method: "PATCH", body: JSON.stringify(patch) });
      setTask(r.task);
      return true;
    } catch (e) {
      setNotice((e as Error).message);
      return false;
    }
  };

  const runTask = async (task: Task, instruction?: string) => {
    const ac = new AbortController();
    aborts.current[task.id] = ac;
    setOpen(task.id);
    setLive((l) => ({ ...l, [task.id]: { text: "", status: "running" } }));
    let text = "";
    try {
      for await (const ev of postNdjson<{ type: string; text?: string; task?: Task; message?: string }>(`/api/missions/tasks/${task.id}/run`, { modelId, instruction }, ac.signal)) {
        if (ev.type === "delta" && ev.text) {
          text += ev.text;
          setLive((l) => ({ ...l, [task.id]: { text, status: "running" } }));
        } else if (ev.type === "done" && ev.task) {
          setTask(ev.task);
          setLive((l) => {
            const n = { ...l };
            delete n[task.id];
            return n;
          });
        } else if (ev.type === "error") throw new Error(ev.message);
      }
    } catch (e) {
      const cancelled = (e as Error).name === "AbortError";
      setLive((l) => ({ ...l, [task.id]: { text, status: "error", error: cancelled ? "Cancelled. Nothing was saved to the task." : (e as Error).message } }));
    } finally {
      delete aborts.current[task.id];
      reload();
    }
  };

  const setMissionStatus = async (status: Mission["status"]) => {
    try {
      const r = await jsonFetch<{ mission: Mission }>(`/api/missions/${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
      setData((d) => d && { ...d, mission: r.mission });
    } catch (e) {
      setNotice((e as Error).message);
    }
  };

  const removeMission = async () => {
    if (!confirm("Delete this mission, its tasks, drafts, notes and history? This can't be undone.")) return;
    try {
      await jsonFetch(`/api/missions/${id}`, { method: "DELETE" });
      router.push("/missions");
    } catch (e) {
      setNotice((e as Error).message);
    }
  };

  if (!user) {
    return (
      <div className="grid flex-1 place-items-center text-[14px] text-s-ink-2">
        <Link href={`/login?next=/missions/${id}`} className="underline">
          Sign in to open this mission
        </Link>
      </div>
    );
  }

  const m = data?.mission;
  const paused = m?.status === "paused" || m?.status === "archived";
  const taskTitle = (taskId: string) => data?.tasks.find((t) => t.id === taskId)?.title ?? "Deleted task";
  const modelName = (mid: string | null) => (mid ? (catalog?.models.find((x) => x.id === mid)?.displayName ?? mid) : "");

  return (
    <>
      <StudioHeader>
        <Link href="/missions" className="inline-flex items-center gap-1.5 text-[14px] text-s-ink-2 hover:text-s-ink">
          <ArrowLeft className="h-4 w-4" /> Missions
        </Link>
      </StudioHeader>
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1120px] px-4 pb-24 pt-2 sm:px-8">
          {error && <p className="mt-10 text-center text-[14px] text-s-danger">{error}</p>}
          {!data && !error && <div className="s-skeleton mt-4 h-40 rounded-[22px]" />}
          {m && data && (
            <>
              <div className="s-in flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <StatusPill status={m.status} />
                    <span className="text-[12px] text-s-ink-3">Created {new Date(m.created_at).toLocaleDateString()}</span>
                  </div>
                  <h1 className="mt-2 font-serif text-[clamp(30px,4.5vw,42px)] leading-[1.08]">{m.name}</h1>
                  {m.goal && <p className="mt-2 max-w-3xl text-[15px] text-s-ink-2">{m.goal}</p>}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/chat?project=${id}`} className="inline-flex h-9 items-center gap-1.5 rounded-full bg-s-accent px-3.5 text-[13px] font-medium text-s-accent-ink transition hover:brightness-110">
                    <MessageSquarePlus className="h-3.5 w-3.5" /> New chat in this project
                  </Link>
                  {m.status === "paused" ? (
                    <button type="button" onClick={() => void setMissionStatus("active")} className="inline-flex h-9 items-center gap-1.5 rounded-full border border-s-line-strong px-3.5 text-[13px] transition hover:bg-s-hover">
                      <Play className="h-3.5 w-3.5" /> Resume
                    </button>
                  ) : m.status === "active" ? (
                    <button type="button" onClick={() => void setMissionStatus("paused")} className="inline-flex h-9 items-center gap-1.5 rounded-full border border-s-line-strong px-3.5 text-[13px] transition hover:bg-s-hover">
                      <Pause className="h-3.5 w-3.5" /> Pause
                    </button>
                  ) : null}
                  <span className="relative">
                    <select
                      value={m.status}
                      onChange={(e) => void setMissionStatus(e.target.value as Mission["status"])}
                      aria-label="Mission status"
                      className="h-9 appearance-none rounded-full border border-s-line bg-transparent pl-3.5 pr-8 text-[13px] text-s-ink-2 outline-none"
                    >
                      {Object.entries(MISSION_LABEL).map(([k, v]) => (
                        <option key={k} value={k} className="bg-s-bg">
                          {v}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-s-ink-3" />
                  </span>
                  <button type="button" onClick={() => void removeMission()} aria-label="Delete mission" className="grid h-9 w-9 place-items-center rounded-full text-s-ink-3 transition hover:bg-s-hover hover:text-s-danger">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>

              <div className="glass s-in mt-6 flex flex-wrap items-center gap-4 rounded-[22px] px-5 py-4 [animation-delay:60ms]">
                <div className="min-w-[200px] flex-1">
                  <div className="flex justify-between text-[12.5px] text-s-ink-3">
                    <span>Progress</span>
                    <span>
                      {progress.done}/{progress.total} done · {progress.pct}%
                    </span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-s-hover" role="progressbar" aria-valuenow={progress.pct} aria-valuemin={0} aria-valuemax={100} aria-label="Mission progress">
                    <div className="h-full rounded-full bg-s-ink-2 transition-[width] duration-700" style={{ width: `${progress.pct}%` }} />
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5 text-[12px]">
                  {(["in_progress", "blocked", "pending"] as const).map((s) => (counts[s] ? <StatusPill key={s} status={s} /> : null))}
                </div>
                <div className="flex items-center gap-2 text-[12.5px] text-s-ink-3">
                  AI model for tasks
                  <ModelSelector models={catalog?.models ?? null} value={modelId} onChange={setModelId} auto={catalog?.auto ?? null} />
                </div>
              </div>

              {paused && <p className="mt-4 rounded-xl border border-s-line px-3.5 py-2.5 text-[13px] text-s-ink-2">This mission is {m.status}. Resume it to run AI tasks; you can still edit tasks and notes.</p>}
              {notice && (
                <p role="alert" className="mt-4 rounded-xl border border-s-line px-3.5 py-2.5 text-[13px] text-s-danger">
                  {notice}
                </p>
              )}

              <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
                <div className="space-y-7">
                  {groups.length === 0 && <p className="text-[14px] text-s-ink-3">No tasks yet. Add the first one below.</p>}
                  {groups.map(([milestone, tasks]) => (
                    <section key={milestone}>
                      <h2 className="mb-2 flex items-center justify-between text-[12.5px] font-medium uppercase tracking-[0.1em] text-s-ink-3">
                        {milestone}
                        <span className="normal-case tracking-normal">
                          {tasks.filter((t) => t.status === "completed").length}/{tasks.filter((t) => t.status !== "cancelled").length}
                        </span>
                      </h2>
                      <ul className="divide-y divide-s-line overflow-hidden rounded-[20px] border border-s-line">
                        {tasks.map((t) => (
                          <TaskRow
                            key={t.id}
                            task={t}
                            open={open === t.id}
                            onToggle={() => setOpen(open === t.id ? null : t.id)}
                            live={live[t.id]}
                            canRun={!paused}
                            outputModel={modelName(t.output_model)}
                            onPatch={(p) => patchTask(t.id, p)}
                            onRun={(instr) => void runTask(t, instr)}
                            onCancel={() => aborts.current[t.id]?.abort()}
                            onDelete={async () => {
                              try {
                                await jsonFetch(`/api/missions/tasks/${t.id}`, { method: "DELETE" });
                                setData((d) => d && { ...d, tasks: d.tasks.filter((x) => x.id !== t.id) });
                              } catch (e) {
                                setNotice((e as Error).message);
                              }
                            }}
                            onSaveNote={async () => {
                              try {
                                await jsonFetch(`/api/projects/${id}/notes`, { method: "POST", body: JSON.stringify({ title: t.title, content: t.output ?? "", sourceType: "note" }) });
                                reload();
                              } catch (e) {
                                setNotice((e as Error).message);
                              }
                            }}
                          />
                        ))}
                      </ul>
                    </section>
                  ))}
                  <AddTask milestones={groups.map(([g]) => g)} missionId={id} onAdded={reload} onError={setNotice} />
                </div>

                <aside className="space-y-6">
                  <ProjectInstructions projectId={id} initial={m.description ?? ""} noteCount={data.notes.length} onSaved={(description) => setData((d) => d && { ...d, mission: { ...d.mission, description } })} />
                  <section>
                    <h2 className="mb-2 flex items-center justify-between text-[12.5px] font-medium uppercase tracking-[0.1em] text-s-ink-3">
                      Conversations
                      <Link href={`/chat?project=${id}`} className="inline-flex items-center gap-1 normal-case tracking-normal text-s-ink-2 hover:text-s-ink">
                        <Plus className="h-3.5 w-3.5" /> New
                      </Link>
                    </h2>
                    {data.conversations.length === 0 ? (
                      <p className="text-[13px] text-s-ink-3">No chats yet. Start one here, or move a chat in from its ⋯ menu in the sidebar.</p>
                    ) : (
                      <ul className="space-y-1">
                        {data.conversations.map((c) => (
                          <li key={c.id}>
                            <Link href={`/chat?c=${c.id}`} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13.5px] text-s-ink-2 hover:bg-s-hover hover:text-s-ink">
                              <span className="min-w-0 flex-1 truncate">{c.title}</span>
                              <time dateTime={c.updated_at} title={new Date(c.updated_at).toLocaleString()} className="shrink-0 text-[11.5px] text-s-ink-3" suppressHydrationWarning>
                                {relativeTime(c.updated_at)}
                              </time>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                  <Notes missionId={id} notes={data.notes} onChanged={reload} onError={setNotice} />
                  <section>
                    <h2 className="mb-2 text-[12.5px] font-medium uppercase tracking-[0.1em] text-s-ink-3">History</h2>
                    {data.runs.length === 0 && !data.tasks.some((t) => t.completed_at) ? (
                      <p className="text-[13px] text-s-ink-3">Task runs and completions will appear here.</p>
                    ) : (
                      <ol className="space-y-2.5 text-[12.5px]">
                        {[
                          ...data.runs.map((r) => ({ at: r.started_at, key: r.id, text: `AI ${r.status === "succeeded" ? "drafted" : r.status === "running" ? "is drafting" : r.status === "cancelled" ? "run cancelled for" : "failed on"} “${taskTitle(r.task_id)}”`, sub: `${modelName(r.model_id)}${r.error ? ` · ${r.error}` : ""}`, tone: r.status })),
                          ...data.tasks.filter((t) => t.completed_at).map((t) => ({ at: t.completed_at!, key: `c-${t.id}`, text: `Marked “${t.title}” done`, sub: "", tone: "done" })),
                        ]
                          .sort((a, b) => b.at.localeCompare(a.at))
                          .slice(0, 30)
                          .map((e) => (
                            <li key={e.key} className="flex gap-2.5">
                              <span className={cn("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", e.tone === "failed" ? "bg-s-danger" : e.tone === "cancelled" ? "bg-s-ink-3" : "bg-s-ink-2")} />
                              <div className="min-w-0">
                                <div className="text-s-ink-2">{e.text}</div>
                                <div className="text-[11.5px] text-s-ink-3">
                                  {new Date(e.at).toLocaleString()}
                                  {e.sub ? ` · ${e.sub}` : ""}
                                </div>
                              </div>
                            </li>
                          ))}
                      </ol>
                    )}
                  </section>
                </aside>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function TaskRow({
  task: t,
  open,
  onToggle,
  live,
  canRun,
  outputModel,
  onPatch,
  onRun,
  onCancel,
  onDelete,
  onSaveNote,
}: {
  task: Task;
  open: boolean;
  onToggle: () => void;
  live?: Live;
  canRun: boolean;
  outputModel: string;
  onPatch: (p: Record<string, unknown>) => Promise<boolean>;
  onRun: (instruction?: string) => void;
  onCancel: () => void;
  onDelete: () => void;
  onSaveNote: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(t.title);
  const [desc, setDesc] = useState(t.description);
  const [instr, setInstr] = useState("");
  const [draftEdit, setDraftEdit] = useState<string | null>(null);
  const running = live?.status === "running";

  return (
    <li className={cn("transition-colors", open && "bg-s-hover/40")}>
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          role="checkbox"
          aria-checked={t.status === "completed"}
          aria-label={t.status === "completed" ? "Mark not done" : "Mark done"}
          onClick={() => void onPatch({ status: t.status === "completed" ? "in_progress" : "completed" })}
          className={cn(
            "grid h-5 w-5 shrink-0 place-items-center rounded-full border transition",
            t.status === "completed" ? "border-transparent bg-s-ink text-s-bg" : "border-s-line-strong hover:border-s-ink-2",
          )}
        >
          {t.status === "completed" && <span className="text-[11px]">✓</span>}
        </button>
        <button type="button" onClick={onToggle} aria-expanded={open} className="min-w-0 flex-1 text-left">
          <div className={cn("truncate text-[14.5px]", t.status === "completed" && "text-s-ink-3 line-through decoration-s-line-strong", t.status === "cancelled" && "text-s-ink-3")}>{t.title}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-s-ink-3">
            <span className={cn(t.priority === "high" && "text-s-ink-2")}>{t.priority} priority</span>
            {t.ai_suitable && <span>· AI can draft</span>}
            {t.output && <span>· draft attached</span>}
          </div>
        </button>
        {running ? <Dots /> : <StatusPill status={t.status} />}
      </div>
      {open && (
        <div className="space-y-3 px-4 pb-4 pl-12">
          {editing ? (
            <div className="space-y-2">
              <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Task title" className="h-9 w-full rounded-lg border border-s-line-strong bg-transparent px-3 text-[14px] outline-none" />
              <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={3} aria-label="Task description" className="w-full rounded-lg border border-s-line-strong bg-transparent px-3 py-2 text-[13.5px] outline-none" />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    if (await onPatch({ title, description: desc })) setEditing(false);
                  }}
                  className="h-8 rounded-lg bg-s-accent px-3 text-[12.5px] font-medium text-s-accent-ink"
                >
                  Save
                </button>
                <button type="button" onClick={() => setEditing(false)} className="h-8 rounded-lg px-3 text-[12.5px] text-s-ink-2 hover:bg-s-hover">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            t.description && <p className="text-[13.5px] leading-relaxed text-s-ink-2">{t.description}</p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <span className="relative">
              <select
                value={t.status}
                onChange={(e) => void onPatch({ status: e.target.value })}
                aria-label="Task status"
                className="h-8 appearance-none rounded-lg border border-s-line bg-transparent pl-2.5 pr-7 text-[12.5px] text-s-ink-2 outline-none"
              >
                {TASK_STATUSES.map((s) => (
                  <option key={s} value={s} className="bg-s-bg">
                    {TASK_LABEL[s]}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-s-ink-3" />
            </span>
            {running ? (
              <button type="button" onClick={onCancel} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-s-ink px-3 text-[12.5px] text-s-bg">
                <Square className="h-3 w-3 fill-current" /> Cancel
              </button>
            ) : (
              <button
                type="button"
                disabled={!canRun || t.status === "cancelled"}
                onClick={() => onRun(instr.trim() || undefined)}
                title={canRun ? "Ask AI to draft this task" : "Resume the mission to run tasks"}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-s-line-strong px-3 text-[12.5px] transition hover:bg-s-hover disabled:opacity-40"
              >
                <Sparkles className="h-3.5 w-3.5" /> {t.output ? "Redraft with AI" : "Draft with AI"}
              </button>
            )}
            <input
              value={instr}
              onChange={(e) => setInstr(e.target.value)}
              placeholder="Optional instruction…"
              aria-label="Instruction for the AI"
              className="h-8 min-w-[160px] flex-1 rounded-lg border border-s-line bg-transparent px-2.5 text-[12.5px] outline-none placeholder:text-s-ink-3"
            />
            <button type="button" onClick={() => setEditing((v) => !v)} className="h-8 rounded-lg px-2.5 text-[12.5px] text-s-ink-2 hover:bg-s-hover">
              Edit
            </button>
            <button type="button" onClick={onDelete} aria-label="Delete task" className="grid h-8 w-8 place-items-center rounded-lg text-s-ink-3 hover:bg-s-hover hover:text-s-danger">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>

          {live && (
            <div className="rounded-2xl border border-s-line p-4">
              {live.status === "error" && <p className="mb-2 text-[13px] text-s-danger">{live.error}</p>}
              {live.text ? <Markdown text={live.text} className="s-prose text-[14px]" /> : live.status === "running" ? <p className="text-[13px] text-s-ink-3">Drafting…</p> : null}
              {live.status === "error" && (
                <button type="button" onClick={() => onRun(instr.trim() || undefined)} className="mt-2 text-[12.5px] text-s-ink-2 underline">
                  Retry
                </button>
              )}
            </div>
          )}

          {!live && t.output && (
            <div className="rounded-2xl border border-s-line p-4">
              <div className="mb-2 flex items-center justify-between gap-2 text-[11.5px] text-s-ink-3">
                <span>AI draft{outputModel ? ` · ${outputModel}` : ""} · review before marking done</span>
                <span className="flex items-center gap-1">
                  <CopyButton text={t.output} />
                  <button type="button" onClick={() => setDraftEdit(draftEdit === null ? t.output : null)} className="h-8 rounded-lg px-2 hover:bg-s-hover hover:text-s-ink">
                    {draftEdit === null ? "Edit" : "Close"}
                  </button>
                  <button type="button" onClick={onSaveNote} className="h-8 rounded-lg px-2 hover:bg-s-hover hover:text-s-ink">
                    Save to notes
                  </button>
                </span>
              </div>
              {draftEdit !== null ? (
                <div className="space-y-2">
                  <textarea value={draftEdit} onChange={(e) => setDraftEdit(e.target.value)} rows={10} aria-label="Edit draft" className="s-scroll w-full rounded-lg border border-s-line-strong bg-transparent px-3 py-2 font-mono text-[12.5px] outline-none" />
                  <button
                    type="button"
                    onClick={async () => {
                      if (await onPatch({ output: draftEdit })) setDraftEdit(null);
                    }}
                    className="h-8 rounded-lg bg-s-accent px-3 text-[12.5px] font-medium text-s-accent-ink"
                  >
                    Save draft
                  </button>
                </div>
              ) : (
                <Markdown text={t.output} className="s-prose text-[14px]" />
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function AddTask({ milestones, missionId, onAdded, onError }: { milestones: string[]; missionId: string; onAdded: () => void; onError: (m: string) => void }) {
  const [title, setTitle] = useState("");
  const [milestone, setMilestone] = useState(milestones[0] ?? "");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex flex-wrap items-center gap-2 rounded-[20px] border border-dashed border-s-line-strong px-3 py-2.5"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!title.trim()) return;
        setBusy(true);
        try {
          await jsonFetch(`/api/missions/${missionId}/tasks`, { method: "POST", body: JSON.stringify({ title, milestone: milestone.trim() || null, priority: "medium", aiSuitable: false, description: "" }) });
          setTitle("");
          onAdded();
        } catch (err) {
          onError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Plus className="h-4 w-4 text-s-ink-3" />
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a task…" aria-label="New task title" className="min-w-[160px] flex-1 bg-transparent text-[14px] outline-none placeholder:text-s-ink-3" />
      <input list="milestones" value={milestone} onChange={(e) => setMilestone(e.target.value)} placeholder="Milestone" aria-label="Milestone" className="h-8 w-40 rounded-lg border border-s-line bg-transparent px-2.5 text-[12.5px] outline-none" />
      <datalist id="milestones">
        {milestones.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      <button type="submit" disabled={busy || !title.trim()} className="h-8 rounded-lg bg-s-accent px-3 text-[12.5px] font-medium text-s-accent-ink disabled:opacity-40">
        Add
      </button>
    </form>
  );
}

function Notes({ missionId, notes, onChanged, onError }: { missionId: string; notes: Note[]; onChanged: () => void; onError: (m: string) => void }) {
  const [text, setText] = useState("");
  return (
    <section>
      <h2 className="mb-2 text-[12.5px] font-medium uppercase tracking-[0.1em] text-s-ink-3">Notes</h2>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!text.trim()) return;
          try {
            await jsonFetch(`/api/projects/${missionId}/notes`, { method: "POST", body: JSON.stringify({ title: text.trim().split("\n")[0]!.slice(0, 120), content: text.trim(), sourceType: "note" }) });
            setText("");
            onChanged();
          } catch (err) {
            onError((err as Error).message);
          }
        }}
      >
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="Add a note or decision…" aria-label="New note" className="glass w-full rounded-2xl px-3 py-2 text-[13.5px] outline-none placeholder:text-s-ink-3" />
        {text.trim() && (
          <button type="submit" className="mt-1.5 h-8 rounded-lg bg-s-accent px-3 text-[12.5px] font-medium text-s-accent-ink">
            Save note
          </button>
        )}
      </form>
      <ul className="mt-3 space-y-2">
        {notes.map((n) => (
          <li key={n.id} className="group rounded-xl border border-s-line px-3 py-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 text-[13px] font-medium">{n.title}</div>
              <button
                type="button"
                aria-label="Delete note"
                onClick={async () => {
                  try {
                    await jsonFetch(`/api/notes/${n.id}`, { method: "DELETE" });
                    onChanged();
                  } catch (err) {
                    onError((err as Error).message);
                  }
                }}
                className="text-s-ink-3 opacity-0 transition hover:text-s-danger group-hover:opacity-100"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            {n.content !== n.title && <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-[12.5px] text-s-ink-3">{n.content}</p>}
            <div className="mt-1 text-[11px] text-s-ink-3">{new Date(n.created_at).toLocaleString()}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}
