"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowRight, CircleAlert, Pause, Play, Search } from "lucide-react";
import { api } from "@/components/code/api";
import { useApp } from "@/components/layout/app-context";
import { StudioHeader } from "@/components/studio/frame";
import { Dialog } from "@/components/studio/ui";
import { ACTIVITY_STATUS_LABEL, OPEN_STATUSES, type ActivityItem } from "@/lib/agent-platform/activity";
import { plansLabel, type Availability } from "@/lib/agent-platform/availability";
import { LEVEL_INFO, type CatalogueEntry, type Category, type Level } from "@/lib/agent-platform/catalogue";
import { TASK_TYPE_LABEL, type AgentId } from "@/lib/agent-platform/registry";
import { ACTION_RISKS, APPROVAL_LABEL, type Risk } from "@/lib/agent-platform/risk";
import { ago } from "@/lib/home";
import { cn } from "@/lib/utils";
import { STATE_DOT, STATE_LABEL } from "./marketplace";

/** Task agents whose tasks appear in Activity (coding runs, reviews, research, security scans); the others keep their history on their own pages. */
const IN_ACTIVITY: AgentId[] = ["engineer", "bug_fixer", "qa_tester", "website_builder", "code_review", "deep_research", "security"];

type StatusFilter = "all" | "ready" | "paused" | "unavailable" | "planned" | "admin_only";
const STATUS_FILTERS: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "Any status" },
  { id: "ready", label: "Ready" },
  { id: "paused", label: "Paused" },
  { id: "unavailable", label: "Not available to you" },
  { id: "planned", label: "Planned" },
  { id: "admin_only", label: "Administrators only" },
];

interface Stats {
  total: number;
  open: number;
  completed: number;
  failed: number;
  last: ActivityItem | null;
  lastFailure: ActivityItem | null;
}

interface CostRow {
  feature: string;
  calls: number;
  costUsd: number;
}

function statusOf(e: CatalogueEntry, av: Availability | undefined): { key: StatusFilter; label: string; dot: string; note: string | null } {
  if (e.status === "planned") return { key: "planned", label: "Planned", dot: "bg-s-ink-3", note: e.statusNote };
  if (e.status === "admin_only") return { key: "admin_only", label: "Administrators only", dot: "bg-s-ink-3", note: e.statusNote };
  if (e.taskAgent && av) {
    const note = "message" in av ? av.message : null;
    if (av.state === "available") return { key: "ready", label: STATE_LABEL.available, dot: STATE_DOT.available, note };
    if (av.state === "paused") return { key: "paused", label: STATE_LABEL.paused, dot: STATE_DOT.paused, note };
    return { key: "unavailable", label: av.state === "upgrade" ? plansLabel(av.plans) : STATE_LABEL[av.state], dot: STATE_DOT[av.state], note };
  }
  return { key: "ready", label: "Active", dot: STATE_DOT.available, note: e.statusNote };
}

function statsFor(items: ActivityItem[], agent: AgentId): Stats {
  // A workflow is listed under its first agent in Activity, but it isn't that agent's own task.
  const mine = items.filter((i) => i.agent === agent && i.kind !== "workflow");
  return {
    total: mine.length,
    open: mine.filter((i) => OPEN_STATUSES.includes(i.status)).length,
    completed: mine.filter((i) => i.status === "completed").length,
    failed: mine.filter((i) => i.status === "failed").length,
    last: mine[0] ?? null,
    lastFailure: mine.find((i) => i.status === "failed") ?? null,
  };
}

