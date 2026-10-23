"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ChevronRight, CircleAlert, OctagonX, Plus, ShieldAlert } from "lucide-react";
import { useApp } from "@/components/layout/app-context";
import { StudioHeader } from "@/components/studio/frame";
import { jsonFetch } from "@/hooks/use-ndjson";
import type { WorkforceSettings } from "@/lib/workforce/settings";
import { cn } from "@/lib/utils";
import { ApprovalCard, type ApprovalLite } from "./approval-card";
import { btn, btnPrimary, dur, pct, Stat, TaskStatusBadge, usd, when } from "./bits";
import { NewTaskDialog } from "./new-task";
import { AgentsPanel, EvaluationPanel, ProjectsPanel, SettingsPanel, type AgentRow, type MetricsData, type ProjectRow } from "./panels";

interface TaskRow {
  id: string;
  title: string;
  project_id: string;
  status: string;
  status_reason: string | null;
  autonomy: string;
  priority: string;
  risk: string;
  spent_usd: number;
  tokens_used: number;
  benchmark: string | null;
  created_at: string;
  updated_at: string;
  planSummary: string | null;
}
interface Overview {
  settings: WorkforceSettings;
  sandbox: { ok: true } | { ok: false; reason: string };
  metrics: MetricsData;
  agents: AgentRow[];
  tasks: TaskRow[];
  pendingApprovals: ApprovalLite[];
  projects: ProjectRow[];
  events: { id: number; task_id: string | null; level: string; type: string; message: string; created_at: string }[];
}

const TABS = ["overview", "tasks", "agents", "projects", "approvals", "evaluation", "settings"] as const;
type Tab = (typeof TABS)[number];

