"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Code2, Flag, Globe, History, Plus, RefreshCw, Search } from "lucide-react";
import { useApp } from "@/components/layout/app-context";
import { jsonFetch } from "@/hooks/use-ndjson";
import type { TaskSummary } from "@/lib/code/agent/history";
import { TASK_STATE_INFO } from "@/lib/code/agent/verdict";
import { ago } from "@/lib/home";
import { cn } from "@/lib/utils";
import { StudioHeader } from "./frame";
import { Segmented } from "./ui";

interface CodeProject {
  id: string;
  name: string;
  description: string | null;
  template: string;
  sourceRepo: string | null;
  updatedAt: string;
}
interface Mission {
  id: string;
  name: string;
  goal: string | null;
  status: "active" | "paused" | "completed" | "archived";
  updated_at: string;
  counts: Record<"pending" | "in_progress" | "completed" | "blocked" | "cancelled", number>;
}
interface Row {
  key: string;
  kind: "code" | "mission";
  name: string;
  detail: string;
  href: string;
  updatedAt: string;
  description?: string | null;
  /** The project's latest coding task, when it's among the recent ones. */
  lastTask?: TaskSummary;
}

const TEMPLATE: Record<string, string> = { website: "Website", node: "Node.js", python: "Python", blank: "Project" };
type Part<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; items: T[] };

