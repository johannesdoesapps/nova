"use client";
import { useState } from "react";
import type { ClaimStatus, EvidenceBasis, JudgedBy, Stance, SupportEstimate } from "@/lib/claims/types";
import { Badge } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

type Tone = "default" | "accent" | "success" | "warning" | "danger";

export const STATUS_META: Record<ClaimStatus, { label: string; tone: Tone; help: string; dot: string }> = {
  supported: { label: "Supported", tone: "success", help: "A retrieved passage directly states this claim.", dot: "bg-success" },
  partially_supported: { label: "Partly supported", tone: "accent", help: "Passages cover the topic but may not state this exact claim.", dot: "bg-accent" },
  contested: { label: "Contested", tone: "warning", help: "Some passages support it and others conflict with it.", dot: "bg-warning" },
  contradicted: { label: "Contradicted", tone: "danger", help: "A passage conflicts with it and none support it.", dot: "bg-danger" },
  insufficient: { label: "No evidence found", tone: "default", help: "Nothing in the provided sources addresses it. It may still be true.", dot: "bg-faint" },
  not_checkable: { label: "Opinion", tone: "default", help: "A judgement or recommendation; evidence can inform it but not settle it.", dot: "bg-border-strong" },
};

export function StatusBadge({ status }: { status: ClaimStatus }) {
  const m = STATUS_META[status];
  return (
    <Badge tone={m.tone} title={m.help}>
      <span className={cn("h-1.5 w-1.5 rounded-full", m.dot)} aria-hidden />
      {m.label}
    </Badge>
  );
}

export const BASIS_META: Record<EvidenceBasis, { label: string; help: string }> = {
  direct: { label: "Direct evidence", help: "A source states it." },
  inference: { label: "AI inference", help: "Derived or interpreted; no source states it directly." },
  none: { label: "Not backed by a source", help: "No source passage supports it." },
};

export function BasisBadge({ basis }: { basis: EvidenceBasis }) {
  return (
    <Badge tone={basis === "direct" ? "success" : basis === "inference" ? "accent" : "warning"} title={BASIS_META[basis].help}>
      {BASIS_META[basis].label}
    </Badge>
  );
}

export function StanceBadge({ stance }: { stance: Stance }) {
  return stance === "supports" ? <Badge tone="success">Supports</Badge> : stance === "contradicts" ? <Badge tone="danger">Conflicts</Badge> : <Badge>Insufficient</Badge>;
}

export function JudgedByBadge({ by }: { by: JudgedBy }) {
  const label = by === "rules" ? "Keyword rules" : by === "model" ? "Model judgement" : "Your review";
  return <Badge tone={by === "user" ? "accent" : "default"}>{label}</Badge>;
}

/**
 * Shows a heuristic estimate as a coarse band. The number and its formula are
 * one click away, always next to the caveat that it is not a probability of truth.
 */
export function EstimateMeter({ estimate }: { estimate: SupportEstimate | null }) {
  const [open, setOpen] = useState(false);
  if (!estimate) return <p className="text-xs text-faint">No estimate: opinions are not scored.</p>;
  const steps = estimate.band === "strong" ? 3 : estimate.band === "moderate" ? 2 : 1;
  return (
    <div className="rounded-xl border border-border bg-bg-elev p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs text-muted">
          Evidence match <span className="text-faint">(heuristic, {estimate.judgedBy === "rules" ? "rules" : estimate.judgedBy === "model" ? "includes model judgements" : "includes your reviews"})</span>
        </div>
        <div className="flex gap-1" aria-label={`Evidence match: ${estimate.band}`}>
          {[1, 2, 3].map((i) => (
            <span key={i} className={cn("h-2 w-6 rounded-full", i <= steps ? (steps === 3 ? "bg-success" : steps === 2 ? "bg-accent" : "bg-warning") : "bg-panel-2")} />
          ))}
        </div>
      </div>
      <div className="mt-1 text-sm font-medium capitalize">{estimate.band}</div>
      <p className="mt-1 text-xs text-faint">{estimate.caveat}</p>
      <button type="button" onClick={() => setOpen(!open)} className="mt-2 text-xs text-accent hover:underline">
        {open ? "Hide" : "Show"} how this was computed
      </button>
      {open && (
        <div className="mt-2 space-y-1 text-xs text-muted">
          <div>
            Raw value: <span className="font-mono text-fg">{estimate.value.toFixed(2)}</span> on a 0–1 scale (not a percentage chance).
          </div>
          <div className="font-mono text-[11px] text-faint">{estimate.method}</div>
        </div>
      )}
    </div>
  );
}

export function SufficiencyBadge({ s }: { s: "insufficient" | "tentative" | "clear" }) {
  return s === "clear" ? <Badge tone="success">Enough evidence</Badge> : s === "tentative" ? <Badge tone="warning">Tentative</Badge> : <Badge>Not enough data</Badge>;
}

/** Horizontal interval bar on 0–1 with an optional 50% reference line. */
export function IntervalBar({ low, high, point, reference = 0.5 }: { low: number; high: number; point: number; reference?: number | null }) {
  return (
    <div className="relative h-2 w-28 rounded-full bg-panel-2" aria-label={`${Math.round(point * 100)}% (95% interval ${Math.round(low * 100)}–${Math.round(high * 100)}%)`}>
      {reference !== null && <span className="absolute top-[-3px] h-[14px] w-px bg-border-strong" style={{ left: `${reference * 100}%` }} />}
      <span className="absolute h-2 rounded-full bg-accent/40" style={{ left: `${low * 100}%`, width: `${Math.max(1, (high - low) * 100)}%` }} />
      <span className="absolute top-[-2px] h-3 w-1 rounded bg-accent" style={{ left: `calc(${point * 100}% - 2px)` }} />
    </div>
  );
}
