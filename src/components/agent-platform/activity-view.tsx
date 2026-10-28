"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CircleAlert, RefreshCw, Search, Square } from "lucide-react";
import { api, post } from "@/components/code/api";
import { useApp } from "@/components/layout/app-context";
import { StudioHeader } from "@/components/studio/frame";
import { InboxUpdates } from "@/components/studio/inbox";
import { ACTIVITY_STATUS_LABEL, OPEN_STATUSES, type ActivityItem, type ActivityStatus } from "@/lib/agent-platform/activity";
import { OUTCOME_INFO, type Outcome } from "@/lib/agent-platform/outcomes";
import { agentDef, AGENTS } from "@/lib/agent-platform/registry";
import { ago } from "@/lib/home";
import { cn } from "@/lib/utils";
import { AgentIconTile } from "./marketplace";

type Filter = "all" | "open" | "awaiting_approval" | "completed" | "failed";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "open", label: "In progress" },
  { id: "awaiting_approval", label: "Waiting for you" },
  { id: "completed", label: "Completed" },
  { id: "failed", label: "Failed or cancelled" },
];

const TONE: Record<ActivityStatus, string> = {
  planning: "text-s-ink-2",
  running: "text-s-ink-2",
  awaiting_approval: "text-amber-700 dark:text-amber-400",
  completed: "text-emerald-700 dark:text-emerald-400",
  failed: "text-s-danger",
  cancelled: "text-s-ink-3",
};

function keep(f: Filter, s: ActivityStatus): boolean {
  if (f === "all") return true;
  if (f === "open") return OPEN_STATUSES.includes(s);
  if (f === "failed") return s === "failed" || s === "cancelled";
  return s === f;
}

/**
 * Every agent task the user has run, side by side: coding tasks (Software Engineer, Bug Fixing, QA
 * Testing, Website Builder), code reviews and research. Each opens its own page, where its progress,
 * records and retry live. Statuses come from each task's records on the server.
 */
