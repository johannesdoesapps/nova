"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Check, CircleAlert, CircleDashed, CircleX, Code2, Crosshair, Globe, Loader2, Network, Radar, ShieldCheck, Siren, SkipForward } from "lucide-react";
import { Markdown } from "@/components/common/markdown";
import { postNdjson } from "@/hooks/use-ndjson";
import type { SecurityAgentDef } from "@/lib/security/agents";
import type { StoredAnalysis } from "@/lib/security/audit-report";
import { cn } from "@/lib/utils";

export const AGENT_ICON: Record<SecurityAgentDef["icon"] | "coordinated" | "network" | "shield", typeof Radar> = {
  radar: Radar,
  crosshair: Crosshair,
  code: Code2,
  siren: Siren,
  globe: Globe,
  coordinated: Radar,
  network: Network,
  shield: ShieldCheck,
};
export const AGENT_TINT: Record<string, string> = {
  sentinel: "from-sky-500/25 to-cyan-400/5 text-sky-600 dark:text-sky-300",
  threat_hunter: "from-amber-500/25 to-orange-400/5 text-amber-600 dark:text-amber-300",
  code_guardian: "from-violet-500/25 to-fuchsia-400/5 text-violet-600 dark:text-violet-300",
  incident_responder: "from-rose-500/15 to-rose-400/5 text-s-ink-3",
  threat_intel: "from-emerald-500/15 to-emerald-400/5 text-s-ink-3",
  coordinated: "from-s-accent/25 to-transparent text-s-ink",
  aegis: "from-emerald-500/25 to-teal-400/5 text-emerald-600 dark:text-emerald-300",
  bastion: "from-rose-500/25 to-red-400/5 text-rose-600 dark:text-rose-300",
};
export const AGENT_NAME: Record<string, string> = {
  sentinel: "Orbis Sentinel",
  threat_hunter: "Orbis Threat Hunter",
  code_guardian: "Orbis Code Guardian",
  incident_responder: "Orbis Incident Responder",
  threat_intel: "Orbis Threat Intelligence",
  coordinated: "Coordinated investigation",
};

export function AgentBadge({ agent, icon, size = "md" }: { agent: string; icon: keyof typeof AGENT_ICON; size?: "sm" | "md" }) {
  const Icon = AGENT_ICON[icon];
  return (
    <span className={cn("grid shrink-0 place-items-center border border-s-line bg-gradient-to-br", AGENT_TINT[agent], size === "md" ? "h-11 w-11 rounded-[14px] [&_svg]:h-5 [&_svg]:w-5" : "h-7 w-7 rounded-lg [&_svg]:h-3.5 [&_svg]:w-3.5")}>
      <Icon aria-hidden />
    </span>
  );
}
export const ICON_OF: Record<string, keyof typeof AGENT_ICON> = { sentinel: "radar", threat_hunter: "crosshair", code_guardian: "code", incident_responder: "siren", threat_intel: "globe", coordinated: "coordinated" };

export const SEVERITY_STYLE: Record<string, string> = {
  critical: "bg-red-600 text-white",
  high: "bg-orange-500/15 text-orange-700 dark:text-orange-300 border border-orange-500/30",
  medium: "bg-amber-400/15 text-amber-700 dark:text-amber-300 border border-amber-500/30",
  low: "bg-sky-500/10 text-sky-700 dark:text-sky-300 border border-sky-500/25",
  info: "bg-s-hover text-s-ink-2 border border-s-line",
};
export const SEVERITY_DOT: Record<string, string> = { critical: "bg-red-600", high: "bg-orange-500", medium: "bg-amber-400", low: "bg-sky-500", info: "bg-s-ink-3" };

export function SeverityBadge({ severity }: { severity: string }) {
  return <span className={cn("inline-flex h-6 shrink-0 items-center rounded-full px-2.5 text-[11.5px] font-semibold capitalize", SEVERITY_STYLE[severity])}>{severity}</span>;
}

const CONF_HINT: Record<string, string> = {
  confirmed: "Observed directly by a scanner with clear evidence",
  firm: "Strong pattern match; usually real",
  tentative: "Heuristic or AI-suggested; needs checking",
};
export function ConfidenceBadge({ confidence }: { confidence: string }) {
  return (
    <span title={CONF_HINT[confidence]} className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-dashed border-s-line-strong px-2.5 text-[11.5px] text-s-ink-2">
      {confidence === "confirmed" ? "Confirmed" : confidence === "firm" ? "Firm" : "Tentative"}
    </span>
  );
}

