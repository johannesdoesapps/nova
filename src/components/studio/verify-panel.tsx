"use client";

import Link from "next/link";
import { useState } from "react";
import { CircleAlert, ExternalLink, Loader2, ShieldCheck, X } from "lucide-react";
import { jsonFetch } from "@/hooks/use-ndjson";
import type { ClaimKind, ClaimStatus } from "@/lib/claims/types";
import { cn } from "@/lib/utils";
import { openInVerify } from "@/lib/verify/handoff";
import { categoryOf, CATEGORIES } from "@/lib/verify/categories";
import type { VerifyResult } from "@/lib/verify/schema";
import { IconButton } from "./ui";

const STATUS: Record<ClaimStatus, { label: string; tone: string }> = {
  supported: { label: "Supported", tone: "text-emerald-600 dark:text-emerald-400 border-emerald-500/30" },
  partially_supported: { label: "Partly supported", tone: "text-sky-600 dark:text-sky-400 border-sky-500/30" },
  contested: { label: "Contested", tone: "text-amber-600 dark:text-amber-400 border-amber-500/30" },
  contradicted: { label: "Contradicted", tone: "text-s-danger border-red-500/30" },
  insufficient: { label: "Insufficient evidence", tone: "text-s-ink-2 border-s-line" },
  not_checkable: { label: "Not checkable", tone: "text-s-ink-3 border-s-line" },
};

const KIND: Record<ClaimKind, string> = {
  factual: "Fact",
  statistical: "Statistic",
  causal: "Cause & effect",
  predictive: "Prediction",
  comparative: "Comparison",
  definitional: "Definition",
  opinion: "Opinion",
};

/** The Truth Layer: claim-by-claim checks of one answer against web sources. */
export function useVerify(question: string, answer: string) {
  const [state, setState] = useState<{ status: "idle" | "loading" | "done" | "error"; result?: VerifyResult; error?: string }>({ status: "idle" });
  const run = async () => {
    setState({ status: "loading" });
    try {
      const result = await jsonFetch<VerifyResult>("/api/verify", { method: "POST", body: JSON.stringify({ question, answer }) });
      setState({ status: "done", result });
    } catch (e) {
      setState({ status: "error", error: e instanceof Error ? e.message : "The check failed." });
    }
  };
  return { state, run, close: () => setState({ status: "idle" }), openFull: () => openInVerify(question, answer) };
}

export function VerifyButton({ onClick, loading }: { onClick: () => void; loading: boolean }) {
  return (
    <IconButton size="sm" label="Verify claims" onClick={onClick} disabled={loading}>
      {loading ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
    </IconButton>
  );
}

export function VerifyPanel({ state, onClose, onRetry, onOpenFull }: { state: ReturnType<typeof useVerify>["state"]; onClose: () => void; onRetry: () => void; onOpenFull?: () => void }) {
  if (state.status === "idle") return null;
  return (
    <section aria-label="Verification" className="glass s-in mt-3 rounded-2xl p-4 text-[13.5px]">
      <header className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-s-accent" />
        <h3 className="flex-1 font-semibold">Truth Layer</h3>
        <IconButton size="sm" label="Close verification" onClick={onClose}>
          <X />
        </IconButton>
      </header>

      {state.status === "loading" && (
        <div className="mt-3 flex flex-col gap-2" role="status">
          <span className="text-s-ink-2">Finding claims and checking sources…</span>
          <div className="s-skeleton h-4 w-3/4 rounded" />
          <div className="s-skeleton h-4 w-2/3 rounded" />
        </div>
      )}

      {state.status === "error" && (
        <div role="alert" className="mt-3 flex items-center gap-2 text-s-ink-2">
          <CircleAlert className="h-4 w-4 text-s-danger" />
          <span className="flex-1">{state.error}</span>
          <button type="button" onClick={onRetry} className="rounded-full border border-s-line-strong px-3 py-1 text-[12.5px] hover:bg-s-hover">
            Try again
          </button>
        </div>
      )}

      {state.status === "done" && state.result && (
        <div className="mt-3 flex flex-col gap-3">
          {state.result.reason && (
            <p className="flex items-start gap-2 rounded-xl border border-s-line bg-s-hover px-3 py-2 text-s-ink-2">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" /> {state.result.reason}
            </p>
          )}
          {state.result.headline && <p className="font-medium">{state.result.headline}</p>}
          <ul className="flex flex-col gap-2">
            {state.result.claims.map((c, i) => (
              <li key={i} className="rounded-xl border border-s-line px-3 py-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  {c.status ? (
                    <span className={cn("rounded-full border px-2 py-0.5 text-[11.5px] font-medium", STATUS[c.status].tone)}>{CATEGORIES[categoryOf(c.status)].label}</span>
                  ) : (
                    <span className="rounded-full border border-s-line px-2 py-0.5 text-[11.5px] text-s-ink-3">Not checked</span>
                  )}
                  <span className="rounded-full bg-s-hover px-2 py-0.5 text-[11.5px] text-s-ink-2">{KIND[c.kind]}</span>
                  {c.hedged && <span className="text-[11.5px] text-s-ink-3">hedged</span>}
                </div>
                <p className="mt-1.5 leading-relaxed">{c.text}</p>
                {c.evidence.length > 0 && (
                  <ul className="mt-1.5 flex flex-col gap-1">
                    {c.evidence.map((e, j) => (
                      <li key={j} className="text-[12.5px] text-s-ink-2">
                        <span className={e.stance === "contradicts" ? "text-s-danger" : "text-emerald-600 dark:text-emerald-400"}>{e.stance === "contradicts" ? "Contradicts" : "Supports"}</span>
                        {" · "}
                        {e.url ? (
                          <a href={e.url} target="_blank" rel="noopener noreferrer" className="underline decoration-s-line-strong underline-offset-2 hover:text-s-ink">
                            {e.title}
                          </a>
                        ) : (
                          e.title
                        )}
                        {e.quote && <q className="mt-0.5 block italic text-s-ink-3">{e.quote}</q>}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
          {state.result.sources.length > 0 && (
            <details className="text-[12.5px] text-s-ink-2">
              <summary className="cursor-pointer">Sources searched ({state.result.sources.length})</summary>
              <ul className="mt-1.5 flex flex-col gap-1">
                {state.result.sources.map((s, i) => (
                  <li key={i}>
                    <a href={s.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-s-ink">
                      <ExternalLink className="h-3 w-3" /> {s.title}
                    </a>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {state.result.notices.map((n) => (
            <p key={n} className="text-[12px] text-s-ink-3">
              {n}
            </p>
          ))}
          {onOpenFull && (
            <Link href="/verify" onClick={onOpenFull} className="self-start text-[12.5px] text-s-ink-2 underline underline-offset-4 hover:text-s-ink">
              Open in Verify: choose claims, add your own documents, or write a revised answer
            </Link>
          )}
        </div>
      )}
    </section>
  );
}
