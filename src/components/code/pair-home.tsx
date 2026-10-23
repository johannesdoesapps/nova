"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ClipboardList, Code2, Loader2, Play, ShieldCheck } from "lucide-react";
import { useApp } from "@/components/layout/app-context";
import { StudioHeader } from "@/components/studio/frame";
import { TaskRow } from "@/components/studio/task-history";
import type { TaskSummary } from "@/lib/code/agent/history";
import type { ProjectSummary } from "@/lib/code/projects";
import { ago } from "@/lib/home";
import { api, CodeApiError, post } from "./api";
import { DEFAULT_PAIR, PairSettingsForm, startPair, type PairSettingsInput } from "./pair-panel";

const TEMPLATES = [
  { id: "blank", label: "Blank" },
  { id: "node", label: "Node.js" },
  { id: "python", label: "Python" },
  { id: "website", label: "Website" },
] as const;

const EXAMPLES = [
  "A command-line todo app in Node.js that saves to a JSON file, with unit tests for adding, completing and listing tasks.",
  "A Python function that parses and validates email addresses per RFC 5322 basics, with pytest tests for tricky cases.",
  "A small REST API in Node.js (no framework) for notes: create, list, delete, with input validation and tests.",
];

/**
 * Pair Coding's start page: describe the task, pick a project (or make one), choose each agent's model
 * and how many review rounds they get, then watch them work in the project. Recent pair tasks and the
 * user's projects are listed below.
 */
