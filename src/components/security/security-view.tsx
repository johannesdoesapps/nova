"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ChevronRight, CircleAlert, Cloud, Code2, FileSearch, Globe, Network, Play, Plus, Rocket, ScanSearch, ShieldCheck, Trash2 } from "lucide-react";
import { useApp } from "@/components/layout/app-context";
import { StudioHeader } from "@/components/studio/frame";
import { Menu, MenuItem, MenuLabel, Segmented } from "@/components/studio/ui";
import { jsonFetch } from "@/hooks/use-ndjson";
import type { SecurityAgentDef } from "@/lib/security/agents";
import { MODE_INFO, type AuditMode } from "@/lib/security/audit";
import type { StoredAnalysis } from "@/lib/security/audit-report";
import { cn } from "@/lib/utils";
import { MonitoringNote } from "./audit-views";
import { AGENT_NAME, AgentBadge, fmtTime, ICON_OF, RunStatus } from "./bits";
import { EMPTY_FILTERS, FindingsPanel, type FindingFilters } from "./findings-panel";
import type { Target } from "./forms";
import { Launcher, type LaunchMode } from "./launcher";
import { AgentGrid, Integrations, NextActions, PostureCard, RecentEvents, ScheduleManager, TeamStrip, useTeam } from "./team-overview";

interface Tool {
  id: string;
  name: string;
  kind: "builtin" | "service" | "external";
  description: string;
  envVars: string[];
  available: boolean;
  reason?: string;
}
interface Run {
  id: string;
  parent_id: string | null;
  agent: string;
  action: string;
  status: string;
  asset: string | null;
  scope: string | null;
  stats: { findings?: number; audit?: { mode: AuditMode }; posture?: StoredAnalysis["posture"]; gate?: StoredAnalysis["gate"] };
  error: string | null;
  started_at: string;
}
interface Overview {
  agents: SecurityAgentDef[];
  tools: Tool[];
  targets: Target[];
  runs: Run[];
  latest: Record<string, { status: string; runId: string; at: string } | null>;
  openCounts: Record<string, number>;
  openPosture: { confirmedOrLikely: number; unverified: number };
  totals: { all: number; open: number; assets: string[] };
}

const TABS = ["overview", "agents", "findings", "history", "schedules", "setup"] as const;
type Tab = (typeof TABS)[number];

const RUN_ACTION: Record<string, string> = { audit: "code audit", pr_audit: "pull-request audit", scan: "website scan", deployment: "Vercel deployment audit", cloudflare: "Cloudflare review", investigate: "log investigation" };

/** Aegis (coordination) and Bastion (protection): the layers above the engines, each with its own workspace. */
const LAYERS = [
  {
    id: "aegis",
    icon: "network",
    name: "Orbis Aegis",
    role: "Security command center",
    href: "/agents/security/aegis",
    action: "Open command center",
    description: "One prioritised view across every security agent: what matters now, attack-path hypotheses, investigations, remediation that only counts as fixed after a re-check, and what isn't covered.",
  },
  {
    id: "bastion",
    icon: "shield",
    name: "Orbis Bastion",
    role: "Workspace security and protection layer",
    href: "/agents/security/bastion",
    action: "Open Bastion",
    description: "Your agents, connected services and projects: what they can do, what's wrong, and rules you add. Every agent's actions are checked on Orbis's servers before they run.",
  },
] as const;

