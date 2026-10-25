"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowLeft, Check, ChevronRight, CircleAlert, SkipForward } from "lucide-react";
import { StudioHeader } from "@/components/studio/frame";
import { cn } from "@/lib/utils";
import { jsonFetch } from "@/hooks/use-ndjson";
import { MODE_INFO, type AuditMode } from "@/lib/security/audit";
import type { StoredAnalysis } from "@/lib/security/audit-report";
import type { CompactCodeMap } from "@/lib/security/code-map";
import type { EndpointResult } from "@/lib/security/crawl";
import { classify, type FindingLike } from "@/lib/security/details";
import type { Surface } from "@/lib/security/surface";
import { engineeringKind, isEngineering, KIND_LABEL } from "@/lib/security/guardian/categories";
import type { FileInventory } from "@/lib/security/hunt/events";
import type { IndicatorRecord } from "@/lib/security/hunt/intel";
import type { Investigation } from "@/lib/security/hunt/investigate";
import type { QaIssue } from "@/lib/security/hunt/qa";
import { AttackPaths, ClassificationBadge, CodeMapView, Coverage, GateBanner, MonitoringNote, PostureStrip, SurfaceMap } from "./audit-views";
import { IntelRecords, InvestigationList, QaNotes, SourceCoverage } from "./hunt-views";
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
    investigations?: Investigation[];
    investigationsTrimmed?: string[];
    inventory?: FileInventory[];
    baselines?: { newSource: { assessed: number; insufficient: number } } | null;
    sharedAddresses?: string[];
    intel?: IndicatorRecord[];
    qa?: QaIssue[];
    [k: string]: unknown;
  };
  error: string | null;
  started_at: string;
  finished_at: string | null;
}
interface Detail {
  run: Run;
  children: Run[];
  findings: (FindingSummary & { run_id: string | null; last_run_id: string | null; rule_id: string })[];
  history: { id: number; action: string; detail?: Record<string, unknown> | null; created_at: string }[];
}

interface PrStats {
  repo: string;
  number: number;
  url: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  changedFiles: number;
  filesTruncated: boolean;
  patchesMissing: number;
  introduced: number;
  existing: number;
}
interface VerificationStats {
  model: string;
  counts: Record<"confirmed" | "likely" | "unverified" | "disproven", number>;
}

/** What a pull-request audit covered, plus posting its summary on the pull request (only after the person confirms). */
function PrPanel({ runId, pr, done, postedUrl }: { runId: string; pr: PrStats; done: boolean; postedUrl: string | null }) {
  const [state, setState] = useState<{ phase: "idle" | "confirm" | "posting" | "posted" | "error"; url?: string; error?: string }>(postedUrl ? { phase: "posted", url: postedUrl } : { phase: "idle" });
  const post = async () => {
    setState({ phase: "posting" });
    try {
      const r = await jsonFetch<{ url: string }>(`/api/security/runs/${runId}/pr-comment`, { method: "POST", body: JSON.stringify({ confirm: true }) });
      setState({ phase: "posted", url: r.url });
    } catch (e) {
      setState({ phase: "error", error: (e as Error).message });
    }
  };
  return (
    <section className="glass rounded-[20px] p-5">
      <h2 className="mb-2 text-[13px] font-semibold uppercase tracking-[0.06em] text-s-ink-3">Pull request</h2>
      <p className="text-[14px]">
        <a href={pr.url} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-2">
          {pr.repo}#{pr.number}
        </a>{" "}
        <span className="text-s-ink-2">
          · {pr.headRef} → {pr.baseRef} · commit {pr.headSha.slice(0, 7)}
        </span>
      </p>
      <p className="mt-1.5 text-[13.5px] text-s-ink-2">
        {pr.changedFiles} changed file{pr.changedFiles === 1 ? "" : "s"} checked. {pr.introduced} finding{pr.introduced === 1 ? "" : "s"} on lines this pull request adds, {pr.existing} in code it touches but didn&apos;t add.
        {pr.filesTruncated ? " GitHub listed more changed files than Orbis reads (300), so some weren't checked." : ""}
        {pr.patchesMissing ? ` GitHub didn't provide the diff for ${pr.patchesMissing} file(s), so new and existing findings there aren't told apart.` : ""} Findings in files the pull request doesn&apos;t change aren&apos;t reported here.
      </p>
      {done && (
        <div className="mt-3">
          {state.phase === "posted" ? (
            <p className="text-[13.5px]">
              Summary posted.{" "}
              <a href={state.url} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                View the comment on GitHub
              </a>
            </p>
          ) : state.phase === "confirm" || state.phase === "posting" ? (
            <div className="rounded-xl border border-s-line p-3 text-[13.5px]">
              <p>
                Post a comment on {pr.repo}#{pr.number} as you, through your GitHub connection? Everyone who can see the pull request will see it. It lists titles, severities and file locations only (no evidence, code or secrets), and a link to this page.
              </p>
              <div className="mt-2.5 flex gap-2">
                <button type="button" disabled={state.phase === "posting"} onClick={() => void post()} className="h-9 rounded-full bg-s-accent px-4 text-[13px] font-medium text-s-accent-ink disabled:opacity-60">
                  {state.phase === "posting" ? "Posting…" : "Post comment"}
                </button>
                <button type="button" disabled={state.phase === "posting"} onClick={() => setState({ phase: "idle" })} className="h-9 rounded-full border border-s-line px-4 text-[13px]">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <button type="button" onClick={() => setState({ phase: "confirm" })} className="h-9 rounded-full border border-s-line px-4 text-[13px] font-medium transition hover:bg-s-hover">
                Post summary to the pull request…
              </button>
              {state.phase === "error" && (
                <p role="alert" className="mt-2 text-[13px] text-s-danger">
                  {state.error}
                </p>
              )}
              <p className="mt-1.5 text-[12.5px] text-s-ink-3">Needs GitHub connected with write access (Pull requests: write). Nothing is posted until you confirm.</p>
            </>
          )}
        </div>
      )}
    </section>
  );
}

