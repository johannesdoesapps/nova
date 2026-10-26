"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { BellRing, CalendarClock, Check, CheckCircle2, ChevronRight, CircleDashed, Loader2, Trash2 } from "lucide-react";
import { jsonFetch } from "@/hooks/use-ndjson";
import { cn } from "@/lib/utils";
import { AGENT_ICON, AgentBadge, fmtTime } from "./bits";
import { inputCls, labelCls } from "./forms";
import type { LaunchMode } from "./launcher";

interface Integration {
  id: "github" | "vercel" | "cloudflare";
  available: boolean;
  status: string;
  account: string | null;
  writeEnabled: boolean;
  lastCheckedAt: string | null;
  lastError: string | null;
}
interface AgentCardData {
  id: string;
  codename: string;
  name: string;
  engine: string;
  summary: string;
  responsibilities: string[];
  notYet: string | null;
  status: "idle" | "working" | "needs_approval" | "completed" | "error";
  statusNote: string | null;
  lastActivity: { label: string; at: string; href: string | null } | null;
  permissions: string[];
  details: { label: string; href: string };
}
interface Team {
  agents: AgentCardData[];
  integrations: Integration[];
  bySeverity: Record<string, number>;
  byVerification: Record<string, number>;
  status: { open: number; awaitingVerification: number; fixedVerified: number; acceptedRisk: number; falsePositive: number };
  newThisWeek: number;
  reopenedAlertsThisWeek: number;
  lastAudit: { id: string; agent: string; action: string; asset: string | null; at: string } | null;
  events: { id: number; label: string; at: string; runId: string | null; findingId: string | null }[];
  next: { text: string; href?: string; action?: string }[];
}
interface ScheduleRow {
  id: string;
  kind: "repository" | "deployment" | "cloudflare";
  label: string;
  frequency: "daily" | "weekly";
  enabled: boolean;
  lastRun: { at: string; runId: string | null; outcome: string } | null;
  nextRun: string | null;
}
interface Schedules {
  schedules: ScheduleRow[];
  alerts: { email: boolean; minSeverity: "critical" | "high" };
}