export function SecurityView() {
  const { user, integrations } = useApp();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const router = useRouter();
  const params = useSearchParams();
  const fromUrl = params.get("tab");
  const tab: Tab = (TABS as readonly string[]).includes(fromUrl ?? "") ? (fromUrl as Tab) : "overview";
  const setTab = useCallback((t: Tab) => router.replace(t === "overview" ? "/agents/security" : `/agents/security?tab=${t}`, { scroll: false }), [router]);
  const [filters, setFilters] = useState<FindingFilters>(EMPTY_FILTERS);
  const [launch, setLaunch] = useState<LaunchMode | null>(null);
  const signedOut = integrations.supabase ? !user : true;
  const team = useTeam(!signedOut);
  const teamReload = team.reload;
  const reloadAll = useCallback(() => {
    setVersion((v) => v + 1);
    teamReload();
  }, [teamReload]);

  useEffect(() => {
    if (signedOut) return;
    let alive = true;
    jsonFetch<Overview>("/api/security/overview")
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [version, signedOut]);

  const refreshTargets = useCallback(async () => {
    const r = await jsonFetch<{ targets: Target[] }>("/api/security/targets");
    setData((d) => (d ? { ...d, targets: r.targets } : d));
  }, []);

  const header = (
    <StudioHeader>
      <Link href="/agents" className="inline-flex items-center gap-1.5 text-[14px] text-s-ink-2 transition hover:text-s-ink">
        <ArrowLeft className="h-4 w-4" /> Agents
      </Link>
      <span className="text-s-ink-3">/</span>
      <span className="text-[14px] font-medium">Security</span>
    </StudioHeader>
  );

  if (signedOut) {
    return (
      <>
        {header}
        <div className="grid flex-1 place-items-center px-6 text-center">
          <div className="max-w-md">
            <ShieldCheck className="mx-auto h-8 w-8 text-s-ink-3" />
            <h1 className="mt-4 font-serif text-[34px] leading-tight">Security Team</h1>
            <p className="mt-2 text-[15px] text-s-ink-2">Scans, findings and audit history are private to your account.{integrations.supabase ? "" : " Accounts aren't set up on this site yet."}</p>
            {integrations.supabase && (
              <Link href="/login?next=/agents/security" className="mt-5 inline-flex h-10 items-center rounded-full bg-s-accent px-5 text-[14px] font-medium text-s-accent-ink">
                Sign in to start
              </Link>
            )}
          </div>
        </div>
      </>
    );
  }

  const active = data?.agents.filter((a) => a.status === "active") ?? [];
  const planned = data?.agents.filter((a) => a.status === "planned") ?? [];
  const toolById = new Map(data?.tools.map((t) => [t.id, t]) ?? []);
  const topRuns = data?.runs.filter((r) => !r.parent_id) ?? [];
  const childCount = (id: string) => data?.runs.filter((r) => r.parent_id === id).length ?? 0;
  const runTitle = (r: Run) => (r.stats?.audit ? `Sentinel · ${MODE_INFO[r.stats.audit.mode].label}` : `${AGENT_NAME[r.agent]} · ${RUN_ACTION[r.action] ?? r.action}${r.scope ? ` (${r.scope})` : ""}`);
  const showFindings = (severity: string) => {
    setFilters({ ...EMPTY_FILTERS, severity: severity as FindingFilters["severity"], status: "open" });
    setTab("findings");
  };

  const runList = (runs: Run[]) => (
    <ul className="space-y-2">
      {runs.map((r) => (
        <li key={r.id}>
          <Link href={`/agents/security/runs/${r.id}`} className="glass group flex items-center gap-3 rounded-2xl px-4 py-3 transition hover:border-s-line-strong">
            <AgentBadge agent={r.agent} icon={ICON_OF[r.agent]!} size="sm" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-medium">{runTitle(r)}</p>
              <p className="truncate text-[12.5px] text-s-ink-3">
                {r.asset ?? "—"} · {fmtTime(r.started_at)}
                {typeof r.stats?.findings === "number" ? ` · ${r.stats.findings} findings` : ""}
                {childCount(r.id) ? ` · ${childCount(r.id)} agent runs` : ""}
                {r.stats?.gate ? ` · gate ${r.stats.gate.outcome}` : ""}
                {r.error ? ` · ${r.error}` : ""}
              </p>
            </div>
            <RunStatus status={r.status} />
            <ChevronRight className="h-4 w-4 text-s-ink-3" />
          </Link>
        </li>
      ))}
    </ul>
  );

  return (
    <>
      {header}
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1180px] px-4 pb-24 pt-2 sm:px-8">
          <div className="s-in flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
            <div>
              <h1 className="font-serif text-[clamp(34px,5vw,46px)] leading-[1.05] tracking-[-0.01em]">Security Team</h1>
              <p className="mt-2 max-w-2xl text-[15.5px] text-s-ink-2">
                Eleven agents audit your code, repositories, deployments and Cloudflare protection, verify what they find and help you fix it. Coordinated by Aegis, guarded by Bastion — nothing changes
                without your approval.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Menu
                label="New check"
                align="end"
                width={300}
                disabled={!data}
                buttonClassName="inline-flex h-10 items-center gap-2 rounded-xl border border-s-line-strong px-4 text-[14px] font-medium transition hover:bg-s-hover disabled:opacity-50"
                button={
                  <>
                    <Plus className="h-4 w-4" /> New check
                  </>
                }
              >
                <MenuLabel>Code</MenuLabel>
                <MenuItem icon={<Code2 />} hint="Upload files, a GitHub repository or a pull request" onClick={() => setLaunch("code_guardian")}>
                  Audit code or pull request
                </MenuItem>
                <MenuLabel>Live applications</MenuLabel>
                <MenuItem icon={<Globe />} hint="Headers, TLS, cookies and exposure on a site you own" onClick={() => setLaunch("sentinel")}>
                  Scan a website
                </MenuItem>
                <MenuItem icon={<Rocket />} hint="Project settings, variables and the deploy gate" onClick={() => setLaunch("deployment")}>
                  Audit a Vercel deployment
                </MenuItem>
                <MenuItem icon={<Cloud />} hint="TLS, WAF, DDoS, bots, DNS and Access" onClick={() => setLaunch("cloudflare")}>
                  Review Cloudflare protection
                </MenuItem>
                <MenuLabel>Investigate</MenuLabel>
                <MenuItem icon={<FileSearch />} hint="Look for attacks in server or cloud logs" onClick={() => setLaunch("threat_hunter")}>
                  Investigate logs
                </MenuItem>
                <MenuItem icon={<Network />} hint="Several agents, one linked report" onClick={() => setLaunch("coordinated")}>
                  Coordinated investigation
                </MenuItem>
              </Menu>
              <button
                type="button"
                onClick={() => setLaunch("audit")}
                disabled={!data}
                className="inline-flex h-10 items-center gap-2 rounded-xl bg-s-accent px-4 text-[14px] font-medium text-s-accent-ink shadow-[0_8px_24px_-12px_var(--s-accent)] transition hover:-translate-y-px hover:brightness-110 disabled:opacity-50"
              >
                <ScanSearch className="h-4 w-4" /> Security audit
              </button>
            </div>
          </div>

          {(error || team.error) && (
            <div role="alert" className="mt-6 flex items-center gap-3 rounded-2xl border border-s-line px-4 py-3 text-[14px]">
              <CircleAlert className="h-4 w-4 text-s-danger" /> <span className="flex-1">{error ?? team.error}</span>
              <button type="button" onClick={reloadAll} className="rounded-xl border border-s-line-strong px-3 py-1.5 text-[13px] hover:bg-s-hover">
                Try again
              </button>
            </div>
          )}

          <div className="mt-7 overflow-x-auto pb-1">
            <Segmented
              label="Security sections"
              value={tab}
              onChange={setTab}
              options={[
                { value: "overview", label: "Overview" },
                { value: "agents", label: "Agents" },
                { value: "findings", label: "Findings" },
                { value: "history", label: "History" },
                { value: "schedules", label: "Schedules" },
                { value: "setup", label: "Setup" },
              ]}
            />
          </div>

          <div className="mt-5 space-y-4">
            {tab === "overview" &&
              (!team.team || !data ? (
                <div className="grid gap-4 md:grid-cols-[1.4fr_1fr]">
                  <div className="glass s-skeleton h-56 rounded-[20px]" />
                  <div className="glass s-skeleton h-56 rounded-[20px]" />
                </div>
              ) : (
                <>
                  <div className="grid gap-4 md:grid-cols-[1.4fr_1fr]">
                    <PostureCard team={team.team} onSeverity={showFindings} />
                    <NextActions team={team.team} onLaunch={setLaunch} />
                  </div>
                  <TeamStrip team={team.team} onOpen={() => setTab("agents")} />
                  <div className="grid gap-4 md:grid-cols-[1.4fr_1fr]">
                    <section className="glass rounded-[20px] p-5" aria-labelledby="recent-runs">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <h2 id="recent-runs" className="text-[15px] font-semibold">
                          Recent checks
                        </h2>
                        {topRuns.length > 5 && (
                          <button type="button" onClick={() => setTab("history")} className="text-[13px] text-s-ink-2 underline underline-offset-2 hover:text-s-ink">
                            All {topRuns.length}
                          </button>
                        )}
                      </div>
                      <div className="mt-3">
                        {topRuns.length ? (
                          runList(topRuns.slice(0, 5))
                        ) : (
                          <p className="text-[13.5px] text-s-ink-2">Nothing has run yet. Start with a Security audit, or pick a single check from New check.</p>
                        )}
                      </div>
                      <div className="mt-3">
                        <MonitoringNote />
                      </div>
                    </section>
                    <RecentEvents team={team.team} />
                  </div>
                </>
              ))}

            {tab === "agents" &&
              (!team.team ? (
                <div className="glass s-skeleton h-72 rounded-[20px]" />
              ) : (
                <>
                  <AgentGrid team={team.team} />
                  <section aria-labelledby="engines" className="pt-4">
                    <h2 id="engines" className="text-[15px] font-semibold">
                      Engines and workspaces
                    </h2>
                    <p className="mb-3 mt-0.5 text-[12.5px] text-s-ink-3">The scanners and layers the agents run on, each with its own workspace.</p>
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                      {active.map((a) => {
                        const latest = data?.latest[a.id];
                        const workspace = a.id === "threat_hunter" ? "/agents/security/hunter" : a.id === "code_guardian" ? "/agents/security/guardian" : null;
                        return (
                          <article key={a.id} className="glass flex flex-col rounded-[18px] p-4">
                            <div className="flex items-start gap-3">
                              <AgentBadge agent={a.id} icon={a.icon} size="sm" />
                              <div className="min-w-0 flex-1">
                                <h3 className="text-[14.5px] font-medium">{a.name}</h3>
                                <p className="text-[12px] text-s-ink-3">{a.role}</p>
                              </div>
                              {latest ? (
                                <Link href={`/agents/security/runs/${latest.runId}`} title={`Last run ${fmtTime(latest.at)}`} className="rounded-lg px-1 hover:bg-s-hover">
                                  <RunStatus status={latest.status} />
                                </Link>
                              ) : (
                                <RunStatus status={null} />
                              )}
                            </div>
                            <p className="mt-2 text-[12.5px] leading-snug text-s-ink-2">{a.description}</p>
                            <ul className="mt-2 flex flex-wrap gap-1" aria-label="Tools">
                              {a.tools.map((id) => {
                                const t = toolById.get(id);
                                if (!t) return null;
                                return (
                                  <li key={id} title={t.available ? (t.reason ?? t.description) : t.reason} className={cn("inline-flex items-center gap-1 rounded-full border border-s-line px-2 py-0.5 text-[11px]", t.available ? "text-s-ink-2" : "text-s-ink-3")}>
                                    <span className={cn("h-1.5 w-1.5 rounded-full", t.available ? "bg-emerald-500" : "bg-s-ink-3/50")} aria-hidden />
                                    {t.name}
                                    <span className="sr-only">{t.available ? "available" : "not connected"}</span>
                                  </li>
                                );
                              })}
                            </ul>
                            <div className="mt-auto flex flex-wrap gap-2 pt-3">
                              <button type="button" onClick={() => setLaunch(a.id as LaunchMode)} className="inline-flex h-8 items-center gap-1.5 rounded-full border border-s-line-strong px-3 text-[12.5px] font-medium hover:bg-s-hover">
                                <Play className="h-3.5 w-3.5" /> {a.action?.label}
                              </button>
                              {workspace && (
                                <Link href={workspace} className="inline-flex h-8 items-center rounded-full px-3 text-[12.5px] text-s-ink-2 hover:bg-s-hover hover:text-s-ink">
                                  Open workspace
                                </Link>
                              )}
                            </div>
                          </article>
                        );
                      })}
                      {LAYERS.map((l) => (
                        <article key={l.id} className="glass flex flex-col rounded-[18px] p-4">
                          <div className="flex items-start gap-3">
                            <AgentBadge agent={l.id} icon={l.icon} size="sm" />
                            <div className="min-w-0 flex-1">
                              <h3 className="text-[14.5px] font-medium">{l.name}</h3>
                              <p className="text-[12px] text-s-ink-3">{l.role}</p>
                            </div>
                          </div>
                          <p className="mt-2 text-[12.5px] leading-snug text-s-ink-2">{l.description}</p>
                          <div className="mt-auto pt-3">
                            <Link href={l.href} className="inline-flex h-8 items-center gap-1 rounded-full border border-s-line-strong px-3 text-[12.5px] font-medium hover:bg-s-hover">
                              {l.action} <ChevronRight className="h-3.5 w-3.5" />
                            </Link>
                          </div>
                        </article>
                      ))}
                    </div>
                    {planned.length > 0 && (
                      <ul className="mt-3 space-y-1 text-[12.5px] text-s-ink-3">
                        {planned.map((a) => (
                          <li key={a.id}>
                            Planned: <span className="text-s-ink-2">{a.name}</span> — {a.description}
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                </>
              ))}

            {tab === "findings" && <FindingsPanel filters={filters} onFilters={setFilters} assets={data?.totals.assets ?? []} version={version} />}

            {tab === "history" &&
              (topRuns.length === 0 ? (
                <p className="rounded-[22px] border border-dashed border-s-line-strong px-6 py-10 text-center text-[14px] text-s-ink-2">No scans, audits or investigations yet.</p>
              ) : (
                runList(topRuns)
              ))}

            {tab === "schedules" &&
              (!team.team || !team.sched ? <div className="glass s-skeleton h-56 rounded-[20px]" /> : <ScheduleManager sched={team.sched} integrations={team.team.integrations} onChanged={team.reload} />)}

            {tab === "setup" && (
              <div className="space-y-8">
                {team.team && <Integrations team={team.team} />}
                {data && (
                  <section aria-labelledby="websites">
                    <h2 id="websites" className="text-[15px] font-semibold">
                      Websites
                    </h2>
                    <p className="mb-3 mt-0.5 text-[12.5px] text-s-ink-3">Websites Sentinel may scan. Ownership is proved with a token and re-checked before every scan.</p>
                    {data.targets.length === 0 ? (
                      <p className="rounded-[22px] border border-dashed border-s-line-strong px-6 py-8 text-center text-[14px] text-s-ink-2">No websites yet.</p>
                    ) : (
                      <ul className="space-y-2">
                        {data.targets.map((t) => (
                          <li key={t.id} className="glass flex items-center gap-3 rounded-2xl px-4 py-3">
                            <span className="min-w-0 flex-1 truncate text-[14px]">{t.hostname}</span>
                            {t.verified_at ? (
                              <span className="inline-flex items-center gap-1 text-[12.5px] text-emerald-600 dark:text-emerald-400">
                                <ShieldCheck className="h-4 w-4" /> Verified {fmtTime(t.verified_at)}
                              </span>
                            ) : (
                              <span className="text-[12.5px] text-s-ink-3">Not verified</span>
                            )}
                            <button
                              type="button"
                              aria-label={`Remove ${t.hostname}`}
                              onClick={async () => {
                                if (!window.confirm(`Remove ${t.hostname}? You'll need to verify it again to scan it.`)) return;
                                try {
                                  await jsonFetch(`/api/security/targets/${t.id}`, { method: "DELETE" });
                                  await refreshTargets();
                                } catch (e) {
                                  setError((e as Error).message);
                                }
                              }}
                              className="rounded-lg p-1.5 text-s-ink-3 hover:bg-s-hover hover:text-s-ink"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <button type="button" onClick={() => setLaunch("sentinel")} className="mt-3 inline-flex h-9 items-center rounded-xl border border-s-line-strong px-3.5 text-[13px] font-medium hover:bg-s-hover">
                      Add or verify a website
                    </button>
                  </section>
                )}
                {data && (
                  <section aria-labelledby="scanners">
                    <h2 id="scanners" className="text-[15px] font-semibold">
                      Scanners and data sources
                    </h2>
                    <p className="mb-3 mt-0.5 text-[12.5px] text-s-ink-3">What the agents can use on this site. Anything not connected is reported as not checked, never simulated.</p>
                    <ul className="grid gap-2 md:grid-cols-2">
                      {data.tools.map((t) => (
                        <li key={t.id} className="glass rounded-2xl px-4 py-3">
                          <div className="flex items-center gap-2">
                            <span className={cn("h-2 w-2 rounded-full", t.available ? "bg-emerald-500" : "bg-s-ink-3/50")} aria-hidden />
                            <span className="text-[14px] font-medium">{t.name}</span>
                            <span className="ml-auto text-[11.5px] text-s-ink-3">{t.available ? (t.kind === "builtin" ? "Built in" : "Connected") : "Not connected"}</span>
                          </div>
                          <p className="mt-1 text-[12.5px] text-s-ink-2">{t.description}</p>
                          {(t.reason || (!t.available && t.envVars.length > 0)) && <p className="mt-1 text-[12px] text-s-ink-3">{t.reason ?? `Needs ${t.envVars.join(", ")}`}</p>}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      <Launcher mode={launch} onClose={() => setLaunch(null)} targets={data?.targets ?? []} onTargetsChanged={refreshTargets} onFinished={reloadAll} />
    </>
  );
}