interface DeployStats {
  vercel: {
    project: string;
    teamId: string | null;
    framework: string | null;
    nodeVersion: string | null;
    repo: string | null;
    protection: { vercelAuth: string | null; password: string | null; forkProtection: boolean | null; publicSource: boolean | null; bypassSecrets: number; firewall: boolean | null };
    envs: { total: number; byType: Record<string, number>; public: number };
    domains: { name: string; verified: boolean; redirect: string | null }[];
    production: { state: string; commit: string | null; branch: string | null; created: number } | null;
    checkedHost: string | null;
    missing: string[];
  };
  deployGate: { decision: "allow" | "warn" | "block" | "incomplete"; mode: string; blockSeverities: string[]; reasons: string[]; blocking: { id: string; title: string; severity: string }[]; considered: { deployment: number; repository: number } };
}

const DECISION: Record<DeployStats["deployGate"]["decision"], { label: string; cls: string }> = {
  allow: { label: "Allow", cls: "text-emerald-600 dark:text-emerald-400" },
  warn: { label: "Warn", cls: "text-amber-600 dark:text-amber-400" },
  block: { label: "Block", cls: "text-s-danger" },
  incomplete: { label: "Incomplete — not a pass", cls: "text-amber-600 dark:text-amber-400" },
};

/** Vercel deployment audit: the advisory gate decision, then the settings Orbis read (never variable values). */
function DeploymentPanel({ s }: { s: DeployStats }) {
  const v = s.vercel;
  const g = s.deployGate;
  const onOff = (b: boolean | null) => (b == null ? "not reported" : b ? "on" : "off");
  const rows: [string, string][] = [
    ["Project", `${v.project}${v.framework ? ` (${v.framework})` : ""}`],
    ["Repository", v.repo ?? "not linked"],
    ["Vercel Authentication", v.protection.vercelAuth ?? "off"],
    ["Password protection", v.protection.password ?? "off"],
    ["Fork protection", onOff(v.protection.forkProtection)],
    ["Public source", onOff(v.protection.publicSource)],
    ["Node.js", v.nodeVersion ?? "not reported"],
    ["Bypass secrets", String(v.protection.bypassSecrets)],
    ["Environment variables", `${v.envs.total} (${Object.entries(v.envs.byType).map(([k, n]) => `${n} ${k}`).join(", ") || "none"}; ${v.envs.public} browser-exposed), names only`],
    ["Production", v.production ? `${v.production.state.toLowerCase()}${v.production.branch ? ` from ${v.production.branch}` : ""}${v.production.commit ? ` @ ${v.production.commit.slice(0, 7)}` : ""}` : "no recent production deployment"],
    ["Live site checked", v.checkedHost ?? "none"],
  ];
  return (
    <section className="glass rounded-[20px] p-5">
      <h2 className="mb-2 text-[13px] font-semibold uppercase tracking-[0.06em] text-s-ink-3">Deploy gate</h2>
      <p className={cn("text-[18px] font-semibold", DECISION[g.decision].cls)}>{DECISION[g.decision].label}</p>
      <p className="mt-1 text-[13.5px] text-s-ink-2">
        {g.mode === "block" ? "Blocking" : "Warning"} mode on open {g.blockSeverities.join("/")} findings that are confirmed or likely ({g.considered.deployment} from this audit, {g.considered.repository} open in the linked repository). Advisory: Orbis doesn&apos;t stop builds on Vercel.
      </p>
      {g.reasons.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[13px] text-s-ink-2">
          {g.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
      {g.blocking.length > 0 && (
        <ul className="mt-2 space-y-1 text-[13.5px]">
          {g.blocking.map((b) => (
            <li key={b.id} className="flex items-center gap-2">
              <SeverityBadge severity={b.severity} /> {b.title}
            </li>
          ))}
        </ul>
      )}
      <dl className="mt-4 grid gap-x-6 gap-y-1.5 text-[13px] sm:grid-cols-2">
        {rows.map(([k, val]) => (
          <div key={k}>
            <dt className="inline text-s-ink-3">{k}: </dt>
            <dd className="inline">{val}</dd>
          </div>
        ))}
      </dl>
      {v.missing.length > 0 && <p className="mt-3 text-[13px] text-s-danger">Not read, so not assessed: {v.missing.join("; ")}.</p>}
    </section>
  );
}

interface CloudflareStats {
  complete: boolean;
  cloudflare: {
    zones: { name: string; plan: string; status: string; coverage: Record<string, string>; ssl: string | null; alwaysHttps: string | null; minTls: string | null; waf: string[] | null; customRules: number | null; rateLimits: number | null; ddos: string | null; botFightMode: boolean | null; dnsOnly: number | null; events: { action: string; source: string; count: number }[] | null }[];
    accounts: { name: string; status: string; apps: number; fix: string | null }[];
    gaps: { scope: string; area: string; status: string; fix: string | null }[];
  };
}

const CF_AREAS: [string, string][] = [
  ["tls", "TLS/HTTPS"],
  ["waf", "WAF"],
  ["ratelimit", "Rate limiting"],
  ["ddos", "HTTP DDoS"],
  ["bot", "Bots"],
  ["dns", "DNS proxying"],
  ["events", "Events (24h)"],
];

/** Cloudflare review: what was checked per zone, what the settings are, and what couldn't be read (never "secure"). */
function CloudflarePanel({ s }: { s: CloudflareStats }) {
  const c = s.cloudflare;
  const shown = (v: string | number | boolean | null | undefined, fmt?: (x: never) => string) => (v == null ? "not checked" : fmt ? fmt(v as never) : String(v));
  return (
    <section className="glass rounded-[20px] p-5">
      <h2 className="mb-2 text-[13px] font-semibold uppercase tracking-[0.06em] text-s-ink-3">Cloudflare coverage</h2>
      {s.complete ? (
        <p className="text-[13.5px] text-s-ink-2">Every area was read for the zones below.</p>
      ) : (
        <div className="rounded-xl border border-amber-500/40 p-3 text-[13.5px]">
          <p className="font-medium">Incomplete review: some areas couldn&apos;t be read, so nothing is said about them.</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-s-ink-2">
            {c.gaps.map((g, i) => (
              <li key={i}>
                {g.scope}: {g.area} — {g.fix ? `add “${g.fix}” to the token` : g.status.replace("_", " ")}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-4 space-y-4">
        {c.zones.map((z) => (
          <div key={z.name}>
            <p className="text-[14px] font-medium">
              {z.name} <span className="font-normal text-s-ink-3">· {z.plan} · {z.status}</span>
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {CF_AREAS.map(([k, label]) => (
                <span key={k} className={cn("rounded-full border px-2 py-0.5 text-[12px]", z.coverage[k] === "checked" ? "border-s-line text-s-ink-2" : "border-amber-500/50 text-amber-700 dark:text-amber-300")}>
                  {label}: {z.coverage[k] === "checked" ? "checked" : (z.coverage[k] ?? "not checked").replace("_", " ")}
                </span>
              ))}
            </div>
            <p className="mt-1.5 text-[13px] text-s-ink-2">
              SSL mode {shown(z.ssl)} · Always HTTPS {shown(z.alwaysHttps)} · minimum TLS {shown(z.minTls)} · managed WAF {z.waf == null ? "not checked" : z.waf.length ? z.waf.join(", ") : "none"} · custom rules {shown(z.customRules)} · rate limits {shown(z.rateLimits)} · HTTP DDoS{" "}
              {shown(z.ddos)} · Bot Fight Mode {shown(z.botFightMode, (b: boolean) => (b ? "on" : "off"))} · DNS-only records {shown(z.dnsOnly)}
            </p>
            {z.events && z.events.length > 0 && <p className="mt-1 text-[12.5px] text-s-ink-3">Last 24 h: {z.events.map((e) => `${e.count} ${e.action} (${e.source})`).join(", ")}</p>}
          </div>
        ))}
        {c.accounts.length > 0 && (
          <p className="text-[13px] text-s-ink-2">
            Zero Trust Access: {c.accounts.map((a) => `${a.name} — ${a.status === "checked" ? `${a.apps} application(s) reviewed` : `not checked${a.fix ? ` (needs ${a.fix})` : ""}`}`).join("; ")}. Orbis never changes Access policies.
          </p>
        )}
      </div>
    </section>
  );
}

function VerificationNote({ v }: { v: VerificationStats }) {
  const total = v.counts.confirmed + v.counts.likely + v.counts.unverified + v.counts.disproven;
  if (!total) return null;
  return (
    <p className="rounded-xl border border-s-line px-3 py-2 text-[13.5px] text-s-ink-2">
      Independent verification ({v.model}) re-checked {total} serious finding{total === 1 ? "" : "s"} against the surrounding code: {v.counts.confirmed} confirmed, {v.counts.likely} likely, {v.counts.unverified} unverified, {v.counts.disproven} disproven. Confirmed and disproven verdicts needed an exact quote from the code. Disproven findings are kept as false positives, and you can reopen them.
    </p>
  );
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
        <ArrowLeft className="h-4 w-4" aria-hidden /> <span className="max-sm:sr-only">Security</span>
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
  const sorted = [...data.findings].sort((a, b) => SEV_RANK[a.severity]! - SEV_RANK[b.severity]!);
  // Code Guardian's engineering findings (defects, dependencies, maintainability) are listed apart from security ones.
  const findings = sorted.filter((f) => !isEngineering(f.rule_id));
  const engineering = sorted.filter((f) => isEngineering(f.rule_id));
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
          {run.agent === "code_guardian" && run.stats.pr != null && (
            <PrPanel
              runId={run.id}
              pr={run.stats.pr as PrStats}
              done={run.status === "completed"}
              postedUrl={(data.history.find((h) => h.action === "pr.comment")?.detail?.url as string | undefined) ?? null}
            />
          )}
          {run.action === "cloudflare" && run.stats.cloudflare != null && <CloudflarePanel s={run.stats as unknown as CloudflareStats} />}
          {run.action === "deployment" && run.stats.deployGate != null && <DeploymentPanel s={run.stats as unknown as DeployStats} />}
          {run.stats.verification != null && <VerificationNote v={run.stats.verification as VerificationStats} />}
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

          {run.agent === "threat_hunter" && (run.stats.qa?.length ?? 0) > 0 && <QaNotes issues={run.stats.qa!} />}
          {run.agent === "threat_hunter" && run.stats.investigations && <InvestigationList runId={run.id} investigations={run.stats.investigations} trimmed={run.stats.investigationsTrimmed} />}
          {run.agent === "threat_hunter" && run.stats.inventory && <SourceCoverage inventory={run.stats.inventory} baselines={run.stats.baselines} shared={run.stats.sharedAddresses} />}
          {run.agent === "threat_hunter" && <IntelRecords records={run.stats.intel ?? []} />}
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

          {[run, ...children].some((r) => r.stats.timeline?.length && !r.stats.investigations) && (
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

          {engineering.length > 0 && (
            <section className="glass rounded-[20px] p-5">
              <h2 className="mb-1 text-[15px] font-semibold">Engineering findings ({engineering.length})</h2>
              <p className="mb-3 text-[12.5px] text-s-ink-3">
                {(["defect", "dependency", "maintainability"] as const)
                  .map((k) => `${engineering.filter((f) => engineeringKind(f.rule_id) === k).length} ${KIND_LABEL[k].toLowerCase()}`)
                  .join(" · ")}{" "}
                — not security issues; not counted in the security totals.{" "}
                <Link href="/agents/security/guardian" className="underline underline-offset-2">
                  Open the Code Guardian workspace
                </Link>
              </p>
              <ul className="divide-y divide-s-line">
                {engineering.slice(0, 12).map((f) => (
                  <li key={f.id} className="flex items-center gap-3 py-2">
                    <Link href={`/agents/security/findings/${f.id}`} className="min-w-0 flex-1 truncate text-[13.5px] hover:underline">
                      {f.title}
                    </Link>
                    <SeverityBadge severity={f.severity} />
                  </li>
                ))}
              </ul>
              {engineering.length > 12 && <p className="mt-2 text-[12.5px] text-s-ink-3">and {engineering.length - 12} more in the workspace.</p>}
            </section>
          )}

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