export const FINDING_STATUS_LABEL: Record<string, string> = {
  open: "Open",
  investigating: "Investigating",
  fix_proposed: "Fix proposed",
  fixed: "Fixed",
  accepted_risk: "Accepted risk",
  verified: "Verified fixed",
  false_positive: "False positive",
};
export function FindingStatus({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center rounded-full px-2.5 text-[11.5px]",
        status === "open" && "bg-s-hover text-s-ink",
        status === "investigating" && "bg-sky-500/10 text-sky-700 dark:text-sky-300",
        status === "fix_proposed" && "bg-violet-500/10 text-violet-700 dark:text-violet-300",
        (status === "fixed" || status === "verified") && "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
        (status === "accepted_risk" || status === "false_positive") && "border border-s-line text-s-ink-3",
      )}
    >
      {FINDING_STATUS_LABEL[status] ?? status}
    </span>
  );
}

export const VERIFICATION_LABEL: Record<string, string> = { not_verified: "Not re-checked", still_present: "Still present", not_detected: "Not detected on re-check" };

export function RunStatus({ status }: { status: string | null }) {
  const s = status ?? "idle";
  const map: Record<string, { label: string; cls: string; icon: ReactNode }> = {
    idle: { label: "Idle", cls: "text-s-ink-3", icon: <CircleDashed /> },
    running: { label: "Running", cls: "text-sky-600 dark:text-sky-300", icon: <Loader2 className="animate-spin" /> },
    completed: { label: "Completed", cls: "text-emerald-600 dark:text-emerald-400", icon: <Check /> },
    failed: { label: "Failed", cls: "text-s-danger", icon: <CircleX /> },
    cancelled: { label: "Cancelled", cls: "text-s-ink-3", icon: <CircleX /> },
  };
  const v = map[s] ?? map.idle!;
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[12.5px] [&_svg]:h-3.5 [&_svg]:w-3.5", v.cls)}>
      {v.icon}
      {v.label}
    </span>
  );
}

export const fmtTime = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/* ---------------------------------------------------------- Live progress */

export interface StepEvent {
  agent: string;
  id: string;
  label: string;
  status: "running" | "done" | "skipped" | "failed";
  detail?: string;
}

export interface RunState {
  phase: "idle" | "running" | "done" | "error" | "cancelled";
  steps: StepEvent[];
  notices: string[];
  progress: string | null;
  report: string | null;
  runIds: Record<string, string>;
  findings: Record<string, { count: number; bySeverity: Record<string, number>; resolved?: number; reopened?: number }>;
  error: string | null;
  /** A Sentinel audit's analysis (gate, paths, coverage), sent by its final step. */
  audit?: StoredAnalysis;
}
export const EMPTY_RUN: RunState = { phase: "idle", steps: [], notices: [], progress: null, report: null, runIds: {}, findings: {}, error: null };

/** Consume one NDJSON agent stream into RunState updates. Returns false on error. */
export async function streamRun(url: string, body: unknown, signal: AbortSignal, update: (fn: (s: RunState) => RunState) => void): Promise<{ ok: boolean; runId?: string }> {
  let runId: string | undefined;
  try {
    for await (const ev of postNdjson<Record<string, unknown>>(url, body, signal)) {
      const type = ev.type as string;
      if (type === "run") {
        runId = ev.runId as string;
        update((s) => ({ ...s, runIds: { ...s.runIds, [ev.agent as string]: runId! } }));
      } else if (type === "step") {
        const step = ev as unknown as StepEvent;
        update((s) => {
          const i = s.steps.findIndex((x) => x.agent === step.agent && x.id === step.id);
          const steps = [...s.steps];
          if (i >= 0) steps[i] = step;
          else steps.push(step);
          return { ...s, steps, progress: step.status === "running" ? s.progress : null };
        });
      } else if (type === "progress") update((s) => ({ ...s, progress: ev.text as string }));
      else if (type === "notice") update((s) => ({ ...s, notices: [...s.notices, ev.text as string] }));
      else if (type === "report") update((s) => ({ ...s, report: ev.text as string }));
      else if (type === "audit") update((s) => ({ ...s, audit: ev.analysis as StoredAnalysis }));
      else if (type === "findings") update((s) => ({ ...s, findings: { ...s.findings, [ev.agent as string]: ev as never } }));
      else if (type === "error") {
        update((s) => ({ ...s, error: ev.message as string, steps: s.steps.map((x) => (x.status === "running" ? { ...x, status: "failed" } : x)) }));
        return { ok: false, runId };
      }
    }
    return { ok: true, runId };
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    update((s) => ({ ...s, error: (e as Error).message }));
    return { ok: false, runId };
  }
}

const STEP_ICON: Record<StepEvent["status"], ReactNode> = {
  running: <Loader2 className="animate-spin text-sky-500" />,
  done: <Check className="text-emerald-500" />,
  skipped: <SkipForward className="text-s-ink-3" />,
  failed: <CircleAlert className="text-s-danger" />,
};