/** Every project the user has: code projects and missions, newest first, with ways to start new ones. */
export function ProjectsHub() {
  const { user } = useApp();
  const [code, setCode] = useState<Part<CodeProject>>({ status: "loading" });
  const [missions, setMissions] = useState<Part<Mission>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [kind, setKind] = useState<"all" | "code" | "mission">("all");
  const [query, setQuery] = useState("");
  // The most recent coding tasks across projects: each project's latest one, and whether it's still open.
  const [tasks, setTasks] = useState<TaskSummary[]>([]);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    jsonFetch<{ projects: CodeProject[] }>("/api/code/projects")
      .then((r) => alive && setCode({ status: "ready", items: r.projects }))
      .catch((e: Error) => alive && setCode({ status: "error", message: e.message }));
    jsonFetch<{ tasks: TaskSummary[] }>("/api/code/tasks?sort=activity")
      .then((r) => alive && setTasks(r.tasks))
      .catch(() => alive && setTasks([]));
    jsonFetch<{ missions: Mission[] }>("/api/missions")
      .then((r) => alive && setMissions({ status: "ready", items: r.missions }))
      .catch((e: Error) => alive && setMissions({ status: "error", message: e.message }));
    return () => {
      alive = false;
    };
  }, [user, attempt]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const latest = new Map<string, TaskSummary>();
    for (const t of tasks) if (!latest.has(t.projectId)) latest.set(t.projectId, t);
    if (code.status === "ready")
      for (const p of code.items)
        out.push({
          description: p.description,
          lastTask: latest.get(p.id),
          key: `c:${p.id}`,
          kind: "code",
          name: p.name,
          detail: p.sourceRepo ? `From ${p.sourceRepo}` : `${TEMPLATE[p.template] ?? "Code"} project`,
          href: `/code/${p.id}`,
          updatedAt: p.updatedAt,
        });
    if (missions.status === "ready")
      for (const m of missions.items) {
        if (m.status === "archived") continue;
        const c = m.counts;
        const total = c.pending + c.in_progress + c.completed + c.blocked;
        out.push({
          key: `m:${m.id}`,
          kind: "mission",
          name: m.name,
          detail: total ? `${c.completed} of ${total} tasks done${c.in_progress ? ` · ${c.in_progress} in progress` : ""}` : m.status === "completed" ? "Completed" : "No tasks yet",
          href: `/missions/${m.id}`,
          updatedAt: m.updated_at,
        });
      }
    const q = query.trim().toLowerCase();
    return out
      .filter((r) => (kind === "all" || r.kind === kind) && (!q || r.name.toLowerCase().includes(q) || !!r.description?.toLowerCase().includes(q)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [code, missions, kind, query, tasks]);

  const loading = code.status === "loading" || missions.status === "loading";
  const errors = [code.status === "error" && `Code projects: ${code.message}`, missions.status === "error" && `Missions: ${missions.message}`].filter(Boolean) as string[];
  const nothing = !loading && !errors.length && code.status === "ready" && missions.status === "ready" && code.items.length + missions.items.filter((m) => m.status !== "archived").length === 0;

  return (
    <>
      <StudioHeader>
        <h1 className="text-[14px] font-medium text-s-ink-2">Projects</h1>
      </StudioHeader>
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[960px] px-4 pb-24 pt-2 sm:px-8">
          <h2 className="font-serif text-[clamp(30px,5vw,40px)] leading-tight">Projects</h2>
          <p className="mt-2 max-w-2xl text-[15px] text-s-ink-2">Longer work lives here: code the agent can edit, run and test, and missions that turn a goal into tasks.</p>

          <ul className="mt-6 grid gap-2 sm:grid-cols-3">
            {[
              { href: "/code?new=1", icon: <Code2 />, title: "New code project", text: "Blank, Node.js, Python, or from GitHub" },
              { href: "/code", icon: <Globe />, title: "Build a website", text: "Describe it; the agent builds and checks it" },
              { href: "/missions", icon: <Flag />, title: "New mission", text: "Turn a goal into milestones and tasks" },
            ].map((c) => (
              <li key={c.title}>
                <Link href={c.href} className="glass group flex h-full items-start gap-3 rounded-2xl p-3.5 transition hover:border-s-line-strong">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-s-accent-soft text-s-ink-2 [&_svg]:h-4 [&_svg]:w-4">{c.icon}</span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-1 text-[14px] font-medium">
                      <Plus className="h-3.5 w-3.5" aria-hidden /> {c.title}
                    </span>
                    <span className="mt-0.5 block text-[12.5px] text-s-ink-3">{c.text}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Segmented
              label="Show"
              value={kind}
              onChange={setKind}
              options={[
                { value: "all", label: "All" },
                { value: "code", label: "Code" },
                { value: "mission", label: "Missions" },
              ]}
            />
            <Link
              href="/history?tab=tasks"
              className="inline-flex h-9 items-center gap-1.5 rounded-full border border-s-line px-3 text-[13px] text-s-ink-2 hover:border-s-line-strong hover:text-s-ink"
            >
              <History className="h-3.5 w-3.5" aria-hidden /> Task history
            </Link>
            <div className="relative ml-auto w-full sm:w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-s-ink-3" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search projects"
                aria-label="Search projects"
                className="h-9 w-full rounded-xl border border-s-line bg-transparent pl-9 pr-3 text-[13.5px] outline-none transition placeholder:text-s-ink-3 focus:border-s-line-strong"
              />
            </div>
          </div>

          {errors.length > 0 && (
            <div role="alert" className="mt-4 flex flex-wrap items-center gap-3 s-card rounded-2xl px-4 py-3 text-[13.5px] text-s-ink-2">
              <span>Some projects couldn’t load. {errors.join(" · ")}</span>
              <button
                type="button"
                onClick={() => {
                  setCode({ status: "loading" });
                  setMissions({ status: "loading" });
                  setAttempt((n) => n + 1);
                }}
                className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-s-line-strong px-3 py-1 text-[12.5px] text-s-ink hover:bg-s-hover [&_svg]:h-3.5 [&_svg]:w-3.5"
              >
                <RefreshCw /> Try again
              </button>
            </div>
          )}

          <div className="mt-4">
            {!user ? null : loading && !rows.length ? (
              <div className="space-y-3 py-2" role="status" aria-label="Loading projects">
                {[80, 64, 72].map((w, i) => (
                  <div key={i} className="s-skeleton h-12 rounded-2xl" style={{ width: `${w}%` }} />
                ))}
              </div>
            ) : nothing ? (
              <div className="rounded-2xl border border-dashed border-s-line-strong px-5 py-7 text-center text-[14px] text-s-ink-3">
                <p className="font-medium text-s-ink">No projects yet</p>
                <p className="mx-auto mt-1 max-w-lg leading-relaxed">
                  Use a project for work that takes more than one chat: code the agent builds and tests, or a goal broken into tasks. Pick one of the options above, or try an example.
                </p>
                <p className="mt-3 flex flex-wrap justify-center gap-x-4 gap-y-1 text-[13.5px]">
                  <Link href="/code?idea=saas&from=welcome" className="text-s-ink underline underline-offset-4">
                    Build an example landing page
                  </Link>
                  <Link href="/code?start=example" className="text-s-ink-2 underline underline-offset-4 hover:text-s-ink">
                    Fix a bug in an example project
                  </Link>
                </p>
              </div>
            ) : rows.length === 0 ? (
              <p className="px-1 py-6 text-[14px] text-s-ink-3">{query.trim() ? `No projects match “${query.trim()}”.` : "Nothing here yet."}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {rows.map((r) => (
                  <li key={r.key} className="relative">
                    <Link href={r.href} className="flex items-center gap-3 rounded-2xl px-3 py-2.5 transition hover:bg-s-hover">
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-s-line text-s-ink-2 [&_svg]:h-4 [&_svg]:w-4">{r.kind === "code" ? <Code2 /> : <Flag />}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14.5px] font-medium">{r.name}</span>
                        <span className="block truncate text-[12.5px] text-s-ink-3">
                          <span className={cn("mr-1.5")}>{r.kind === "code" ? "Code" : "Mission"} ·</span>
                          {r.detail}
                        </span>
                        {r.description && <span className="mt-0.5 line-clamp-2 block text-[12.5px] text-s-ink-2">{r.description}</span>}
                        {r.lastTask && (
                          <span className="mt-0.5 block truncate text-[12px] text-s-ink-3">
                            Last task: {r.lastTask.title} — {TASK_STATE_INFO[r.lastTask.state].label}
                          </span>
                        )}
                      </span>
                      {r.lastTask?.continuation.kind === "resume" && (
                        <span className="shrink-0 rounded-full border border-amber-500/50 px-2 py-0.5 text-[11.5px] text-amber-700 dark:text-amber-300">Unfinished</span>
                      )}
                      <time dateTime={r.updatedAt} className="shrink-0 text-[12px] text-s-ink-3" suppressHydrationWarning>
                        {ago(r.updatedAt)}
                      </time>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
