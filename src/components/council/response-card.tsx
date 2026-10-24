"use client";
import { useState, type ReactNode } from "react";
import { Check, Copy, RefreshCw } from "lucide-react";
import { Markdown } from "@/components/common/markdown";
import { ProviderMark } from "@/components/studio/model-selector";
import { GeneratingIndicator } from "@/components/studio/generating";
import type { ProviderId } from "@/lib/ai/types";
import { cn, formatUsd } from "@/lib/utils";

export type StepStatus = "idle" | "running" | "done" | "error" | "cancelled";

export interface StepState {
  status: StepStatus;
  text: string;
  error?: string;
  latencyMs?: number | null;
  outputTokens?: number | null;
  tokensEstimated?: boolean;
  estimatedCost?: number | null;
  simulated?: boolean;
}

export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard blocked */
        }
      }}
      aria-label={done ? "Copied" : "Copy"}
      title={done ? "Copied" : "Copy"}
      className={cn("grid h-8 w-8 place-items-center rounded-lg text-s-ink-3 transition hover:bg-s-hover hover:text-s-ink [&_svg]:h-4 [&_svg]:w-4", className)}
    >
      {done ? <Check /> : <Copy />}
    </button>
  );
}

export function Dots() {
  return (
    <span className="inline-flex items-center gap-1" role="status" aria-label="Writing">
      <span className="s-dot h-1.5 w-1.5 rounded-full bg-s-ink-2" />
      <span className="s-dot h-1.5 w-1.5 rounded-full bg-s-ink-2 [animation-delay:160ms]" />
      <span className="s-dot h-1.5 w-1.5 rounded-full bg-s-ink-2 [animation-delay:320ms]" />
    </span>
  );
}

/** Timing and usage, only as reported (estimates are labelled). */
export function StepMeta({ s }: { s: StepState }) {
  if (s.status !== "done") return null;
  const parts: string[] = [];
  if (s.latencyMs != null) parts.push(`${(s.latencyMs / 1000).toFixed(1)}s`);
  if (s.outputTokens != null) parts.push(`${s.tokensEstimated ? "~" : ""}${s.outputTokens.toLocaleString()} tokens out`);
  if (s.estimatedCost != null && s.estimatedCost > 0) parts.push(`≈ ${formatUsd(s.estimatedCost)}`);
  return parts.length ? <span className="text-[11.5px] text-s-ink-3">{parts.join(" · ")}</span> : null;
}

export function ResponseCard({
  title,
  subtitle,
  provider,
  state,
  onRetry,
  actions,
  footer,
  highlight,
  clamp,
}: {
  title: string;
  subtitle?: string;
  provider: ProviderId | "auto";
  state: StepState;
  onRetry?: () => void;
  actions?: ReactNode;
  footer?: ReactNode;
  highlight?: boolean;
  /** Long answers scroll inside the card (side by side stays comparable), with a way to show all. */
  clamp?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const long = !!clamp && state.text.length > 1400;
  const partial = (state.status === "error" || state.status === "cancelled") && !!state.text;
  return (
    <article className={cn("glass s-in flex min-w-0 flex-col rounded-[22px] p-4 sm:p-5", highlight && "border-[color-mix(in_srgb,var(--s-ink)_28%,transparent)]")}>
      <header className="flex items-center gap-2.5">
        <ProviderMark provider={provider} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium">{title}</div>
          {subtitle && <div className="truncate text-[12px] text-s-ink-3">{subtitle}</div>}
        </div>
        {state.status === "running" && <Dots />}
        {state.status === "done" && state.text && <CopyButton text={state.text} />}
        {actions}
      </header>
      <div className={cn("mt-3 min-h-[3rem] flex-1", long && !expanded && "s-scroll max-h-[460px] overflow-y-auto pr-1")}>
        {partial ? (
          <>
            <Markdown text={state.text} className="s-prose text-[14.5px] [&_p]:leading-relaxed" />
            <div role="status" className="mt-3 rounded-xl border border-s-line px-3.5 py-2.5 text-[12.5px]">
              <p className={state.status === "error" ? "text-s-danger" : "text-s-ink-3"}>
                {state.status === "error" ? `Stopped early — this is a partial answer. ${state.error ?? ""}` : "Cancelled — this is a partial answer."}
              </p>
              {onRetry && (
                <button type="button" onClick={onRetry} className="mt-1.5 inline-flex items-center gap-1.5 text-[12.5px] text-s-ink-2 hover:text-s-ink">
                  <RefreshCw className="h-3.5 w-3.5" /> Run this model again
                </button>
              )}
            </div>
          </>
        ) : state.status === "error" ? (
          <div className="rounded-xl border border-s-line px-3.5 py-3 text-[13px]">
            <p className="text-s-danger">{state.error ?? "This model failed."}</p>
            {onRetry && (
              <button type="button" onClick={onRetry} className="mt-2 inline-flex items-center gap-1.5 text-[12.5px] text-s-ink-2 hover:text-s-ink">
                <RefreshCw className="h-3.5 w-3.5" /> Retry this model
              </button>
            )}
          </div>
        ) : state.status === "cancelled" && !state.text ? (
          <p className="text-[13px] text-s-ink-3">Cancelled.</p>
        ) : state.text ? (
          <Markdown text={state.text} className="s-prose text-[14.5px] [&_p]:leading-relaxed" />
        ) : state.status === "idle" ? (
          <p className="text-[13px] text-s-ink-3">Waiting…</p>
        ) : (
          <GeneratingIndicator announce={false} />
        )}
        {state.simulated && <p className="mt-2 text-[11.5px] text-s-ink-3">Simulated reply — no AI provider is configured.</p>}
      </div>
      {long && (
        <button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} className="mt-2 w-fit text-[12.5px] text-s-ink-2 underline-offset-2 hover:text-s-ink hover:underline">
          {expanded ? "Show less" : "Show the whole answer"}
        </button>
      )}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <StepMeta s={state} />
        {footer}
      </div>
    </article>
  );
}