export function RunProgress({ state, showAgent }: { state: RunState; showAgent?: boolean }) {
  if (state.phase === "idle") return null;
  const total = Object.values(state.findings).reduce((n, f) => n + f.count, 0);
  return (
    <div className="mt-4 space-y-3" aria-live="polite">
      <ol className="space-y-1.5">
        {state.steps.map((s) => (
          <li key={`${s.agent}-${s.id}`} className="flex items-start gap-2.5 text-[13.5px] [&_svg]:mt-0.5 [&_svg]:h-4 [&_svg]:w-4 [&_svg]:shrink-0">
            {STEP_ICON[s.status]}
            <span className="min-w-0">
              <span className="font-medium">
                {showAgent && <span className="text-s-ink-3">{AGENT_NAME[s.agent]} · </span>}
                {s.label}
              </span>
              {s.detail && <span className="block text-[12.5px] text-s-ink-2">{s.detail}</span>}
              {s.status === "running" && state.progress && <span className="block text-[12.5px] text-s-ink-3">{state.progress}…</span>}
            </span>
          </li>
        ))}
      </ol>
      {state.notices.map((n, i) => (
        <p key={i} className="rounded-xl border border-s-line bg-s-hover px-3 py-2 text-[12.5px] text-s-ink-2">
          {n}
        </p>
      ))}
      {state.error && (
        <p role="alert" className="flex items-start gap-2 rounded-xl border border-[color-mix(in_srgb,var(--s-danger)_35%,transparent)] px-3 py-2 text-[13px] text-s-danger">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" /> {state.error}
        </p>
      )}
      {(state.phase === "done" || total > 0) && (
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <span className="font-medium">{total} finding{total === 1 ? "" : "s"}</span>
          {Object.values(state.findings)
            .flatMap((f) => Object.entries(f.bySeverity))
            .reduce<[string, number][]>((acc, [k, v]) => {
              const e = acc.find((x) => x[0] === k);
              if (e) e[1] += v;
              else acc.push([k, v]);
              return acc;
            }, [])
            .map(([k, v]) => (
              <span key={k} className="inline-flex items-center gap-1 text-s-ink-2">
                <span className={cn("h-2 w-2 rounded-full", SEVERITY_DOT[k])} /> {v} {k}
              </span>
            ))}
          {Object.values(state.findings).some((f) => f.resolved) && <span className="text-emerald-600 dark:text-emerald-400">{Object.values(state.findings).reduce((n, f) => n + (f.resolved ?? 0), 0)} earlier finding(s) not detected this time</span>}
          {Object.values(state.findings).some((f) => f.reopened) && <span className="text-s-danger">{Object.values(state.findings).reduce((n, f) => n + (f.reopened ?? 0), 0)} fixed finding(s) reappeared</span>}
        </div>
      )}
      {state.audit && (
        <p className="rounded-xl border border-s-line px-3 py-2 text-[13px]">
          {state.audit.gate && (
            <strong className={cn("mr-1.5 font-semibold", state.audit.gate.outcome === "passed" ? "text-emerald-600 dark:text-emerald-400" : "text-s-danger")}>
              Gate {state.audit.gate.outcome === "incomplete" ? "incomplete (treat as failed)" : state.audit.gate.outcome}.
            </strong>
          )}
          {state.audit.paths.length} attack path(s) · {state.audit.coverage.filter((c) => c.state === "assessed").length} of {state.audit.coverage.length} areas fully assessed,{" "}
          {state.audit.coverage.filter((c) => c.state === "partial").length} partly, {state.audit.coverage.filter((c) => c.state === "not_assessed").length} not at all. Open the results for details.
        </p>
      )}
      {state.report && <ReportBlock text={state.report} />}
      {state.phase === "done" && Object.entries(state.runIds).length > 0 && (
        <div className="flex flex-wrap gap-2">
          {Object.entries(state.runIds).map(([agent, id]) => (
            <Link
              key={id}
              href={`/agents/security/runs/${id}`}
              className="inline-flex h-9 items-center rounded-xl border border-s-line-strong px-3.5 text-[13px] font-medium transition hover:bg-s-hover"
            >
              Open {agent === "coordinated" && state.audit ? "audit" : (AGENT_NAME[agent] ?? "run")} results
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export function ReportBlock({ text, title = "AI report" }: { text: string; title?: string }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="rounded-2xl border border-s-line bg-s-hover/50 p-4">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="text-[12px] font-medium uppercase tracking-[0.08em] text-s-ink-3">
        {title} {open ? "–" : "+"}
      </button>
      {open && (
        <div className="s-prose mt-2 text-[14px]">
          <Markdown text={text} />
        </div>
      )}
      <p className="mt-2 text-[11.5px] text-s-ink-3">Written by an AI model from the scan data above. Check important claims against the evidence.</p>
    </section>
  );
}