const STATUS: Record<AgentCardData["status"], { label: string; cls: string }> = {
  idle: { label: "Idle", cls: "bg-s-hover text-s-ink-3" },
  working: { label: "Working", cls: "bg-sky-500/15 text-sky-700 dark:text-sky-300" },
  needs_approval: { label: "Needs approval", cls: "bg-amber-500/15 text-amber-700 dark:text-amber-300" },
  completed: { label: "Completed", cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" },
  error: { label: "Error", cls: "bg-red-500/15 text-red-700 dark:text-red-300" },
};

/** Each agent's logo (tint comes from AGENT_TINT under the same id). */
const AGENT_LOGO: Record<string, keyof typeof AGENT_ICON> = {
  auditor: "scan",
  verification: "verify",
  protection: "protect",
  identity: "key",
  reporting: "report",
  github: "branch",
  vercel: "triangle",
  cloudflare: "cloud",
  monitoring: "monitor",
  fix: "wrench",
  orchestrator: "orchestrate",
};

/** One agent, in the same card style as the engines: logo, name, what it runs on, real status, then the detail. */
function AgentCard({ a, i }: { a: AgentCardData; i: number }) {
  return (
    <article
      aria-labelledby={`agent-${a.id}`}
      className="glass relative flex flex-col rounded-[22px] p-5 transition duration-300 hover:border-s-line-strong hover:shadow-[var(--s-shadow)]"
      style={{ animation: `s-in .34s cubic-bezier(.2,.7,.2,1) ${i * 40}ms both` }}
    >
      <div className="flex items-start gap-3.5">
        <AgentBadge agent={a.id} icon={AGENT_LOGO[a.id] ?? "shield"} />
        <div className="min-w-0 flex-1">
          <h3 id={`agent-${a.id}`} className="text-[16px] font-semibold leading-snug tracking-[-0.01em]">
            {a.codename}
          </h3>
          <p className="text-[12.5px] leading-snug text-s-ink-2">{a.name.replace(/ Agent$/, "")}</p>
          <p className="text-[12px] leading-snug text-s-ink-3">{a.engine}</p>
        </div>
        <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11.5px] font-medium", STATUS[a.status].cls)}>{STATUS[a.status].label}</span>
      </div>
      <p className="mt-3.5 text-[13.5px] leading-relaxed text-s-ink-2">{a.summary}</p>
      {a.statusNote && <p className={cn("mt-2 text-[12.5px]", a.status === "error" ? "text-s-danger" : "text-s-ink-2")}>{a.statusNote}</p>}
      <ul className="mt-3 space-y-1" aria-label="Responsibilities">
        {a.responsibilities.map((r) => (
          <li key={r} className="flex items-start gap-2 text-[12.5px] text-s-ink-2">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-s-ink-3" /> {r}
          </li>
        ))}
      </ul>
      {a.notYet && <p className="mt-2 text-[12px] text-s-ink-3">Not yet: {a.notYet}</p>}
      <ul className="mt-4 flex flex-wrap gap-1.5" aria-label="Permissions">
        {a.permissions.map((p) => (
          <li key={p} className="inline-flex items-center gap-1.5 rounded-full border border-s-line px-2.5 py-1 text-[11.5px] text-s-ink-2">
            <span className={cn("h-1.5 w-1.5 rounded-full", /not connected|off$/.test(p) ? "bg-s-ink-3/50" : "bg-emerald-500")} aria-hidden />
            {p}
          </li>
        ))}
      </ul>
      <div className="mt-auto pt-5">
        <p className="mb-2 text-[12px] text-s-ink-3">
          {a.lastActivity ? (
            <>
              Last activity:{" "}
              {a.lastActivity.href ? (
                <Link href={a.lastActivity.href} className="underline underline-offset-2">
                  {a.lastActivity.label}
                </Link>
              ) : (
                a.lastActivity.label
              )}
              , {fmtTime(a.lastActivity.at)}
            </>
          ) : (
            "No activity yet."
          )}
        </p>
        <Link href={a.details.href} className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-s-line-strong text-[14px] font-medium transition hover:border-transparent hover:bg-s-accent hover:text-s-accent-ink">
          View details <ChevronRight className="h-4 w-4" />
        </Link>
      </div>
    </article>
  );
}