export function ActivityView() {
  const { user } = useApp();
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [partial, setPartial] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [agent, setAgent] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [stopping, setStopping] = useState<string | null>(null);
  // Stops the task through its own endpoint (the same one its page uses), then reloads the list from the records.
  const stop = async (i: ActivityItem) => {
    if (!i.cancelUrl) return;
    setStopping(i.id);
    try {
      await post(i.cancelUrl, {});
      setAttempt((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStopping(null);
    }
  };

  useEffect(() => {
    if (!user) return;
    let alive = true;
    api<{ items: ActivityItem[]; partial: boolean }>("/api/activity")
      .then((r) => {
        if (!alive) return;
        setItems(r.items);
        setPartial(r.partial);
        setError(null);
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [user, attempt]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (items ?? []).filter((i) => keep(filter, i.status) && (agent === "all" || i.agent === agent) && (!q || `${i.title} ${i.projectName ?? ""} ${i.detail ?? ""}`.toLowerCase().includes(q)));
  }, [items, filter, agent, query]);
  const openCount = (items ?? []).filter((i) => OPEN_STATUSES.includes(i.status)).length;
  const waitingCount = (items ?? []).filter((i) => i.status === "awaiting_approval").length;

  // While tasks are in progress, the list keeps itself current (every 20 s, only while the tab is visible).
  useEffect(() => {
    if (!user || openCount === 0) return;
    const t = setInterval(() => document.visibilityState === "visible" && setAttempt((n) => n + 1), 20_000);
    return () => clearInterval(t);
  }, [user, openCount]);
  const agentsUsed = useMemo(() => AGENTS.filter((a) => (items ?? []).some((i) => i.agent === a.id)), [items]);

  return (
    <>
      <StudioHeader>
        <span className="text-[14px] font-medium text-s-ink-2">Activity</span>
      </StudioHeader>
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[960px] px-4 pb-20 pt-2 sm:px-8">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="font-serif text-[clamp(30px,4.5vw,40px)] leading-[1.08] tracking-[-0.01em]">Activity</h1>
              <p className="mt-1.5 text-[15px] text-s-ink-2">Every task your agents ran: what&apos;s working, what&apos;s waiting for you, and how each one ended.</p>
            </div>
            {user && (
              <button type="button" onClick={() => setAttempt((n) => n + 1)} className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-s-line-strong px-3 text-[13px] hover:bg-s-hover">
                <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Refresh
              </button>
            )}
          </div>

          <InboxUpdates signedIn={!!user} markSeen />
          {!user ? (
            <p className="mt-8 text-[14px]">
              <Link href="/login?next=/activity" className="text-s-accent underline-offset-4 hover:underline">
                Sign in
              </Link>{" "}
              to see your agents&apos; tasks.
            </p>
          ) : (
            <>
              <div className="mt-6 flex flex-col gap-3 lg:flex-row lg:items-center">
                <div className="relative w-full lg:max-w-[300px]">
                  <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-s-ink-3" aria-hidden />
                  <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search tasks"
                    aria-label="Search tasks"
                    className="glass h-10 w-full rounded-xl pl-10 pr-3 text-[14px] outline-none placeholder:text-s-ink-3 focus:border-s-line-strong"
                  />
                </div>
                <div role="tablist" aria-label="Filter by status" className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] lg:mx-0 lg:px-0 lg:pb-0">
                  {FILTERS.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      role="tab"
                      aria-selected={filter === f.id}
                      onClick={() => setFilter(f.id)}
                      className={cn(
                        "h-9 shrink-0 rounded-full border px-3.5 text-[13px]",
                        filter === f.id ? "border-transparent bg-s-ink text-s-bg" : "border-s-line text-s-ink-2 hover:border-s-line-strong",
                      )}
                    >
                      {f.label}
                      {f.id === "awaiting_approval" && waitingCount > 0 && <span className="ml-1.5 rounded-full bg-amber-500/20 px-1.5 text-[11.5px] font-medium">{waitingCount}</span>}
                      {f.id === "open" && openCount ? ` · ${openCount}` : ""}
                    </button>
                  ))}
                </div>
                {agentsUsed.length > 1 && (
                  <select aria-label="Filter by agent" value={agent} onChange={(e) => setAgent(e.target.value)} className="glass h-10 rounded-xl px-3 text-[13.5px] lg:ml-auto">
                    <option value="all">All agents</option>
                    {agentsUsed.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {partial && <p className="mt-3 text-[13px] text-s-ink-3">Some tasks couldn&apos;t be loaded just now, so this list may be incomplete.</p>}

              <div className="mt-5">
                {error ? (
                  <p role="alert" className="flex items-center gap-2 text-[14px] text-s-danger">
                    <CircleAlert className="h-4 w-4" aria-hidden /> {error}
                  </p>
                ) : items === null ? (
                  <div className="space-y-2">
                    {[0, 1, 2].map((i) => (
                      <div key={i} className="s-skeleton h-[72px] rounded-2xl" />
                    ))}
                  </div>
                ) : visible.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-s-line-strong px-4 py-10 text-center text-[14px] text-s-ink-2">
                    {items.length === 0 ? (
                      <>
                        No agent tasks yet.{" "}
                        <Link href="/agents" className="text-s-accent underline-offset-4 hover:underline">
                          Pick an agent
                        </Link>{" "}
                        or ask Orbis in Chat.
                      </>
                    ) : (
                      "No tasks match."
                    )}
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {visible.map((i) => {
                      const def = agentDef(i.agent);
                      return (
                        <li key={`${i.kind}-${i.id}`} className="flex items-start gap-3 s-card rounded-2xl p-3.5 transition hover:border-s-line-strong">
                          {def && <AgentIconTile agent={def} />}
                          <div className="min-w-0 flex-1">
                            <Link href={i.href} className="block truncate text-[14.5px] font-medium hover:underline">
                              {i.title}
                            </Link>
                            <p className="mt-0.5 flex flex-wrap gap-x-1.5 text-[12.5px] text-s-ink-3">
                              <span className={cn("font-medium", TONE[i.status])}>{ACTIVITY_STATUS_LABEL[i.status]}</span>
                              <span aria-hidden>·</span>
                              <span>{i.kind === "workflow" ? "Workflow" : (def?.name ?? i.agent)}</span>
                              {i.projectName && (
                                <>
                                  <span aria-hidden>·</span>
                                  <span className="max-w-[200px] truncate">{i.projectName}</span>
                                </>
                              )}
                              <span aria-hidden>·</span>
                              <time dateTime={i.updatedAt} suppressHydrationWarning>
                                {ago(i.updatedAt)}
                              </time>
                            </p>
                            {i.detail && <p className={cn("mt-1 line-clamp-2 text-[13px]", i.status === "failed" ? "text-s-danger" : "text-s-ink-2")}>{i.detail}</p>}
                            <TaskFacts item={i} />
                          </div>
                          {i.cancelUrl && (
                            <button
                              type="button"
                              disabled={stopping === i.id}
                              onClick={() => void stop(i)}
                              className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-s-line-strong px-2.5 text-[12.5px] hover:bg-s-hover disabled:opacity-50"
                            >
                              <Square className="h-3 w-3" aria-hidden /> {stopping === i.id ? "Stopping…" : "Stop"}
                              <span className="sr-only"> {i.title}</span>
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

const OUTCOME_TONE: Record<Outcome, string> = {
  verified: "text-emerald-700 dark:text-emerald-400",
  completed: "text-s-ink-2",
  partial: "text-amber-700 dark:text-amber-400",
  blocked: "text-amber-700 dark:text-amber-400",
  failed: "text-s-danger",
  unverified: "text-amber-700 dark:text-amber-400",
};

/** What the task's records show: how it ended and why, why it failed and what helps, measured progress and recorded cost. */
function TaskFacts({ item: i }: { item: ActivityItem }) {
  const facts: string[] = [];
  if (i.progress) facts.push(`${i.progress.done} of ${i.progress.limit} ${i.progress.unit}`);
  if (i.costUsd !== null) facts.push(`$${i.costUsd < 0.01 ? i.costUsd.toFixed(4) : i.costUsd.toFixed(2)} recorded`);
  if (!i.outcome && !i.failure && !i.stalled && !facts.length) return null;
  return (
    <div className="mt-1 space-y-0.5 text-[12.5px]">
      {i.outcome && (
        <p>
          <span className={cn("font-medium", OUTCOME_TONE[i.outcome])}>{OUTCOME_INFO[i.outcome].label}</span>
          {i.outcomeNote && <span className="text-s-ink-3"> · {i.outcomeNote}</span>}
        </p>
      )}
      {i.failure && (
        <p className="text-s-ink-2">
          <span className="font-medium">{i.failure.label}:</span> {i.failure.advice}
        </p>
      )}
      {i.stalled && <p className="text-amber-700 dark:text-amber-400">No progress recorded for over 10 minutes. Tasks move on while their page is open: open it to continue.</p>}
      {facts.length > 0 && <p className="text-s-ink-3">{facts.join(" · ")}</p>}
    </div>
  );
}