export function WorkforceView() {
  const { user, integrations } = useApp();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const params = useSearchParams();
  const [tab, setTab] = useState<Tab>(() => {
    const t = params.get("tab");
    return t && (TABS as readonly string[]).includes(t) ? (t as Tab) : "overview";
  });
  const [version, setVersion] = useState(0);
  const [newTask, setNewTask] = useState(false);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const allowed = Boolean(user?.isAdmin);

  useEffect(() => {
    if (!allowed) return;
    let alive = true;
    const load = () =>
      jsonFetch<Overview>("/api/workforce/overview")
        .then((d) => alive && (setData(d), setError(null)))
        .catch((e: Error) => alive && setError(e.message));
    void load();
    const id = setInterval(() => document.visibilityState === "visible" && void load(), 8000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [version, allowed]);

  const saveSettings = async (s: WorkforceSettings) => {
    const r = await jsonFetch<{ settings: WorkforceSettings }>("/api/workforce/settings", { method: "PUT", body: JSON.stringify(s) });
    setData((d) => (d ? { ...d, settings: r.settings } : d));
    reload();
  };
  const go = (t: Tab) => {
    setTab(t);
    history.replaceState(null, "", `/workforce${t === "overview" ? "" : `?tab=${t}`}`);
  };

  const header = (
    <StudioHeader>
      <span className="text-[14px] font-medium text-s-ink-2">Workforce</span>
      <span className="rounded-full border border-s-line px-2 py-0.5 text-[11px] text-s-ink-3">internal</span>
    </StudioHeader>
  );

  if (!allowed) {
    return (
      <>
        {header}
        <div className="grid flex-1 place-items-center px-6 text-center">
          <div className="max-w-md">
            <ShieldAlert className="mx-auto h-8 w-8 text-s-ink-3" />
            <h1 className="mt-4 font-serif text-[32px]">Orbis Workforce</h1>
            <p className="mt-2 text-[15px] text-s-ink-2">The internal AI workforce is limited to Orbis operators.{!integrations.supabase ? " Accounts aren't set up on this site." : user ? " Your account isn't an operator." : ""}</p>
            {!user && integrations.supabase && (
              <Link href="/login?next=/workforce" className="mt-5 inline-flex h-10 items-center rounded-full bg-s-accent px-5 text-[14px] font-medium text-s-accent-ink">
                Sign in
              </Link>
            )}
          </div>
        </div>
      </>
    );
  }

  const m = data?.metrics;
  return (
    <>
      {header}
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1180px] px-4 pb-24 pt-2 sm:px-8">
          <div className="s-in flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
            <div>
              <h1 className="font-serif text-[clamp(34px,5vw,46px)] leading-[1.05] tracking-[-0.01em]">Orbis Workforce</h1>
              <p className="mt-2 max-w-2xl text-[15.5px] text-s-ink-2">Specialised agents that plan, build, test, review and verify changes to Orbis in isolated workspaces — with you approving what matters.</p>
            </div>
            <div className="flex gap-2">
              {data && (
                <button
                  type="button"
                  onClick={async () => {
                    if (!data.settings.emergencyStop && !confirm("Emergency stop: pause every active task and stop running checks?")) return;
                    await saveSettings({ ...data.settings, emergencyStop: !data.settings.emergencyStop });
                  }}
                  className={cn(btn, data.settings.emergencyStop ? "border-red-500/40 bg-red-500/10 text-s-danger" : "")}
                >
                  <OctagonX /> {data.settings.emergencyStop ? "Release emergency stop" : "Emergency stop"}
                </button>
              )}
              <button type="button" onClick={() => setNewTask(true)} disabled={!data} className={btnPrimary}>
                <Plus /> New task
              </button>
            </div>
          </div>

          {data?.settings.emergencyStop && (
            <p role="alert" className="mt-5 flex items-center gap-2 rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-[13.5px] text-s-danger">
              <OctagonX className="h-4 w-4" /> Emergency stop is on. No agent work runs. Release it, then resume tasks individually.
            </p>
          )}
          {data && !data.sandbox.ok && (
            <p className="mt-5 flex items-start gap-2 rounded-2xl border border-amber-500/30 bg-amber-400/10 px-4 py-3 text-[13.5px] text-amber-800 dark:text-amber-200">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" /> {data.sandbox.reason} Assist-mode analysis also needs a workspace to read the code.
            </p>
          )}
          {error && (
            <p role="alert" className="mt-5 text-[13.5px] text-s-danger">
              {error}
            </p>
          )}

          <nav aria-label="Workforce sections" className="-mx-4 mt-6 flex gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:px-0">
            {TABS.map((t) => (
              <button
                key={t}
                type="button"
                aria-current={tab === t ? "page" : undefined}
                onClick={() => go(t)}
                className={cn("h-9 shrink-0 rounded-full border px-3.5 text-[13px] capitalize transition", tab === t ? "border-transparent bg-s-ink text-s-bg" : "border-s-line text-s-ink-2 hover:border-s-line-strong hover:text-s-ink")}
              >
                {t}
                {t === "approvals" && data?.pendingApprovals.length ? <span className="ml-1.5 rounded-full bg-amber-400 px-1.5 text-[11px] text-black">{data.pendingApprovals.length}</span> : null}
              </button>
            ))}
          </nav>

          <div className="mt-5">
            {!data ? (
              <div className="grid gap-3 sm:grid-cols-4">{[0, 1, 2, 3].map((i) => <div key={i} className="s-skeleton h-24 rounded-[18px]" />)}</div>
            ) : tab === "overview" ? (
              <div className="space-y-6">
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <Stat label="Active" value={m!.totals.active} hint={`${m!.totals.queued} queued`} />
                  <Stat label="Awaiting approval" value={m!.totals.awaitingApproval} tone={m!.totals.awaitingApproval ? "warn" : undefined} />
                  <Stat label="Needs attention" value={m!.totals.needsAttention} tone={m!.totals.needsAttention ? "warn" : undefined} />
                  <Stat label="Completed" value={m!.totals.completed} hint={`${m!.totals.verified} verified · ${m!.totals.failed} failed · ${m!.totals.cancelled} cancelled`} />
                  <Stat label="Verified rate" value={pct(m!.rates.verified)} hint="Of tasks that reached verification" />
                  <Stat label="Check pass rate" value={pct(m!.rates.checkPass)} hint="Real executions of required checks" />
                  <Stat label="Average duration" value={dur(m!.durations.avgTaskMs)} hint={`${m!.durations.samples} finished`} />
                  <Stat label="Model cost (estimate)" value={usd(m!.cost.totalUsd)} hint={`${m!.cost.tokens.toLocaleString("en-US")} tokens${m!.cost.unpricedCalls ? ` · ${m!.cost.unpricedCalls} unpriced calls` : ""}`} />
                </div>
                {data.pendingApprovals.length > 0 && (
                  <section>
                    <h2 className="mb-3 text-[15px] font-semibold">Waiting for you</h2>
                    <div className="space-y-3">
                      {data.pendingApprovals.slice(0, 3).map((a) => (
                        <ApprovalCard key={a.id} a={a} onDone={reload} showTaskLink />
                      ))}
                    </div>
                  </section>
                )}
                <div className="grid gap-5 lg:grid-cols-[1.3fr_1fr]">
                  <section>
                    <h2 className="mb-3 text-[15px] font-semibold">Recent tasks</h2>
                    <TaskList tasks={data.tasks.slice(0, 8)} projects={data.projects} />
                  </section>
                  <section>
                    <h2 className="mb-3 text-[15px] font-semibold">Activity</h2>
                    <div className="glass rounded-[20px] p-4">
                      <p className="mb-2 text-[12px] text-s-ink-3">
                        Active agents: {data.agents.filter((a) => a.busy).map((a) => a.name).join(", ") || "none right now"}
                      </p>
                      <ol className="space-y-1.5 text-[12.5px]">
                        {data.events.slice(0, 14).map((e) => (
                          <li key={e.id} className={cn("leading-snug", e.level === "error" && "text-s-danger", e.level === "warn" && "text-amber-700 dark:text-amber-300")}>
                            <span className="text-s-ink-3">{when(e.created_at)}</span> · {e.task_id ? <Link href={`/workforce/tasks/${e.task_id}`} className="hover:underline">{e.message}</Link> : e.message}
                          </li>
                        ))}
                        {!data.events.length && <li className="text-s-ink-3">No activity yet.</li>}
                      </ol>
                    </div>
                  </section>
                </div>
              </div>
            ) : tab === "tasks" ? (
              <TaskList tasks={data.tasks} projects={data.projects} empty={<button type="button" onClick={() => setNewTask(true)} className={btnPrimary}><Plus /> New task</button>} />
            ) : tab === "agents" ? (
              <AgentsPanel agents={data.agents} perf={m!.agents} settings={data.settings} onSettings={saveSettings} />
            ) : tab === "projects" ? (
              <ProjectsPanel projects={data.projects} onChanged={reload} />
            ) : tab === "approvals" ? (
              <div className="space-y-3">
                {data.pendingApprovals.map((a) => (
                  <ApprovalCard key={a.id} a={a} onDone={reload} showTaskLink />
                ))}
                {!data.pendingApprovals.length && <p className="rounded-[20px] border border-dashed border-s-line-strong px-6 py-10 text-center text-[14px] text-s-ink-2">Nothing is waiting for approval.</p>}
              </div>
            ) : tab === "evaluation" ? (
              <EvaluationPanel m={m!} projects={data.projects} onRan={reload} />
            ) : (
              <SettingsPanel settings={data.settings} onSave={saveSettings} />
            )}
          </div>
        </div>
      </div>
      {data && <NewTaskDialog open={newTask} onClose={() => setNewTask(false)} projects={data.projects} maxAutonomy={data.settings.maxAutonomy} defaultBudget={data.settings.defaultBudgetUsd} maxBudget={data.settings.maxBudgetUsd} />}
    </>
  );
}

function TaskList({ tasks, projects, empty }: { tasks: TaskRow[]; projects: ProjectRow[]; empty?: React.ReactNode }) {
  if (!tasks.length)
    return (
      <div className="rounded-[20px] border border-dashed border-s-line-strong px-6 py-10 text-center">
        <p className="text-[14.5px] font-medium text-s-ink">No tasks yet</p>
        <p className="mx-auto mt-1 max-w-lg text-[13.5px] leading-relaxed text-s-ink-2">
          Workforce is for bigger engineering tasks: Orbis Commander plans the work, specialist agents build and check it in an isolated workspace, and nothing ships without your
          approval.{" "}
          {projects.length ? "Create a task to start." : "First register a project in the Projects tab, so the agents know which code to work on."}
        </p>
        {empty && projects.length > 0 && <div className="mt-4 flex justify-center">{empty}</div>}
        <p className="mt-3 text-[12.5px] text-s-ink-3">
          For a single change or a new website,{" "}
          <Link href="/code" className="text-s-ink-2 underline underline-offset-2 hover:text-s-ink">
            Code
          </Link>{" "}
          is quicker.
        </p>
      </div>
    );
  return (
    <ul className="space-y-2">
      {tasks.map((t) => {
        const p = projects.find((x) => x.id === t.project_id);
        return (
          <li key={t.id}>
            <Link href={`/workforce/tasks/${t.id}`} className="glass group flex items-center gap-3 rounded-2xl px-4 py-3 transition hover:border-s-line-strong hover:bg-s-glass-strong">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-medium">{t.title}</p>
                <p className="truncate text-[12px] text-s-ink-3">
                  {p?.name ?? "project"} · {t.autonomy} · {t.risk} risk · {usd(t.spent_usd)} · {when(t.updated_at)}
                  {t.status_reason ? ` · ${t.status_reason}` : ""}
                </p>
              </div>
              <TaskStatusBadge status={t.status} />
              <ChevronRight className="h-4 w-4 text-s-ink-3 transition group-hover:translate-x-0.5" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
