"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CircleCheck, CircleDashed, CircleX, Clock3, History, Loader2, MoreHorizontal, RefreshCw, Search, ShieldCheck, Square, Trash2 } from "lucide-react";
import { jsonFetch } from "@/hooks/use-ndjson";
import { TASK_FILTER_LABEL, TASK_FILTERS, TASK_SORT_LABEL, TASK_SORTS, type TaskFilter, type TaskSort, type TaskSummary } from "@/lib/code/agent/history";
import type { TaskState } from "@/lib/code/agent/types";
import { TASK_STATE_INFO } from "@/lib/code/agent/verdict";
import { ago } from "@/lib/home";
import { cn } from "@/lib/utils";
import { Menu, MenuItem } from "./ui";

/** Each state with an icon and its name in words, so nothing relies on colour. */
const STATE_ICON: Record<TaskState, { icon: typeof ShieldCheck; tone: string }> = {
  verified: { icon: ShieldCheck, tone: "text-emerald-600 dark:text-emerald-400" },
  checked: { icon: CircleCheck, tone: "text-s-ink" },
  warnings: { icon: AlertTriangle, tone: "text-amber-600 dark:text-amber-400" },
  unverified: { icon: CircleDashed, tone: "text-s-ink-2" },
  failed: { icon: CircleX, tone: "text-s-danger" },
  cancelled: { icon: Square, tone: "text-s-ink-2" },
  queued: { icon: Clock3, tone: "text-s-ink-2" },
  running: { icon: Loader2, tone: "text-s-ink-2" },
  waiting: { icon: Clock3, tone: "text-amber-600 dark:text-amber-400" },
  verifying: { icon: Loader2, tone: "text-s-ink-2" },
};

const usd = (n: number) => (n < 0.01 ? "under $0.01" : `$${n.toFixed(2)}`);

/** Where a task's buttons go: its record in the project, or a new task there that continues it. */
export function taskLinks(t: Pick<TaskSummary, "id" | "projectId" | "continuation">): { open: string; next: string } {
  return { open: `/code/${t.projectId}?run=${t.id}`, next: t.continuation.kind === "resume" ? `/code/${t.projectId}?run=${t.id}` : `/code/${t.projectId}?continue=${t.id}` };
}

type Page = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; tasks: TaskSummary[]; nextOffset: number | null; loadingMore?: boolean };

/**
 * The coding tasks the user has run, across their projects: what was asked, where, when, how it ended
 * (in words), the model and what it changed — with Resume for an open task, Continue for a finished one,
 * and deleting a finished task's record. Everything comes from the server, which only returns the
 * signed-in user's tasks.
 */