const money = (n: number) => (n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(2)}`);

/**
 * Every AI agent in Orbis, by its place in the hierarchy, with what it does, its boundaries, tools,
 * dependencies, version and status. Status comes from the server (configuration, plan, administrator
 * pause); activity from the user's own task records; costs (administrators only) from measured model
 * calls. Nothing here is estimated or made up: where a figure isn't recorded, it says so.
 */
export function DirectoryView({ catalogue }: { catalogue: CatalogueEntry[] }) {
  const { user } = useApp();
  const admin = Boolean(user?.isAdmin);
  const [availability, setAvailability] = useState<Partial<Record<AgentId, Availability>>>({});
  const [availabilityError, setAvailabilityError] = useState<string | null>(null);
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [activityNote, setActivityNote] = useState<string | null>(null);
  const [costs, setCosts] = useState<{ days: number; rows: CostRow[] } | null>(null);
  const [costError, setCostError] = useState<string | null>(null);
  const [category, setCategory] = useState<Category | "all">("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<CatalogueEntry | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    fetch("/api/agent-platform", { cache: "no-store" })
      .then(async (r) => {
        const j = (await r.json().catch(() => null)) as { agents?: { agent: { id: AgentId }; availability: Availability }[]; error?: { message?: string } } | null;
        if (!r.ok || !j?.agents) throw new Error(j?.error?.message ?? "Agent status couldn't be loaded.");
        if (alive) {
          setAvailability(Object.fromEntries(j.agents.map((l) => [l.agent.id, l.availability])));
          setAvailabilityError(null);
        }
      })
      .catch((e: Error) => alive && setAvailabilityError(e.message));
    return () => {
      alive = false;
    };
  }, [reload]);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    api<{ items: ActivityItem[]; partial: boolean }>("/api/activity")
      .then((r) => {
        if (!alive) return;
        setItems(r.items);
        setActivityNote(r.partial ? "Some of your tasks couldn't be loaded just now, so these counts may be low." : null);
      })
      .catch((e: Error) => alive && setActivityNote(`Your activity couldn't be loaded: ${e.message}`));
    return () => {
      alive = false;
    };
  }, [user]);

  const [audit, setAudit] = useState<{ ready: boolean; entries: AuditEntry[] } | null>(null);
  useEffect(() => {
    if (!admin) return;
    let alive = true;
    api<{ ready: boolean; entries: AuditEntry[] }>("/api/admin/audit")
      .then((r) => alive && setAudit(r))
      .catch(() => alive && setAudit(null));
    return () => {
      alive = false;
    };
  }, [admin]);

  useEffect(() => {
    if (!admin) return;
    let alive = true;
    api<{ economics: { periodDays: number; costByFeature: CostRow[] } }>("/api/admin/unit-economics?days=30")
      .then((r) => alive && setCosts({ days: r.economics.periodDays, rows: r.economics.costByFeature }))
      .catch((e: Error) => alive && setCostError(e.message));
    return () => {
      alive = false;
    };
  }, [admin]);

  const categories = useMemo(() => [...new Set(catalogue.map((e) => e.category))], [catalogue]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return catalogue.filter(
      (e) =>
        (category === "all" || e.category === category) &&
        (status === "all" || statusOf(e, e.taskAgent ? availability[e.taskAgent] : undefined).key === status) &&
        (!q || `${e.name} ${e.role} ${e.category} ${e.responsibilities.join(" ")} ${e.tools.join(" ")}`.toLowerCase().includes(q)),
    );
  }, [catalogue, category, status, query, availability]);
  const levels = (Object.keys(LEVEL_INFO) as Level[]).sort((a, b) => LEVEL_INFO[a].order - LEVEL_INFO[b].order).filter((l) => visible.some((e) => e.level === l));

  /** Which entries record usage under each purpose, so a shared purpose is labelled as shared. */
  const purposeOwners = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const e of catalogue) for (const p of e.purposes) m.set(p, [...(m.get(p) ?? []), e.name]);
    return m;
  }, [catalogue]);

  return (
    <>
      <StudioHeader>
        <span className="text-[14px] font-medium text-s-ink-2">Agent directory</span>
      </StudioHeader>
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1040px] px-4 pb-20 pt-2 sm:px-8">
          <h1 className="font-serif text-[clamp(30px,4.5vw,40px)] leading-[1.08] tracking-[-0.01em]">Agent directory</h1>
          <p className="mt-1.5 max-w-[680px] text-[15px] text-s-ink-2">
            Every AI agent in Orbis and how they fit together: the Orbis Agent takes your request, plans the steps, and hands each one to the specialist built for it.
          </p>

          <div className="mt-6 flex flex-col gap-3 lg:flex-row lg:items-center">
            <div className="relative w-full lg:max-w-[280px]">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-s-ink-3" aria-hidden />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search agents"
                aria-label="Search agents"
                className="glass h-10 w-full rounded-xl pl-10 pr-3 text-[14px] outline-none placeholder:text-s-ink-3 focus:border-s-line-strong"
              />
            </div>
            <select aria-label="Filter by category" value={category} onChange={(e) => setCategory(e.target.value as Category | "all")} className="glass h-10 rounded-xl px-3 text-[13.5px]">
              <option value="all">Every category</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} className="glass h-10 rounded-xl px-3 text-[13.5px]">
              {STATUS_FILTERS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
            <span className="text-[13px] text-s-ink-3 lg:ml-auto">
              {visible.length} of {catalogue.length} agents
            </span>
          </div>

          {availabilityError && (
            <p role="alert" className="mt-3 flex items-center gap-2 text-[13px] text-s-danger">
              <CircleAlert className="h-4 w-4" aria-hidden /> {availabilityError} Task agents show their catalogue status instead.
            </p>
          )}

          {levels.length === 0 ? (
            <p className="mt-8 rounded-2xl border border-dashed border-s-line-strong px-4 py-10 text-center text-[14px] text-s-ink-2">No agents match.</p>
          ) : (
            levels.map((level) => (
              <section key={level} aria-labelledby={`level-${level}`} className="mt-8">
                <h2 id={`level-${level}`} className="text-[17px] font-semibold tracking-[-0.01em]">
                  {LEVEL_INFO[level].label}
                </h2>
                <p className="mt-0.5 text-[13.5px] text-s-ink-2">{LEVEL_INFO[level].description}</p>
                <ul className="mt-3 grid gap-2.5 sm:grid-cols-2">
                  {visible
                    .filter((e) => e.level === level)
                    .map((e) => {
                      const s = statusOf(e, e.taskAgent ? availability[e.taskAgent] : undefined);
                      const st = e.taskAgent && items && IN_ACTIVITY.includes(e.taskAgent) && e.level === "specialist" ? statsFor(items, e.taskAgent) : null;
                      return (
                        <li key={e.id}>
                          <button
                            type="button"
                            onClick={() => setOpen(e)}
                            className="flex h-full w-full flex-col rounded-2xl border border-s-line p-3.5 text-left transition hover:border-s-line-strong hover:bg-s-hover/40"
                          >
                            <span className="flex w-full items-start justify-between gap-3">
                              <span className="text-[14.5px] font-medium">{e.name}</span>
                              <span className="inline-flex shrink-0 items-center gap-1.5 text-[12px] text-s-ink-3">
                                <span className={cn("h-1.5 w-1.5 rounded-full", s.dot)} aria-hidden />
                                {s.label}
                              </span>
                            </span>
                            <span className="mt-0.5 text-[12px] text-s-ink-3">
                              {e.category} · v{e.version}
                              {e.parent ? ` · part of ${catalogue.find((p) => p.id === e.parent)?.name ?? e.parent}` : ""}
                            </span>
                            <span className="mt-1.5 line-clamp-2 text-[13px] text-s-ink-2">{e.role}</span>
                            {st && st.total > 0 && (
                              <span className="mt-2 text-[12px] text-s-ink-3">
                                Your tasks: {st.total}
                                {st.open ? ` · ${st.open} open` : ""}
                                {st.failed ? ` · ${st.failed} failed` : ""}
                                {st.last ? ` · last ${ago(st.last.updatedAt)}` : ""}
                              </span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                </ul>
              </section>
            ))
          )}

          <RiskTable />
          {admin && <AuditLog audit={audit} />}

          <p className="mt-10 text-[12.5px] text-s-ink-3">
            Status comes from this deployment&apos;s setup and your plan. Activity counts come from your own tasks in{" "}
            <Link href="/activity" className="underline-offset-4 hover:underline">
              Activity
            </Link>
            ; chat assistants and multi-model tools keep their history on their own pages and aren&apos;t counted here.
          </p>
        </div>
      </div>

      <EntryDetails
        entry={open}
        catalogue={catalogue}
        availability={open?.taskAgent ? availability[open.taskAgent] : undefined}
        stats={open?.taskAgent && items && IN_ACTIVITY.includes(open.taskAgent) && open.level === "specialist" ? statsFor(items, open.taskAgent) : null}
        activityNote={activityNote}
        signedIn={Boolean(user)}
        admin={admin}
        costs={costs}
        costError={costError}
        purposeOwners={purposeOwners}
        onClose={() => setOpen(null)}
        onChanged={() => setReload((n) => n + 1)}
      />
    </>
  );
}

function EntryDetails({
  entry: e,
  catalogue,
  availability: av,
  stats,
  activityNote,
  signedIn,
  admin,
  costs,
  costError,
  purposeOwners,
  onClose,
  onChanged,
}: {
  entry: CatalogueEntry | null;
  catalogue: CatalogueEntry[];
  availability: Availability | undefined;
  stats: Stats | null;
  activityNote: string | null;
  signedIn: boolean;
  admin: boolean;
  costs: { days: number; rows: CostRow[] } | null;
  costError: string | null;
  purposeOwners: Map<string, string[]>;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  // Kept with the agent it belongs to, so it isn't shown on another agent's details.
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null);
  const pauseError = failure && failure.id === e?.id ? failure.message : null;
  const s = e ? statusOf(e, av) : null;
  const name = (id: string) => catalogue.find((c) => c.id === id)?.name ?? id;

  async function setPaused(paused: boolean) {
    if (!e?.taskAgent) return;
    setBusy(true);
    setFailure(null);
    try {
      await api("/api/admin/agents", { method: "POST", body: JSON.stringify({ agent: e.taskAgent, paused }) });
      onChanged();
    } catch (err) {
      setFailure({ id: e.id, message: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!e} onClose={onClose} title={e?.name ?? "Agent"} description={e?.role} width={680}>
      {e && s && (
        <div className="space-y-5 text-[13.5px]">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
            <Fact label="Status">
              <span className="inline-flex items-center gap-1.5">
                <span className={cn("h-1.5 w-1.5 rounded-full", s.dot)} aria-hidden />
                {s.label}
              </span>
            </Fact>
            <Fact label="Level">{LEVEL_INFO[e.level].label}</Fact>
            <Fact label="Category">{e.category}</Fact>
            <Fact label="Version">{e.version}</Fact>
          </dl>
          {s.note && <p className="rounded-xl border border-s-line bg-s-hover/60 px-3 py-2 text-s-ink-2">{s.note}</p>}

          {admin && e.taskAgent && e.level === "specialist" && av && (
            <div className="rounded-xl border border-s-line px-3 py-2.5">
              <p className="text-[12.5px] font-semibold uppercase tracking-[0.06em] text-s-ink-3">Administrator</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-3">
                <p className="flex-1 text-s-ink-2">
                  {av.state === "paused"
                    ? "Paused for everyone: no new tasks can start, from its page, the Orbis Agent or a workflow."
                    : "Pausing stops new tasks for everyone (its page, the Orbis Agent and workflows). Tasks already running carry on."}
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setPaused(av.state !== "paused")}
                  className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-s-line-strong px-3.5 text-[13px] font-medium hover:bg-s-hover disabled:opacity-60"
                >
                  {av.state === "paused" ? <Play className="h-3.5 w-3.5" aria-hidden /> : <Pause className="h-3.5 w-3.5" aria-hidden />}
                  {busy ? "Saving…" : av.state === "paused" ? "Resume" : "Pause"}
                </button>
              </div>
              {pauseError && (
                <p role="alert" className="mt-1.5 text-[13px] text-s-danger">
                  {pauseError}
                </p>
              )}
            </div>
          )}

          <List title="Responsibilities" items={e.responsibilities} />
          {e.taskTypes.length > 0 && <List title="Handles" items={e.taskTypes.map((t) => TASK_TYPE_LABEL[t])} />}
          {e.outOfScope.length > 0 && <List title="Not its job" items={e.outOfScope.map((o) => (o.useInstead ? `${o.what} (use ${name(o.useInstead)})` : o.what))} />}
          <List title="Tools and permissions" items={e.tools} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Text title="Takes">{e.input}</Text>
            <Text title="Gives back">{e.output}</Text>
          </div>
          <List title="Stops and comes back to you when" items={e.escalation} />
          <Text title="Done when">{e.doneWhen}</Text>
          {(e.parent || e.dependsOn.length > 0) && (
            <List title="Works with" items={[...(e.parent ? [`Part of ${name(e.parent)}`] : []), ...e.dependsOn.map((d) => `Hands work to or relies on ${name(d)}`)]} />
          )}
          <Text title="Who can use it">{e.access}</Text>

          <div>
            <h3 className="text-[12.5px] font-semibold uppercase tracking-[0.06em] text-s-ink-3">Your recent activity</h3>
            {!signedIn ? (
              <p className="mt-1.5 text-s-ink-2">Sign in to see your tasks.</p>
            ) : !stats ? (
              <p className="mt-1.5 text-s-ink-2">
                Not recorded in Activity for this agent.
                {e.href ? " Its own page keeps its history." : ""}
              </p>
            ) : stats.total === 0 ? (
              <p className="mt-1.5 text-s-ink-2">No tasks among your recent ones.</p>
            ) : (
              <div className="mt-1.5 space-y-1 text-s-ink-2">
                <p>
                  {stats.total} recent task{stats.total === 1 ? "" : "s"}: {stats.completed} completed, {stats.failed} failed, {stats.open} open.
                </p>
                {stats.last && (
                  <p>
                    Last:{" "}
                    <Link href={stats.last.href} className="text-s-ink underline-offset-4 hover:underline">
                      {stats.last.title}
                    </Link>{" "}
                    ({ACTIVITY_STATUS_LABEL[stats.last.status].toLowerCase()}, {ago(stats.last.updatedAt)})
                  </p>
                )}
                {stats.lastFailure?.detail && <p className="text-s-danger">Last error: {stats.lastFailure.detail}</p>}
              </div>
            )}
            {activityNote && <p className="mt-1 text-[12.5px] text-s-ink-3">{activityNote}</p>}
          </div>

          {admin && (
            <div>
              <h3 className="text-[12.5px] font-semibold uppercase tracking-[0.06em] text-s-ink-3">Model usage, all accounts (administrators)</h3>
              {costError ? (
                <p className="mt-1.5 text-s-danger">{costError}</p>
              ) : !costs ? (
                <p className="mt-1.5 text-s-ink-3">Loading…</p>
              ) : e.purposes.length === 0 ? (
                <p className="mt-1.5 text-s-ink-2">It makes no model calls of its own.</p>
              ) : (
                <>
                  <ul className="mt-1.5 space-y-1 text-s-ink-2">
                    {e.purposes.map((p) => {
                      const row = costs.rows.find((r) => r.feature === p);
                      const others = (purposeOwners.get(p) ?? []).filter((n) => n !== e.name);
                      return (
                        <li key={p}>
                          <code className="text-[12.5px]">{p}</code>: {row ? `${row.calls.toLocaleString()} calls, ${money(row.costUsd)}` : "no calls"}
                          {others.length > 0 && <span className="text-s-ink-3"> (shared with {others.join(", ")})</span>}
                        </li>
                      );
                    })}
                  </ul>
                  <p className="mt-1 text-[12.5px] text-s-ink-3">Last {costs.days} days, from recorded model calls, including administrator testing.</p>
                </>
              )}
            </div>
          )}

          <p className="text-[12px] text-s-ink-3">Defined in {e.source}</p>
          {e.href && (
            <div className="flex justify-end">
              <Link href={e.href} className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-s-accent px-3.5 text-[13px] font-medium text-s-accent-ink hover:brightness-110">
                Open {e.name} <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[12px] text-s-ink-3">{label}</dt>
      <dd className="mt-0.5 font-medium">{children}</dd>
    </div>
  );
}

function List({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <h3 className="text-[12.5px] font-semibold uppercase tracking-[0.06em] text-s-ink-3">{title}</h3>
      <ul className="mt-1.5 list-disc space-y-1 pl-5 text-s-ink-2 marker:text-s-ink-3">
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </div>
  );
}

function Text({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-[12.5px] font-semibold uppercase tracking-[0.06em] text-s-ink-3">{title}</h3>
      <p className="mt-1.5 text-s-ink-2">{children}</p>
    </div>
  );
}

interface AuditEntry {
  id: number;
  action: string;
  target: string | null;
  detail: { changed?: string[] };
  createdAt: string;
}

const RISK_TONE: Record<Risk, string> = { low: "text-s-ink-2", medium: "text-amber-700 dark:text-amber-400", high: "text-s-danger" };

/** What agents may do, how risky each action is, and what approval it needs (enforced in code; see risk.ts). */
function RiskTable() {
  return (
    <section aria-labelledby="risks" className="mt-10">
      <h2 id="risks" className="text-[17px] font-semibold tracking-[-0.01em]">
        What agents may do, and when they ask
      </h2>
      <p className="mt-0.5 text-[13.5px] text-s-ink-2">
        Low-risk, reversible work runs on its own; anything consequential waits for you. These rules are enforced where each action runs, not just in the agents&apos; instructions.
      </p>
      <div className="mt-3 overflow-x-auto rounded-2xl border border-s-line">
        <table className="w-full min-w-[640px] text-left text-[13px]">
          <thead className="text-[12px] text-s-ink-3">
            <tr className="border-b border-s-line">
              <th scope="col" className="px-3 py-2 font-medium">
                Action
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Risk
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Can be undone
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Approval
              </th>
            </tr>
          </thead>
          <tbody>
            {ACTION_RISKS.map((a) => (
              <tr key={a.id} className="border-b border-s-line last:border-0 align-top">
                <th scope="row" className="px-3 py-2 font-normal">
                  <span className="block text-s-ink">{a.action}</span>
                  <span className="block text-[12px] text-s-ink-3">
                    {a.agents}. {a.how}
                  </span>
                </th>
                <td className={cn("px-3 py-2 capitalize", RISK_TONE[a.risk])}>{a.risk}</td>
                <td className="px-3 py-2 text-s-ink-2">{a.reversible === "yes" ? "Yes" : a.reversible === "partly" ? "Partly" : "No"}</td>
                <td className="px-3 py-2 text-s-ink-2">{APPROVAL_LABEL[a.approval]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const AUDIT_ACTION: Record<string, string> = { "agent.pause": "Paused an agent", "agent.resume": "Resumed an agent", "settings.save": "Saved platform settings" };

function AuditLog({ audit }: { audit: { ready: boolean; entries: AuditEntry[] } | null }) {
  return (
    <section aria-labelledby="audit" className="mt-8">
      <h2 id="audit" className="text-[17px] font-semibold tracking-[-0.01em]">
        Administrator changes
      </h2>
      {!audit ? (
        <p className="mt-1 text-[13.5px] text-s-ink-3">The audit log couldn&apos;t be loaded.</p>
      ) : !audit.ready ? (
        <p className="mt-1 text-[13.5px] text-s-ink-2">The audit log isn&apos;t set up on this deployment yet (its database table hasn&apos;t been created), so changes aren&apos;t being recorded.</p>
      ) : audit.entries.length === 0 ? (
        <p className="mt-1 text-[13.5px] text-s-ink-2">No administrator changes recorded yet.</p>
      ) : (
        <ul className="mt-2 space-y-1 text-[13px] text-s-ink-2">
          {audit.entries.slice(0, 20).map((e) => (
            <li key={e.id}>
              <time dateTime={e.createdAt} suppressHydrationWarning className="text-s-ink-3">
                {ago(e.createdAt)}
              </time>{" "}
              · {AUDIT_ACTION[e.action] ?? e.action}
              {e.target ? `: ${e.target}` : ""}
              {e.detail.changed?.length ? ` (${e.detail.changed.join(", ")})` : ""}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