/** The Security Team's data (agents, posture, events) and schedules, loaded once and shared by the page's tabs. */
export function useTeam(enabled: boolean) {
  const [team, setTeam] = useState<Team | null>(null);
  const [sched, setSched] = useState<Schedules | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    Promise.all([jsonFetch<Team>("/api/security/team"), jsonFetch<Schedules>("/api/security/schedules")])
      .then(([t, s]) => {
        if (!live) return;
        setTeam(t);
        setSched(s);
        setError(null);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [enabled, version]);
  return { team, sched, error, reload };
}

const SEVERITY_DOT: Record<string, string> = { critical: "bg-red-600", high: "bg-orange-500", medium: "bg-amber-400", low: "bg-sky-500", info: "bg-s-ink-3" };

/** Open findings by severity (each opens the filtered list) and by how certain they are, plus where everything stands. */
export function PostureCard({ team, onSeverity }: { team: Team; onSeverity: (s: string) => void }) {
  const v = team.byVerification;
  return (
    <section className="glass rounded-[20px] p-5" aria-labelledby="posture">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="posture" className="text-[15px] font-semibold">
          Open findings
        </h2>
        <p className="text-[12px] text-s-ink-3">No overall score: counts cover only what has been checked.</p>
      </div>
      <div className="mt-3 grid grid-cols-5 gap-2">
        {(["critical", "high", "medium", "low", "info"] as const).map((s) => (
          <button key={s} type="button" onClick={() => onSeverity(s)} className="s-card rounded-2xl px-1 py-2.5 text-center transition hover:bg-s-hover">
            <span className="block text-[22px] font-semibold tabular-nums">{team.bySeverity[s] ?? 0}</span>
            <span className="mt-0.5 inline-flex items-center gap-1.5 text-[12px] capitalize text-s-ink-2">
              <span className={cn("h-2 w-2 rounded-full", SEVERITY_DOT[s])} aria-hidden /> {s}
            </span>
          </button>
        ))}
      </div>
      <p className="mt-3 text-[13px] text-s-ink-2">
        <span className="font-medium text-s-ink">{v.confirmed ?? 0}</span> confirmed · <span className="font-medium text-s-ink">{v.likely ?? 0}</span> likely ·{" "}
        <span className="font-medium text-s-ink">{v.needs_verification ?? 0}</span> need verification · {v.informational ?? 0} informational
      </p>
      <p className="mt-1 text-[12.5px] text-s-ink-3">
        {team.status.awaitingVerification} awaiting verification · {team.status.fixedVerified} fixed (verified) · {team.status.acceptedRisk} accepted risk · {team.status.falsePositive} false positive · {team.newThisWeek} new this
        week
        {team.reopenedAlertsThisWeek ? ` · ${team.reopenedAlertsThisWeek} reopened alert(s)` : ""}
      </p>
      <p className="mt-1 text-[12.5px] text-s-ink-3">
        {team.lastAudit ? (
          <>
            Last completed check:{" "}
            <Link href={`/agents/security/runs/${team.lastAudit.id}`} className="underline underline-offset-2">
              {team.lastAudit.action} of {team.lastAudit.asset ?? "—"}
            </Link>
            , {fmtTime(team.lastAudit.at)}.
          </>
        ) : (
          "No completed checks yet."
        )}
      </p>
    </section>
  );
}

export function NextActions({ team, onLaunch }: { team: Team; onLaunch: (m: LaunchMode) => void }) {
  return (
    <section className="glass rounded-[20px] p-5" aria-labelledby="next-actions">
      <h2 id="next-actions" className="text-[15px] font-semibold">
        Next actions
      </h2>
      {team.next.length ? (
        <ul className="mt-2 space-y-2 text-[13.5px]">
          {team.next.map((n, i) => (
            <li key={i} className="flex items-start gap-2">
              <CircleDashed className="mt-0.5 h-4 w-4 shrink-0 text-s-ink-3" />
              {n.href ? (
                <Link href={n.href} className="hover:underline">
                  {n.text}
                </Link>
              ) : n.action ? (
                <button type="button" onClick={() => onLaunch(n.action as LaunchMode)} className="text-left hover:underline">
                  {n.text}
                </button>
              ) : (
                <span>{n.text}</span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 flex items-center gap-2 text-[13.5px] text-s-ink-2">
          <CheckCircle2 className="h-4 w-4 text-emerald-500" /> Nothing waiting on you.
        </p>
      )}
    </section>
  );
}

/** A compact strip of the team's agents and their status, for the overview. */
export function TeamStrip({ team, onOpen }: { team: Team; onOpen: () => void }) {
  const busy = team.agents.filter((a) => a.status !== "idle");
  return (
    <section className="glass rounded-[20px] p-5" aria-labelledby="team-strip">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="team-strip" className="text-[15px] font-semibold">
          The team
        </h2>
        <button type="button" onClick={onOpen} className="text-[13px] text-s-ink-2 underline underline-offset-2 hover:text-s-ink">
          See all {team.agents.length} agents
        </button>
      </div>
      <ul className="mt-3 flex flex-wrap gap-1.5">
        {team.agents.map((a) => (
          <li key={a.id} title={`${a.name.replace(/ Agent$/, "")}: ${a.summary}`} className="inline-flex items-center gap-1.5 rounded-full border border-s-line px-2.5 py-1 text-[12px]">
            <span className={cn("h-1.5 w-1.5 rounded-full", a.status === "working" ? "bg-sky-500" : a.status === "needs_approval" ? "bg-amber-500" : a.status === "error" ? "bg-red-500" : a.status === "completed" ? "bg-emerald-500" : "bg-s-ink-3/40")} aria-hidden />
            {a.codename.replace(/^Orbis /, "")}
            <span className="sr-only">
              {" "}
              ({a.name.replace(/ Agent$/, "")}): {STATUS[a.status].label}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[12.5px] text-s-ink-3">{busy.length ? `${busy.length} of ${team.agents.length} agents have activity.` : "No agent has run yet. Start an audit to put the team to work."}</p>
    </section>
  );
}

export function AgentGrid({ team }: { team: Team }) {
  return (
    <section aria-labelledby="team-agents">
      <h2 id="team-agents" className="text-[15px] font-semibold">
        Agents
      </h2>
      <p className="mb-3 mt-0.5 text-[12.5px] text-s-ink-3">Statuses come from real runs and logged actions only. Some agents share an engine, so one audit can update more than one card.</p>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {team.agents.map((a, i) => (
          <AgentCard key={a.id} a={a} i={i} />
        ))}
      </div>
    </section>
  );
}

export function RecentEvents({ team }: { team: Team }) {
  return (
    <section className="glass rounded-[20px] p-5" aria-labelledby="recent-events">
      <h2 id="recent-events" className="mb-2 text-[15px] font-semibold">
        Recent events
      </h2>
      {team.events.length ? (
        <ul className="space-y-1.5 text-[13px]">
          {team.events.map((e) => (
            <li key={e.id} className="flex justify-between gap-3">
              {e.runId ? (
                <Link href={`/agents/security/runs/${e.runId}`} className="truncate hover:underline">
                  {e.label}
                </Link>
              ) : e.findingId ? (
                <Link href={`/agents/security/findings/${e.findingId}`} className="truncate hover:underline">
                  {e.label}
                </Link>
              ) : (
                <span className="truncate">{e.label}</span>
              )}
              <span className="shrink-0 text-s-ink-3">{fmtTime(e.at)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-s-ink-3">No events yet.</p>
      )}
    </section>
  );
}

export function ScheduleManager({ sched, integrations, onChanged }: { sched: Schedules; integrations: Integration[]; onChanged: () => void }) {
  const [kind, setKind] = useState<ScheduleRow["kind"]>("repository");
  const [target, setTarget] = useState("");
  const [frequency, setFrequency] = useState<"daily" | "weekly">("weekly");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const connected = (id: Integration["id"]) => integrations.find((i) => i.id === id)?.status === "connected";

  const post = async (body: unknown, ok: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await jsonFetch("/api/security/schedules", { method: "POST", body: JSON.stringify(body) });
      setMsg({ tone: "ok", text: ok });
      onChanged();
    } catch (e) {
      setMsg({ tone: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const add = () => {
    const t = target.trim();
    const schedule =
      kind === "repository"
        ? { kind, repo: t.replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\.git$|\/$/g, ""), frequency }
        : kind === "deployment"
          ? { kind, project: t.includes("/") ? t.split("/")[1] : t, teamId: t.includes("/") ? t.split("/")[0] : null, frequency }
          : { kind, zone: t || null, frequency };
    void post({ op: "set", schedule }, "Schedule saved.").then(() => setTarget(""));
  };

  return (
    <div id="schedules" className="glass scroll-mt-20 rounded-[20px] p-5">
      <h2 className="mb-2 flex items-center gap-2 text-[13px] font-semibold uppercase tracking-[0.06em] text-s-ink-3">
        <CalendarClock className="h-4 w-4" /> Scheduled audits
      </h2>
      {sched.schedules.length ? (
        <ul className="space-y-2 text-[13px]">
          {sched.schedules.map((s) => (
            <li key={s.id} className="flex items-start justify-between gap-3 rounded-xl border border-s-line px-3 py-2">
              <span>
                <span className="font-medium">{s.label}</span>
                <span className="block text-[12px] text-s-ink-3">
                  {s.lastRun ? (
                    <>
                      Last:{" "}
                      {s.lastRun.runId ? (
                        <Link href={`/agents/security/runs/${s.lastRun.runId}`} className="underline underline-offset-2">
                          {fmtTime(s.lastRun.at)}
                        </Link>
                      ) : (
                        fmtTime(s.lastRun.at)
                      )}{" "}
                      ({s.lastRun.outcome.startsWith("failed") ? s.lastRun.outcome : "completed"}).{" "}
                    </>
                  ) : (
                    "Hasn't run yet. "
                  )}
                  {s.nextRun ? `Next ${s.nextRun}.` : "Paused."}
                </span>
              </span>
              <button type="button" disabled={busy} onClick={() => void post({ op: "remove", id: s.id }, "Schedule removed.")} aria-label={`Remove ${s.label}`} className="rounded-lg p-1.5 text-s-ink-3 hover:bg-s-hover hover:text-s-danger">
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-s-ink-3">No scheduled audits yet.</p>
      )}
      <form
        className="mt-3 grid gap-2 sm:grid-cols-[auto_1fr_auto_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <label className="sr-only" htmlFor="sched-kind">
          What to audit
        </label>
        <select id="sched-kind" value={kind} onChange={(e) => setKind(e.target.value as ScheduleRow["kind"])} className={cn(inputCls, "sm:w-auto")}>
          <option value="repository">GitHub repository</option>
          <option value="deployment" disabled={!connected("vercel")}>
            Vercel project{connected("vercel") ? "" : " (connect Vercel)"}
          </option>
          <option value="cloudflare" disabled={!connected("cloudflare")}>
            Cloudflare{connected("cloudflare") ? "" : " (connect Cloudflare)"}
          </option>
        </select>
        <label className="sr-only" htmlFor="sched-target">
          Target
        </label>
        <input
          id="sched-target"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder={kind === "repository" ? "owner/repo" : kind === "deployment" ? "project, or team_id/project" : "zone (blank: first five active)"}
          className={inputCls}
        />
        <select aria-label="How often" value={frequency} onChange={(e) => setFrequency(e.target.value as "daily" | "weekly")} className={cn(inputCls, "sm:w-auto")}>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
        </select>
        <button type="submit" disabled={busy || (kind !== "cloudflare" && !target.trim())} className="h-10 rounded-xl bg-s-accent px-4 text-[13.5px] font-medium text-s-accent-ink disabled:opacity-50">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add"}
        </button>
      </form>
      <p className="mt-2 text-[12px] text-s-ink-3">
        Runs once a day at 07:17 UTC, as you, with your own connections, read-only and without AI. Website scans stay manual because they re-check your ownership proof. Results and anything that couldn&apos;t be
        checked appear in the run history.
      </p>
      {msg && (
        <p role={msg.tone === "error" ? "alert" : "status"} className={cn("mt-2 text-[13px]", msg.tone === "error" ? "text-s-danger" : "text-s-ink-2")}>
          {msg.text}
        </p>
      )}
      <div className="mt-4 border-t border-s-line pt-3">
        <p className={cn(labelCls, "flex items-center gap-2")}>
          <BellRing className="h-4 w-4" /> Alerts
        </p>
        <div className="flex flex-wrap items-center gap-3 text-[13px]">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={sched.alerts.email} disabled={busy} onChange={(e) => void post({ op: "alerts", alerts: { ...sched.alerts, email: e.target.checked } }, "Alert settings saved.")} className="h-4 w-4 accent-[var(--s-accent)]" />
            Email me about new or reopened findings
          </label>
          <select aria-label="Alert threshold" value={sched.alerts.minSeverity} disabled={busy} onChange={(e) => void post({ op: "alerts", alerts: { ...sched.alerts, minSeverity: e.target.value } }, "Alert settings saved.")} className="h-8 rounded-lg border border-s-line bg-transparent px-2 text-[13px]">
            <option value="critical">Critical only</option>
            <option value="high">High and critical</option>
          </select>
        </div>
        <p className="mt-1 text-[12px] text-s-ink-3">Only confirmed or likely findings alert; ones that still need verification don&apos;t. Alerts are always listed in Recent events.</p>
      </div>
    </div>
  );
}