export function PairHome() {
  const { user } = useApp();
  const router = useRouter();
  const [request, setRequest] = useState("");
  const [target, setTarget] = useState<string>("new");
  const [template, setTemplate] = useState<string>("node");
  const [settings, setSettings] = useState<PairSettingsInput>(DEFAULT_PAIR);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CodeApiError | null>(null);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    api<{ projects: ProjectSummary[] }>("/api/code/projects")
      .then((r) => alive && setProjects(r.projects))
      .catch(() => alive && setProjects([]));
    api<{ tasks: TaskSummary[] }>("/api/code/tasks?kind=pair&sort=activity")
      .then((r) => alive && setTasks(r.tasks))
      .catch(() => alive && setTasks([]));
    return () => {
      alive = false;
    };
  }, [user]);

  const start = async () => {
    const text = request.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      let pid = target;
      if (pid === "new") {
        const name =
          text
            .replace(/\s+/g, " ")
            .slice(0, 60)
            .replace(/[.,;:!?]+$/, "") || "Pair project";
        pid = (await post<{ project: ProjectSummary }>("/api/code/projects", { name, template })).project.id;
      }
      const run = await startPair(pid, text, settings);
      router.push(`/pair/${pid}?run=${run.id}`);
    } catch (e) {
      setError(e instanceof CodeApiError ? e : new CodeApiError((e as Error).message, 0, null, null));
      setBusy(false);
    }
  };

  const header = (
    <StudioHeader>
      <h1 className="text-[14px] font-medium text-s-ink-2">Pair Coding</h1>
    </StudioHeader>
  );

  if (!user) {
    return (
      <>
        {header}
        <div className="mx-auto max-w-[640px] px-4 py-16 text-center">
          <h2 className="font-serif text-[clamp(28px,4.5vw,40px)]">Two AI models, one task</h2>
          <p className="mt-3 text-[15px] text-s-ink-2">An Architect writes the code; a Reviewer checks it with evidence and verifies every fix.</p>
          <Link href="/login?next=/pair" className="mt-6 inline-flex h-10 items-center rounded-full bg-s-accent px-5 text-[14px] font-medium text-s-accent-ink">
            Sign in to start
          </Link>
        </div>
      </>
    );
  }

  return (
    <>
      {header}
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[880px] px-4 pb-24 pt-2 sm:px-8">
          <h2 className="font-serif text-[clamp(30px,5vw,40px)] leading-tight">Pair Coding</h2>
          <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-s-ink-2">Two AI models work on your task in turns, and neither is allowed to just agree with the other.</p>
          <ol className="mt-3 grid gap-2 text-[13px] text-s-ink-2 sm:grid-cols-2">
            <li className="flex gap-2 rounded-2xl border border-sky-500/30 p-3">
              <ClipboardList className="mt-0.5 h-4 w-4 shrink-0 text-sky-500" aria-hidden />
              <span>
                <strong className="text-s-ink">Architect</strong> — plans the structure, writes the code, explains its decisions, and answers every review finding: fix it, or reject it with a reason.
              </span>
            </li>
            <li className="flex gap-2 rounded-2xl border border-violet-500/30 p-3">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-violet-500" aria-hidden />
              <span>
                <strong className="text-s-ink">Reviewer</strong> — reviews independently for bugs, security and missed requirements, backs each finding with evidence, reads the test results, and
                checks every fix.
              </span>
            </li>
          </ol>

          <section aria-label="Start a pair task" className="mt-6 rounded-2xl border border-s-line p-4">
            <label htmlFor="pair-home-request" className="block text-[13px] font-medium text-s-ink">
              What should they build or fix?
            </label>
            <textarea
              id="pair-home-request"
              value={request}
              onChange={(e) => setRequest(e.target.value)}
              rows={4}
              maxLength={8000}
              placeholder="Describe the program, feature or bug…"
              className="mt-1.5 block w-full resize-y rounded-xl border border-s-line bg-transparent p-3 text-[14px] outline-none placeholder:text-s-ink-3 focus:border-s-line-strong"
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {EXAMPLES.map((x) => (
                <button
                  key={x}
                  type="button"
                  onClick={() => setRequest(x)}
                  className="rounded-full border border-s-line px-2.5 py-1 text-left text-[12px] text-s-ink-2 hover:border-s-line-strong hover:text-s-ink"
                >
                  {x.split(":")[0]!.split(",")[0]!.slice(0, 48)}…
                </button>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-s-ink-2">
              <label htmlFor="pair-target">Project</label>
              <select
                id="pair-target"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                className="h-9 max-w-[260px] truncate rounded-xl border border-s-line bg-transparent px-2.5 text-[13px]"
              >
                <option value="new">New project</option>
                {(projects ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              {target === "new" && (
                <>
                  <label htmlFor="pair-template" className="sr-only">
                    Starting template
                  </label>
                  <select id="pair-template" value={template} onChange={(e) => setTemplate(e.target.value)} className="h-9 rounded-xl border border-s-line bg-transparent px-2.5 text-[13px]">
                    {TEMPLATES.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </>
              )}
            </div>
            <div className="mt-3">
              <PairSettingsForm value={settings} onChange={setSettings} />
            </div>
            {error && (
              <p role="alert" className="mt-3 rounded-xl border border-s-danger/40 px-3 py-2 text-[13px] text-s-danger">
                {error.message}{" "}
                {error.upgrade && (
                  <Link href="/pricing" className="underline">
                    See plans
                  </Link>
                )}
              </p>
            )}
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void start()}
                disabled={!request.trim() || busy}
                className="inline-flex h-10 items-center gap-2 rounded-full bg-s-accent px-5 text-[14px] font-medium text-s-accent-ink transition hover:brightness-110 disabled:opacity-40"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />} Start pair task
              </button>
              <span className="text-[12px] text-s-ink-3">
                Models come from the AI providers set up on this site; their keys stay on the server. Code runs only on the project&apos;s private computer.
              </span>
            </div>
          </section>

          <section aria-labelledby="pair-recent" className="mt-8">
            <div className="flex items-center gap-2">
              <h3 id="pair-recent" className="text-[15px] font-medium text-s-ink">
                Recent pair tasks
              </h3>
              <Link href="/history?tab=tasks" className="ml-auto text-[12.5px] text-s-ink-3 underline-offset-4 hover:text-s-ink hover:underline">
                All tasks
              </Link>
            </div>
            {tasks === null ? (
              <div className="s-skeleton mt-3 h-14 rounded-2xl" role="status" aria-label="Loading tasks" />
            ) : tasks.length === 0 ? (
              <p className="mt-2 text-[13.5px] text-s-ink-3">None yet. Your first pair task will show here with its outcome, so you can open it again.</p>
            ) : (
              <ul className="mt-3 flex flex-col gap-2">
                {tasks.slice(0, 8).map((t) => (
                  <TaskRow key={t.id} task={t} onDelete={() => router.push("/history?tab=tasks")} />
                ))}
              </ul>
            )}
          </section>

          {projects && projects.length > 0 && (
            <section aria-labelledby="pair-projects" className="mt-8">
              <h3 id="pair-projects" className="text-[15px] font-medium text-s-ink">
                Your projects
              </h3>
              <ul className="mt-2 flex flex-col gap-1">
                {projects.slice(0, 12).map((p) => (
                  <li key={p.id}>
                    <Link href={`/pair/${p.id}`} className="flex items-center gap-3 rounded-2xl px-3 py-2 transition hover:bg-s-hover">
                      <Code2 className="h-4 w-4 shrink-0 text-s-ink-3" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px] text-s-ink">{p.name}</span>
                        {p.description && <span className="block truncate text-[12.5px] text-s-ink-3">{p.description}</span>}
                      </span>
                      <time dateTime={p.updatedAt} className="shrink-0 text-[12px] text-s-ink-3" suppressHydrationWarning>
                        {ago(p.updatedAt)}
                      </time>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