export function TaskHistory({ initialProject = null }: { initialProject?: string | null }) {
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [sort, setSort] = useState<TaskSort>("activity");
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");
  const [project, setProject] = useState<string | null>(initialProject);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [page, setPage] = useState<Page>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const seq = useRef(0);

  // Search as you type, a moment after typing stops.
  useEffect(() => {
    const t = setTimeout(() => setQ(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    let alive = true;
    jsonFetch<{ projects: { id: string; name: string }[] }>("/api/code/projects")
      .then((r) => alive && setProjects(r.projects))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const params = useMemo(() => {
    const p = new URLSearchParams({ filter, sort });
    if (q) p.set("q", q);
    if (project) p.set("project", project);
    return p.toString();
  }, [filter, sort, q, project]);

  useEffect(() => {
    const me = ++seq.current;
    const t = setTimeout(() => {
      setPage({ status: "loading" });
      jsonFetch<{ tasks: TaskSummary[]; nextOffset: number | null }>(`/api/code/tasks?${params}`)
        .then((r) => me === seq.current && setPage({ status: "ready", tasks: r.tasks, nextOffset: r.nextOffset }))
        .catch((e: Error) => me === seq.current && setPage({ status: "error", message: e.message }));
    }, 0);
    return () => clearTimeout(t);
  }, [params, attempt]);

  const loadMore = async () => {
    if (page.status !== "ready" || page.nextOffset === null) return;
    const me = seq.current;
    setPage({ ...page, loadingMore: true });
    try {
      const r = await jsonFetch<{ tasks: TaskSummary[]; nextOffset: number | null }>(`/api/code/tasks?${params}&offset=${page.nextOffset}`);
      if (me !== seq.current) return;
      const seen = new Set(page.tasks.map((t) => t.id));
      setPage({ status: "ready", tasks: [...page.tasks, ...r.tasks.filter((t) => !seen.has(t.id))], nextOffset: r.nextOffset });
    } catch (e) {
      if (me === seq.current) setPage({ ...page, loadingMore: false });
      setNotice(`More tasks couldn't load: ${(e as Error).message}`);
    }
  };

  const remove = async (t: TaskSummary) => {
    const ok = confirm(
      `Delete the record of “${t.title}”?\n\nIts activity log, change history and checkpoints are removed for good. The project's files stay as they are now, so this task's changes can no longer be undone from Orbis.`,
    );
    if (!ok) return;
    setNotice(null);
    try {
      await jsonFetch(`/api/code/agent/${t.id}`, { method: "DELETE" });
      setPage((p) => (p.status === "ready" ? { ...p, tasks: p.tasks.filter((x) => x.id !== t.id) } : p));
      setNotice(`Deleted the record of “${t.title}”.`);
    } catch (e) {
      setNotice(`Couldn't delete it: ${(e as Error).message}`);
    }
  };

  const filtered = filter !== "all" || !!q || !!project;
  const select = "h-9 rounded-xl border border-s-line bg-transparent px-2.5 text-[13px] text-s-ink-2 outline-none focus:border-s-line-strong";

  return (
    <div>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-s-ink-3" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search requests and summaries"
            aria-label="Search tasks"
            className="h-9 w-full rounded-xl border border-s-line bg-transparent pl-9 pr-3 text-[13.5px] outline-none transition placeholder:text-s-ink-3 focus:border-s-line-strong"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <label className="sr-only" htmlFor="task-filter">
            Outcome
          </label>
          <select id="task-filter" value={filter} onChange={(e) => setFilter(e.target.value as TaskFilter)} className={select}>
            {TASK_FILTERS.map((f) => (
              <option key={f} value={f}>
                {f === "all" ? "Any outcome" : TASK_FILTER_LABEL[f]}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor="task-project">
            Project
          </label>
          <select id="task-project" value={project ?? ""} onChange={(e) => setProject(e.target.value || null)} className={cn(select, "max-w-[200px] truncate")}>
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            {project && !projects.some((p) => p.id === project) && <option value={project}>This project</option>}
          </select>
          <label className="sr-only" htmlFor="task-sort">
            Sort
          </label>
          <select id="task-sort" value={sort} onChange={(e) => setSort(e.target.value as TaskSort)} className={select}>
            {TASK_SORTS.map((s) => (
              <option key={s} value={s}>
                {TASK_SORT_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {notice && (
        <p role="status" className="mt-3 rounded-xl border border-s-line px-3 py-2 text-[13px] text-s-ink-2">
          {notice}
        </p>
      )}

      <div className="mt-4" aria-live="polite">
        {page.status === "loading" ? (
          <div className="space-y-3 py-2" role="status" aria-label="Loading tasks">
            {[78, 62, 70].map((w, i) => (
              <div key={i} className="s-skeleton h-14 rounded-2xl" style={{ width: `${w}%` }} />
            ))}
          </div>
        ) : page.status === "error" ? (
          <div role="alert" className="flex flex-wrap items-center gap-3 rounded-2xl border border-s-line px-4 py-3 text-[13.5px] text-s-ink-2">
            <span>Tasks couldn&apos;t load: {page.message}</span>
            <button
              type="button"
              onClick={() => setAttempt((n) => n + 1)}
              className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-s-line-strong px-3 py-1 text-[12.5px] text-s-ink hover:bg-s-hover [&_svg]:h-3.5 [&_svg]:w-3.5"
            >
              <RefreshCw /> Try again
            </button>
          </div>
        ) : page.tasks.length === 0 ? (
          filtered ? (
            <p className="px-1 py-6 text-[14px] text-s-ink-3">No tasks match. Try another outcome or project, or clear the search.</p>
          ) : (
            <div className="rounded-2xl border border-dashed border-s-line-strong px-5 py-6 text-[14px] text-s-ink-3">
              <p className="text-[14.5px] font-medium text-s-ink">No coding tasks yet</p>
              <p className="mt-1 leading-relaxed">
                Each request you give the coding agent is kept here with its project, how it ended, what it changed and the model that did it, so you can find it, review it and carry on.
              </p>
              <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[13.5px]">
                <Link href="/code" className="text-s-ink underline underline-offset-4">
                  Start a coding task
                </Link>
                <Link href="/code?start=example" className="text-s-ink-2 underline underline-offset-4 hover:text-s-ink">
                  Try the example project
                </Link>
              </p>
            </div>
          )
        ) : (
          <>
            <ul className="flex flex-col gap-2">
              {page.tasks.map((t) => (
                <TaskRow key={t.id} task={t} onDelete={() => void remove(t)} />
              ))}
            </ul>
            {page.nextOffset !== null && (
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={page.loadingMore}
                className="mt-3 inline-flex h-9 items-center gap-1.5 rounded-full border border-s-line px-4 text-[13px] text-s-ink-2 hover:border-s-line-strong hover:text-s-ink disabled:opacity-50"
              >
                {page.loadingMore ? "Loading…" : "Show more"}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function TaskRow({ task: t, onDelete }: { task: TaskSummary; onDelete: () => void }) {
  const info = TASK_STATE_INFO[t.state];
  const style = STATE_ICON[t.state];
  const links = taskLinks(t);
  const ended = t.continuation.kind === "follow_up";
  const meta = [
    t.models.length ? t.models.join(", ") : null,
    t.filesChanged ? `${t.filesChanged} file${t.filesChanged === 1 ? "" : "s"} changed` : "no files changed",
    t.costUsd !== null ? usd(t.costUsd) : null,
  ].filter(Boolean);
  return (
    <li className="rounded-2xl border border-s-line p-3.5 transition hover:border-s-line-strong">
      <div className="flex items-start gap-3">
        <style.icon className={cn("mt-0.5 h-4 w-4 shrink-0", style.tone, (t.state === "running" || t.state === "verifying") && "animate-spin")} aria-hidden />
        <div className="min-w-0 flex-1">
          <Link href={links.open} className="block text-[14.5px] font-medium leading-snug text-s-ink hover:underline">
            {t.title}
          </Link>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12.5px] text-s-ink-3">
            <span className={cn("font-medium", style.tone)}>{info.label}</span>
            <span aria-hidden>·</span>
            <span className="max-w-[220px] truncate" title={`Project: ${t.projectName}`}>
              {t.projectName}
            </span>
            <span aria-hidden>·</span>
            <time dateTime={t.updatedAt} title={`Last activity ${new Date(t.updatedAt).toLocaleString()} · started ${new Date(t.createdAt).toLocaleString()}`} suppressHydrationWarning>
              {ago(t.updatedAt)}
            </time>
          </p>
          {t.state === "failed" && t.error ? (
            <p className="mt-1 line-clamp-2 text-[13px] text-s-danger">{t.error}</p>
          ) : t.summary ? (
            <p className="mt-1 line-clamp-2 text-[13px] text-s-ink-2">
              <span className="text-s-ink-3">Agent&apos;s summary: </span>
              {t.summary}
            </p>
          ) : null}
          <p className="mt-1 text-[12px] text-s-ink-3">{meta.join(" · ")}</p>
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2 pl-7">
        <Link
          href={links.next}
          title={t.continuation.explain}
          className="inline-flex h-8 items-center gap-1.5 rounded-full bg-s-accent px-3.5 text-[12.5px] font-medium text-s-accent-ink transition hover:brightness-110"
        >
          <History className="h-3.5 w-3.5" aria-hidden /> {t.continuation.label}
        </Link>
        <Link href={links.open} className="inline-flex h-8 items-center rounded-full border border-s-line px-3 text-[12.5px] text-s-ink-2 hover:border-s-line-strong hover:text-s-ink">
          {ended ? "Open the record" : "Open"}
        </Link>
        <span className="hidden text-[12px] text-s-ink-3 md:inline">{ended ? "Continue starts a new task with this one's record." : "Resume picks up where it stopped."}</span>
        {ended && (
          <span className="ml-auto">
            <Menu
              label="Task"
              align="end"
              width={230}
              buttonLabel={`More for ${t.title}`}
              buttonClassName="grid h-8 w-8 place-items-center rounded-full text-s-ink-3 hover:bg-s-hover hover:text-s-ink"
              button={<MoreHorizontal className="h-4 w-4" />}
            >
              <MenuItem icon={<Trash2 />} hint="Files stay as they are" onClick={onDelete}>
                Delete task record…
              </MenuItem>
            </Menu>
          </span>
        )}
      </div>
    </li>
  );
}
