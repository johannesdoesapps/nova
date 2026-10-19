"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Check, ChevronRight, CircleAlert, Network, Play, ShieldCheck, Trash2 } from "lucide-react";
import { useApp } from "@/components/layout/app-context";
import { StudioHeader } from "@/components/studio/frame";
import { Segmented } from "@/components/studio/ui";
import { jsonFetch } from "@/hooks/use-ndjson";
import type { SecurityAgentDef } from "@/lib/security/agents";
import { cn } from "@/lib/utils";
import { AGENT_NAME, AgentBadge, fmtTime, ICON_OF, RunStatus, SEVERITY_DOT } from "./bits";
import { EMPTY_FILTERS, FindingsPanel, type FindingFilters } from "./findings-panel";
import type { Target } from "./forms";
import { Launcher, type LaunchMode } from "./launcher";

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
  stats: { findings?: number };
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
  totals: { all: number; open: number; assets: string[] };
}

type Tab = "findings" | "history" | "targets" | "tools";

export function SecurityView() {
  const { user, integrations } = useApp();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [tab, setTab] = useState<Tab>("findings");
  const [filters, setFilters] = useState<FindingFilters>(EMPTY_FILTERS);
  const [launch, setLaunch] = useState<LaunchMode | null>(null);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const signedOut = integrations.supabase ? !user : true;

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

  return (
    <>
      {header}
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1180px] px-4 pb-24 pt-2 sm:px-8">
          <div className="s-in flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
            <div>
              <h1 className="font-serif text-[clamp(34px,5vw,46px)] leading-[1.05] tracking-[-0.01em]">Security Team</h1>
              <p className="mt-2 max-w-2xl text-[15.5px] text-s-ink-2">Three specialised agents that check what you own using real scanners and data, explain the results, and help you fix them. Nothing is changed without your approval.</p>
            </div>
            <button
              type="button"
              onClick={() => setLaunch("coordinated")}
              disabled={!data}
              className="inline-flex h-10 items-center gap-2 rounded-xl bg-s-accent px-4 text-[14px] font-medium text-s-accent-ink shadow-[0_8px_24px_-12px_var(--s-accent)] transition hover:-translate-y-px hover:brightness-110 disabled:opacity-50"
            >
              <Network className="h-4 w-4" /> Coordinated investigation
            </button>
          </div>

          {error && (
            <div role="alert" className="mt-6 flex items-center gap-3 rounded-2xl border border-s-line px-4 py-3 text-[14px]">
              <CircleAlert className="h-4 w-4 text-s-danger" /> <span className="flex-1">{error}</span>
              <button type="button" onClick={reload} className="rounded-xl border border-s-line-strong px-3 py-1.5 text-[13px] hover:bg-s-hover">
                Try again
              </button>
            </div>
          )}

          <div className="mt-7 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {!data
              ? [0, 1, 2].map((i) => <div key={i} className="glass s-skeleton h-[330px] rounded-[22px]" />)
              : active.map((a, i) => {
                  const latest = data.latest[a.id];
                  return (
                    <article key={a.id} className="glass relative flex flex-col rounded-[22px] p-5 transition duration-300 hover:border-s-line-strong hover:shadow-[var(--s-shadow)]" style={{ animation: `s-in .34s cubic-bezier(.2,.7,.2,1) ${i * 50}ms both` }}>
                      <div className="flex items-start gap-3.5">
                        <AgentBadge agent={a.id} icon={a.icon} />
                        <div className="min-w-0 flex-1">
                          <h2 className="text-[16px] font-semibold tracking-[-0.01em]">{a.name}</h2>
                          <p className="text-[12.5px] text-s-ink-3">{a.role}</p>
                        </div>
                        {latest ? (
                          <Link href={`/agents/security/runs/${latest.runId}`} title={`Last run ${fmtTime(latest.at)}`} className="rounded-lg px-1.5 py-0.5 hover:bg-s-hover">
                            <RunStatus status={latest.status} />
                          </Link>
                        ) : (
                          <RunStatus status={null} />
                        )}
                      </div>
                      <p className="mt-3.5 text-[13.5px] leading-relaxed text-s-ink-2">{a.description}</p>
                      <ul className="mt-3 space-y-1">
                        {a.capabilities.map((c) => (
                          <li key={c} className="flex items-start gap-2 text-[12.5px] text-s-ink-2">
                            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-s-ink-3" /> {c}
                          </li>
                        ))}
                      </ul>
                      <ul className="mt-4 flex flex-wrap gap-1.5" aria-label="Tools">
                        {a.tools.map((id) => {
                          const t = toolById.get(id);
                          if (!t) return null;
                          return (
                            <li key={id} title={t.available ? (t.reason ?? t.description) : t.reason} className={cn("inline-flex items-center gap-1.5 rounded-full border border-s-line px-2.5 py-1 text-[11.5px]", t.available ? "text-s-ink-2" : "text-s-ink-3")}>
                              <span className={cn("h-1.5 w-1.5 rounded-full", t.available ? "bg-emerald-500" : "bg-s-ink-3/50")} aria-hidden />
                              {t.name}
                              <span className="sr-only">{t.available ? "available" : "not connected"}</span>
                            </li>
                          );
                        })}
                      </ul>
                      <div className="mt-auto pt-5">
                        <button type="button" onClick={() => setLaunch(a.id as LaunchMode)} className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-s-line-strong text-[14px] font-medium transition hover:border-transparent hover:bg-s-accent hover:text-s-accent-ink">
                          <Play className="h-4 w-4" /> {a.action?.label}
                        </button>
                      </div>
                    </article>
                  );
                })}
          </div>

          {planned.length > 0 && (
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {planned.map((a) => (
                <div key={a.id} className="flex items-start gap-3 rounded-[18px] border border-dashed border-s-line-strong px-4 py-3.5 opacity-80">
                  <AgentBadge agent={a.id} icon={a.icon} size="sm" />
                  <div className="min-w-0">
                    <p className="text-[13.5px] font-medium">
                      {a.name} <span className="ml-1 rounded-full border border-s-line px-2 py-0.5 text-[11px] font-normal text-s-ink-3">Planned</span>
                    </p>
                    <p className="mt-0.5 text-[12.5px] text-s-ink-3">{a.description}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          {data && (
            <section className="glass mt-8 rounded-[22px] p-5" aria-labelledby="open-findings">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 id="open-findings" className="text-[15px] font-semibold">
                  Open findings
                </h2>
                <p className="text-[12px] text-s-ink-3">Findings not yet fixed, accepted or marked false positive, counted by severity. No overall score is calculated.</p>
              </div>
              <div className="mt-4 grid grid-cols-5 gap-2">
                {(["critical", "high", "medium", "low", "info"] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => {
                      setTab("findings");
                      setFilters({ ...EMPTY_FILTERS, severity: s, status: "open" });
                    }}
                    className="rounded-2xl border border-s-line px-2 py-3 text-center transition hover:bg-s-hover"
                  >
                    <span className="block text-[22px] font-semibold tabular-nums">{data.openCounts[s] ?? 0}</span>
                    <span className="mt-0.5 inline-flex items-center gap-1.5 text-[12px] capitalize text-s-ink-2">
                      <span className={cn("h-2 w-2 rounded-full", SEVERITY_DOT[s])} /> {s}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}

          <div className="mt-8">
            <Segmented
              label="Security sections"
              value={tab}
              onChange={setTab}
              options={[
                { value: "findings", label: "Findings" },
                { value: "history", label: "History" },
                { value: "targets", label: "Websites" },
                { value: "tools", label: "Tools" },
              ]}
            />
            <div className="mt-5">
              {tab === "findings" && <FindingsPanel filters={filters} onFilters={setFilters} assets={data?.totals.assets ?? []} version={version} />}
              {tab === "history" &&
                (topRuns.length === 0 ? (
                  <p className="rounded-[22px] border border-dashed border-s-line-strong px-6 py-10 text-center text-[14px] text-s-ink-2">No scans, investigations or audits yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {topRuns.map((r) => (
                      <li key={r.id}>
                        <Link href={`/agents/security/runs/${r.id}`} className="glass group flex items-center gap-3 rounded-2xl px-4 py-3 transition hover:border-s-line-strong">
                          <AgentBadge agent={r.agent} icon={ICON_OF[r.agent]!} size="sm" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[14px] font-medium">
                              {AGENT_NAME[r.agent]} · {r.action}
                              {r.scope ? ` (${r.scope})` : ""}
                            </p>
                            <p className="truncate text-[12.5px] text-s-ink-3">
                              {r.asset ?? "—"} · {fmtTime(r.started_at)}
                              {typeof r.stats?.findings === "number" ? ` · ${r.stats.findings} findings` : ""}
                              {childCount(r.id) ? ` · ${childCount(r.id)} agent runs` : ""}
                              {r.error ? ` · ${r.error}` : ""}
                            </p>
                          </div>
                          <RunStatus status={r.status} />
                          <ChevronRight className="h-4 w-4 text-s-ink-3" />
                        </Link>
                      </li>
                    ))}
                  </ul>
                ))}
              {tab === "targets" && data && (
                <div className="space-y-3">
                  <p className="text-[13.5px] text-s-ink-2">Websites Nova Sentinel may scan. Ownership is proved with a token and re-checked before every scan.</p>
                  {data.targets.length === 0 ? (
                    <p className="rounded-[22px] border border-dashed border-s-line-strong px-6 py-8 text-center text-[14px] text-s-ink-2">No websites yet. Add one from Scan website.</p>
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
                              await jsonFetch(`/api/security/targets/${t.id}`, { method: "DELETE" });
                              await refreshTargets();
                            }}
                            className="rounded-lg p-1.5 text-s-ink-3 hover:bg-s-hover hover:text-s-ink"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <button type="button" onClick={() => setLaunch("sentinel")} className="inline-flex h-9 items-center rounded-xl border border-s-line-strong px-3.5 text-[13px] font-medium hover:bg-s-hover">
                    Add or verify a website
                  </button>
                </div>
              )}
              {tab === "tools" && data && (
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
              )}
            </div>
          </div>
        </div>
      </div>
      <Launcher mode={launch} onClose={() => setLaunch(null)} targets={data?.targets ?? []} onTargetsChanged={refreshTargets} onFinished={reload} />
    </>
  );
}
