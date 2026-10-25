"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { BellRing, CalendarClock, CheckCircle2, CircleDashed, Loader2, Plug, Trash2 } from "lucide-react";
import { jsonFetch } from "@/hooks/use-ndjson";
import { cn } from "@/lib/utils";
import { fmtTime } from "./bits";
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
  name: string;
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

const NAME: Record<Integration["id"], string> = { github: "GitHub", vercel: "Vercel", cloudflare: "Cloudflare" };
const USE: Record<Integration["id"], string> = {
  github: "Private repositories, pull-request audits and PR comments",
  vercel: "Deployment settings, environment-variable metadata and the deploy gate",
  cloudflare: "TLS, WAF, DDoS, bot, DNS and Zero Trust Access review",
};

const STATUS: Record<AgentCardData["status"], { label: string; cls: string }> = {
  idle: { label: "Idle", cls: "bg-s-hover text-s-ink-3" },
  working: { label: "Working", cls: "bg-sky-500/15 text-sky-700 dark:text-sky-300" },
  needs_approval: { label: "Needs approval", cls: "bg-amber-500/15 text-amber-700 dark:text-amber-300" },
  completed: { label: "Completed", cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" },
  error: { label: "Error", cls: "bg-red-500/15 text-red-700 dark:text-red-300" },
};

/** One agent: what it's for, what it does, what it may touch, and its real status (from runs and logged events only). */
function AgentCard({ a }: { a: AgentCardData }) {
  return (
    <article className="glass flex flex-col rounded-[18px] p-4" aria-labelledby={`agent-${a.id}`}>
      <div className="flex items-start justify-between gap-2">
        <h3 id={`agent-${a.id}`} className="text-[14.5px] font-medium leading-snug">
          {a.name}
        </h3>
        <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11.5px] font-medium", STATUS[a.status].cls)}>{STATUS[a.status].label}</span>
      </div>
      <p className="mt-1.5 text-[13px] leading-snug text-s-ink-2">{a.summary}</p>
      {a.statusNote && <p className={cn("mt-1.5 text-[12.5px]", a.status === "error" ? "text-s-danger" : "text-s-ink-2")}>{a.statusNote}</p>}
      <div className="mt-2.5 text-[12.5px]">
        <p className="font-medium text-s-ink-2">Responsibilities</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-s-ink-2">
          {a.responsibilities.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        {a.notYet && <p className="mt-1.5 text-s-ink-3">Not yet: {a.notYet}</p>}
        <p className="mt-2 font-medium text-s-ink-2">Permissions</p>
        <ul className="mt-1 flex flex-wrap gap-1">
          {a.permissions.map((p) => (
            <li key={p} className="rounded-full border border-s-line px-2 py-0.5 text-[11.5px] text-s-ink-2">
              {p}
            </li>
          ))}
        </ul>
      </div>
      <div className="mt-auto pt-3 text-[12px] text-s-ink-3">
        {a.lastActivity ? (
          <p>
            Last activity:{" "}
            {a.lastActivity.href ? (
              <Link href={a.lastActivity.href} className="underline underline-offset-2">
                {a.lastActivity.label}
              </Link>
            ) : (
              a.lastActivity.label
            )}
            , {fmtTime(a.lastActivity.at)}
          </p>
        ) : (
          <p>No activity yet.</p>
        )}
        <Link href={a.details.href} className="mt-1.5 inline-block font-medium text-s-ink underline underline-offset-2">
          View details
        </Link>
      </div>
    </article>
  );
}

export function TeamOverview({ onLaunch }: { onLaunch: (m: LaunchMode) => void }) {
  const [team, setTeam] = useState<Team | null>(null);
  const [sched, setSched] = useState<Schedules | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    Promise.all([jsonFetch<Team>("/api/security/team"), jsonFetch<Schedules>("/api/security/schedules")])
      .then(([t, s]) => {
        setTeam(t);
        setSched(s);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    let live = true;
    Promise.all([jsonFetch<Team>("/api/security/team"), jsonFetch<Schedules>("/api/security/schedules")])
      .then(([t, s]) => {
        if (!live) return;
        setTeam(t);
        setSched(s);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, []);

  if (error)
    return (
      <p role="alert" className="mt-6 text-[13.5px] text-s-danger">
        The Security Team overview couldn&apos;t load: {error}
      </p>
    );
  if (!team || !sched) return <div className="s-skeleton mt-6 h-40 rounded-[20px]" />;
  const v = team.byVerification;

  return (
    <div className="mt-6 space-y-5">
      <section className="grid gap-3 md:grid-cols-[1.3fr_1fr]">
        <div className="glass rounded-[20px] p-5">
          <h2 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-s-ink-3">Open findings by verification</h2>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              ["Confirmed", v.confirmed ?? 0],
              ["Likely", v.likely ?? 0],
              ["Needs verification", v.needs_verification ?? 0],
              ["Informational", v.informational ?? 0],
            ].map(([k, n]) => (
              <div key={k as string} className="rounded-xl border border-s-line px-3 py-2">
                <p className="text-[22px] font-semibold tabular-nums">{n}</p>
                <p className="text-[12px] text-s-ink-3">{k}</p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[13px] text-s-ink-2">
            {team.status.open} open · {team.status.awaitingVerification} fixed and awaiting verification · {team.status.fixedVerified} fixed (verified by re-check) · {team.status.acceptedRisk} accepted risk · {team.status.falsePositive} false positive or disproven ·{" "}
            {team.newThisWeek} new this week{team.reopenedAlertsThisWeek ? ` · ${team.reopenedAlertsThisWeek} alert(s) about reopened findings this week` : ""}.
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
            )}{" "}
            Counts cover what has been checked; anything not connected or not audited isn&apos;t included.
          </p>
        </div>
        <div className="glass rounded-[20px] p-5">
          <h2 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-s-ink-3">Next actions</h2>
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
        </div>
      </section>

      <section aria-labelledby="team-agents">
        <h2 id="team-agents" className="mb-1 text-[13px] font-semibold uppercase tracking-[0.06em] text-s-ink-3">
          The team
        </h2>
        <p className="mb-3 text-[12.5px] text-s-ink-3">Statuses come from real runs and logged actions only. Some agents share an engine, so one audit can update more than one card.</p>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {team.agents.map((a) => (
            <AgentCard key={a.id} a={a} />
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {(
            [
              ["audit", "Start audit"],
              ["code_guardian", "Audit repository or PR"],
              ["deployment", "Audit deployment"],
              ["cloudflare", "Inspect Cloudflare"],
            ] as [LaunchMode, string][]
          ).map(([m, label]) => (
            <button key={m} type="button" onClick={() => onLaunch(m)} className="h-9 rounded-full border border-s-line-strong px-4 text-[13px] font-medium transition hover:bg-s-hover">
              {label}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-[13px] font-semibold uppercase tracking-[0.06em] text-s-ink-3">Connected services</h2>
        <div className="grid gap-3 md:grid-cols-3">
          {team.integrations.map((i) => (
            <div key={i.id} className="glass rounded-[18px] p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="flex items-center gap-2 text-[14px] font-medium">
                  <Plug className="h-4 w-4 text-s-ink-3" /> {NAME[i.id]}
                </p>
                <span className={cn("rounded-full px-2 py-0.5 text-[11.5px]", i.status === "connected" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : i.status === "not_connected" || i.status === "disconnected" ? "bg-s-hover text-s-ink-3" : "bg-amber-500/15 text-amber-700 dark:text-amber-300")}>
                  {i.status === "connected" ? "Connected" : i.status === "reauth_required" ? "Reconnect needed" : i.status === "error" ? "Error" : !i.available ? "Not set up on this site" : "Not connected"}
                </span>
              </div>
              <p className="mt-1.5 text-[12.5px] text-s-ink-2">{USE[i.id]}</p>
              <p className="mt-1.5 text-[12px] text-s-ink-3">
                {i.status === "connected" ? `${i.account ?? "Account"} · ${i.writeEnabled ? "changes allowed with your approval" : "read-only"}${i.lastCheckedAt ? ` · checked ${fmtTime(i.lastCheckedAt)}` : ""}` : i.lastError ?? "Audits that need it say so instead of guessing."}
              </p>
              <Link href="/connectors" className="mt-2 inline-block text-[12.5px] underline underline-offset-2">
                {i.status === "connected" ? "Manage" : "Connect"}
              </Link>
            </div>
          ))}
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-[1.4fr_1fr]">
        <ScheduleManager sched={sched} integrations={team.integrations} onChanged={load} />
        <div className="glass rounded-[20px] p-5">
          <h2 className="mb-2 text-[13px] font-semibold uppercase tracking-[0.06em] text-s-ink-3">Recent events</h2>
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
        </div>
      </section>
    </div>
  );
}

function ScheduleManager({ sched, integrations, onChanged }: { sched: Schedules; integrations: Integration[]; onChanged: () => void }) {
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
