"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowLeft, Check, ChevronRight, CircleAlert, SkipForward } from "lucide-react";
import { StudioHeader } from "@/components/studio/frame";
import { jsonFetch } from "@/hooks/use-ndjson";
import { MODE_INFO, type AuditMode } from "@/lib/security/audit";
import type { StoredAnalysis } from "@/lib/security/audit-report";
import type { CompactCodeMap } from "@/lib/security/code-map";
import type { EndpointResult } from "@/lib/security/crawl";
import { classify, type FindingLike } from "@/lib/security/details";
import type { Surface } from "@/lib/security/surface";
import { AttackPaths, ClassificationBadge, CodeMapView, Coverage, GateBanner, MonitoringNote, PostureStrip, SurfaceMap } from "./audit-views";
import { AGENT_NAME, AgentBadge, FindingStatus, fmtTime, ICON_OF, ReportBlock, RunStatus, SeverityBadge } from "./bits";
import type { FindingSummary } from "./findings-panel";

interface Run {
  id: string;
  parent_id: string | null;
  agent: string;
  action: string;
  status: string;
  asset: string | null;
  scope: string | null;
  tools: { tool: string; status: string; detail: string; durationMs?: number }[];
  summary: string | null;
  model_id: string | null;
  stats: {
    timeline?: { time: string | null; ip: string | null; label: string; ref: string }[];
    linkNotes?: string[];
    audit?: { mode: AuditMode; active: boolean; timeBudget: string };
    surface?: Surface & { trimmed?: string[] };
    endpointResults?: EndpointResult[];
    codeMap?: CompactCodeMap;
    [k: string]: unknown;
  };
  error: string | null;
  started_at: string;
  finished_at: string | null;
}
interface Detail {
  run: Run;
  children: Run[];
  findings: (FindingSummary & { run_id: string | null; last_run_id: string | null })[];
  history: { id: number; action: string; created_at: string }[];
}

const SEV_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

export function RunView({ id }: { id: string }) {
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    jsonFetch<Detail>(`/api/security/runs/${id}`)
      .then((d) => alive && setData(d))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [id]);

  const header = (
    <StudioHeader>
      <Link href="/agents/security" className="inline-flex items-center gap-1.5 text-[14px] text-s-ink-2 transition hover:text-s-ink">
        <ArrowLeft className="h-4 w-4" /> Security
      </Link>
      <span className="text-s-ink-3">/</span>
      <span className="text-[14px] font-medium">Results</span>
    </StudioHeader>
  );
  if (error)
    return (
      <>
        {header}
        <div role="alert" className="mx-auto mt-16 flex max-w-md flex-col items-center px-6 text-center">
          <CircleAlert className="h-6 w-6 text-s-danger" />
          <h1 className="mt-3 text-[15px] font-normal">{error}</h1>
        </div>
      </>
    );
  if (!data)
    return (
      <>
        {header}
        <div className="mx-auto w-full max-w-[1000px] space-y-3 px-4 pt-6 sm:px-8">
          <div className="s-skeleton h-10 w-1/2 rounded-xl" />
          <div className="s-skeleton h-48 rounded-2xl" />
        </div>
      </>
    );

  const { run, children } = data;
  const findings = [...data.findings].sort((a, b) => SEV_RANK[a.severity]! - SEV_RANK[b.severity]!);
  const allRuns = [run, ...children];
  const auditMode = run.stats.audit?.mode;
  // Present once the audit's report step has run (the analysis is stored with the parent run).
  const analysis = auditMode && run.stats.posture ? (run.stats as unknown as StoredAnalysis) : null;
  const asLike = findings as unknown as (FindingLike & { id: string })[];
  return (
    <>
      {header}
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1000px] space-y-5 px-4 pb-24 pt-2 sm:px-8">
          <div className="s-in flex items-start gap-3.5">
            <AgentBadge agent={run.agent} icon={ICON_OF[run.agent]!} />
            <div className="min-w-0 flex-1">
              <h1 className="text-[clamp(22px,3vw,28px)] font-semibold tracking-[-0.01em]">{auditMode ? `Sentinel · ${MODE_INFO[auditMode].label}` : `${AGENT_NAME[run.agent]} · ${run.action}`}</h1>
              <p className="mt-1 text-[13px] text-s-ink-2">
                {run.asset}
                {run.scope ? ` · ${run.scope === "active" ? "active read-only testing" : "passive checks only"}` : ""} · started {fmtTime(run.started_at)}
                {run.finished_at ? ` · finished ${fmtTime(run.finished_at)}` : ""}
                {run.model_id ? ` · AI: ${run.model_id}` : ""}
              </p>
            </div>
            <RunStatus status={run.status} />
          </div>
          {run.parent_id && (
            <Link href={`/agents/security/runs/${run.parent_id}`} className="inline-flex text-[13px] text-s-ink-2 underline underline-offset-2">
              Part of a coordinated investigation or audit
            </Link>
          )}
          {analysis?.gate && <GateBanner gate={analysis.gate} />}
          {auditMode && !analysis && run.status !== "running" && (
            <p className="rounded-xl border border-s-line px-3 py-2 text-[13.5px] text-s-ink-2">
              This audit didn&apos;t reach its analysis step, so there are no attack paths, coverage or gate result. The steps that ran and their findings are below.
            </p>
          )}
          {analysis && <PostureStrip analysis={analysis} />}
          {run.error && (
            <p role="alert" className="rounded-xl border border-s-line px-3 py-2 text-[13.5px] text-s-danger">
              {run.error}
            </p>
          )}

          <section className="glass rounded-[20px] p-5">
            <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-[0.06em] text-s-ink-3">Steps that ran</h2>
            {allRuns.every((r) => r.tools.length === 0) ? (
              <p className="text-[13.5px] text-s-ink-2">No steps recorded.</p>
            ) : (
              <div className="space-y-4">
                {allRuns
                  .filter((r) => r.tools.length)
                  .map((r) => (
                    <div key={r.id}>
                      {children.length > 0 && (
                        <Link href={`/agents/security/runs/${r.id}`} className="mb-1.5 flex items-center gap-2 text-[13px] font-medium hover:underline">
                          {r.id === run.id && auditMode ? "Sentinel audit" : AGENT_NAME[r.agent]} <RunStatus status={r.status} />
                        </Link>
                      )}
                      <ol className="space-y-1.5">
                        {r.tools.map((t, i) => (
                          <li key={i} className="flex items-start gap-2.5 text-[13.5px] [&_svg]:mt-0.5 [&_svg]:h-4 [&_svg]:w-4 [&_svg]:shrink-0">
                            {t.status === "ok" ? <Check className="text-emerald-500" /> : t.status === "skipped" ? <SkipForward className="text-s-ink-3" /> : <CircleAlert className="text-s-danger" />}
                            <span>
                              <span className="font-medium">{t.tool}</span>
                              {typeof t.durationMs === "number" && <span className="text-s-ink-3"> · {(t.durationMs / 1000).toFixed(1)}s</span>}
                              <span className="block text-[12.5px] text-s-ink-2">{t.detail}</span>
                            </span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  ))}
                {children.length > 0 && (
                  <p className="text-[12.5px] text-s-ink-3">
                    Agents in this investigation: {children.map((c) => `${AGENT_NAME[c.agent]} (${c.status})`).join(", ")}. Agents that aren’t listed did not run.
                  </p>
                )}
              </div>
            )}
          </section>

          {run.summary ? <ReportBlock text={run.summary} title={children.length ? "Unified report" : "AI report"} /> : run.status === "completed" && <p className="text-[13px] text-s-ink-3">No AI report for this run (no AI model was available or the call failed). Scanner results are below.</p>}
          {children
            .filter((c) => c.summary)
            .map((c) => (
              <ReportBlock key={c.id} text={c.summary!} title={`${AGENT_NAME[c.agent]} report`} />
            ))}

          {analysis && <AttackPaths paths={analysis.paths} />}
          {analysis && <Coverage coverage={analysis.coverage} />}
          {allRuns
            .filter((r) => r.stats.surface)
            .map((r) => (
              <SurfaceMap key={`s-${r.id}`} surface={r.stats.surface!} endpointResults={r.stats.endpointResults} />
            ))}
          {allRuns
            .filter((r) => r.stats.codeMap)
            .map((r) => (
              <CodeMapView key={`c-${r.id}`} map={r.stats.codeMap!} />
            ))}
          {auditMode && <MonitoringNote />}

          {(run.stats.linkNotes?.length ?? 0) > 0 && (
            <section className="glass rounded-[20px] p-5">
              <h2 className="mb-2 text-[13px] font-semibold uppercase tracking-[0.06em] text-s-ink-3">Connected findings</h2>
              <ul className="list-disc space-y-1 pl-5 text-[13.5px] text-s-ink-2">
                {run.stats.linkNotes!.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
              <p className="mt-2 text-[12px] text-s-ink-3">Leads to check, not proof of exploitation.</p>
            </section>
          )}

          {[run, ...children].some((r) => r.stats.timeline?.length) && (
            <section className="glass rounded-[20px] p-5">
              <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-[0.06em] text-s-ink-3">Timeline from the logs</h2>
              <ol className="relative space-y-2 border-l border-s-line pl-4">
                {[run, ...children]
                  .flatMap((r) => r.stats.timeline ?? [])
                  .map((e, i) => (
                    <li key={i} className="text-[13px]">
                      <span className="absolute -left-[4.5px] mt-1.5 h-2 w-2 rounded-full bg-s-ink-3" aria-hidden />
                      <span className="text-s-ink-3">{e.time ? new Date(e.time).toLocaleString() : "time unknown"}</span> · <span className="font-mono text-[12px]">{e.ip}</span> · {e.label} <span className="text-[11.5px] text-s-ink-3">({e.ref})</span>
                    </li>
                  ))}
              </ol>
            </section>
          )}

          <section>
            <h2 className="mb-3 text-[15px] font-semibold">Findings ({findings.length})</h2>
            {findings.length === 0 ? (
              <p className="rounded-[20px] border border-dashed border-s-line-strong px-6 py-8 text-center text-[14px] text-s-ink-2">
                {run.status === "completed"
                  ? `Nothing was found by the checks that ran. That isn't proof the application is secure${analysis ? " — see Coverage above for what wasn't assessed" : ""}.`
                  : "No findings were saved."}
              </p>
            ) : (
              <ul className="space-y-2">
                {findings.map((f) => (
                  <li key={f.id}>
                    <Link href={`/agents/security/findings/${f.id}`} className="glass group flex items-center gap-3 rounded-2xl px-4 py-3 transition hover:border-s-line-strong">
                      <AgentBadge agent={f.agent} icon={ICON_OF[f.agent]!} size="sm" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[14px] font-medium">{f.title}</p>
                        <p className="truncate text-[12.5px] text-s-ink-3">
                          {f.location ?? f.asset} · {f.evidence_source}
                          {f.run_id !== run.id && !children.some((c) => c.id === f.run_id) ? " · seen before" : " · new"}
                        </p>
                      </div>
                      <div className="hidden items-center gap-1.5 sm:flex">
                        <SeverityBadge severity={f.severity} />
                        <ClassificationBadge value={classify(f as unknown as FindingLike, asLike)} />
                        <FindingStatus status={f.status} />
                      </div>
                      <div className="sm:hidden">
                        <SeverityBadge severity={f.severity} />
                      </div>
                      <ChevronRight className="h-4 w-4 text-s-ink-3" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {data.history.length > 0 && (
            <section className="text-[12.5px] text-s-ink-3">
              <h2 className="mb-1.5 font-medium text-s-ink-2">Audit trail</h2>
              <ol className="space-y-0.5">
                {data.history.map((h) => (
                  <li key={h.id}>
                    {fmtTime(h.created_at)} · {h.action}
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
