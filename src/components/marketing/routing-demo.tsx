"use client";
import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { track } from "@vercel/analytics";
import { ArrowRight, Cpu, Sparkles } from "lucide-react";
import { autoRoute, type TaskKind } from "@/lib/ai/router";
import type { ModelWithStatus } from "@/lib/ai/types";
import { cn } from "@/lib/utils";

const SAMPLES = [
  "Summarise these meeting notes into five bullet points",
  "Why does my React component render twice? It logs every message twice.",
  "Compare a monolith and microservices for a five-person startup, with trade-offs",
  "Write a friendly email asking a client to approve the new timeline",
];

type PlanId = "free" | "pro" | "max";
const PLAN_RANK: Record<PlanId, number> = { free: 0, pro: 1, max: 2 };
const PLAN_LABEL: Record<PlanId, string> = { free: "Free", pro: "Pro", max: "Max" };

/** What Orbis offers for each kind of task beyond a plain chat (fixed links, not a model decision). */
const NEXT: Record<TaskKind, { label: string; href: string; text: string }> = {
  coding: { label: "Debug a coding issue", href: "/templates?t=debug-code", text: "For a whole project, the coding agent can open it, make the fix and run your tests." },
  summary: { label: "Summarise a document", href: "/templates?t=summarise-document", text: "The template pulls out the key points first, then writes the summary for your reader." },
  writing: { label: "Write or improve an article", href: "/templates?t=write-article", text: "Outline, draft, then a critical edit — three steps you can watch and customise." },
  analysis: { label: "Compare AI responses", href: "/arena", text: "When it matters, ask several models and see where they agree and where they don't." },
  "long-document": { label: "Summarise a document", href: "/templates?t=summarise-document", text: "Long texts go to a model whose context window fits them." },
  general: { label: "Check the claims", href: "/verify", text: "For an important answer, Verify checks its claims against sources and shows what it couldn't confirm." },
};

type Catalog = { status: "idle" | "loading" } | { status: "ready"; models: ModelWithStatus[] } | { status: "error" };

/**
 * A working piece of Orbis on the homepage: type a task and see which model
 * Auto would choose for it on each plan, and why. It runs Orbis's real routing
 * rules in the browser against the live model list; no AI model is called and
 * what you type isn't sent anywhere.
 */
export function RoutingDemo() {
  const [task, setTask] = useState(SAMPLES[1]!);
  const [plan, setPlan] = useState<PlanId>("free");
  const [catalog, setCatalog] = useState<Catalog>({ status: "idle" });
  const ref = useRef<HTMLDivElement>(null);
  const inputId = useId();
  const tracked = useRef(false);

  // The model list is only fetched once the demo is on screen.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const load = () => {
      setCatalog({ status: "loading" });
      fetch("/api/models")
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((j: { models?: ModelWithStatus[] }) => setCatalog({ status: "ready", models: j.models ?? [] }))
        .catch(() => setCatalog({ status: "error" }));
    };
    if (typeof IntersectionObserver === "undefined") return load();
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          load();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const route = useMemo(() => {
    if (catalog.status !== "ready" || !task.trim()) return null;
    const allowed = catalog.models.filter((m) => m.available && m.provider !== "demo" && PLAN_RANK[(m.requiredPlan ?? "free") as PlanId] <= PLAN_RANK[plan]);
    return allowed.length ? autoRoute(allowed, task) : null;
  }, [catalog, task, plan]);

  const next = route ? NEXT[route.task] : null;
  const note = () => {
    if (tracked.current) return;
    tracked.current = true;
    track("landing_demo_used");
  };

  return (
    <div ref={ref} className="lux-card min-w-0 rounded-[22px] p-5 sm:p-7">
      <p className="text-xs font-medium tracking-[0.14em] text-muted uppercase">Try it: Orbis&apos;s real model routing</p>

      <label htmlFor={inputId} className="mt-4 block text-[15px] font-medium text-fg">
        1. Enter a task
      </label>
      <textarea
        id={inputId}
        value={task}
        onChange={(e) => {
          setTask(e.target.value.slice(0, 2000));
          note();
        }}
        rows={3}
        className="mt-2 w-full resize-y rounded-xl border border-border-strong bg-panel px-3.5 py-3 text-[16px] leading-relaxed text-fg outline-none focus-visible:ring-2 focus-visible:ring-accent"
      />
      <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Sample tasks">
        {SAMPLES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => {
              setTask(s);
              note();
            }}
            aria-pressed={task === s}
            className={cn(
              "max-w-full truncate rounded-full border px-3 py-1.5 text-[13px] transition",
              task === s ? "border-accent text-fg" : "border-border text-muted hover:border-border-strong hover:text-fg",
            )}
          >
            {s}
          </button>
        ))}
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[15px] font-medium text-fg">2. Orbis picks a model</p>
        <div role="radiogroup" aria-label="Plan" className="inline-flex rounded-full border border-border p-0.5 text-[13px]">
          {(["free", "pro", "max"] as const).map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={plan === p}
              onClick={() => {
                setPlan(p);
                note();
              }}
              className={cn("rounded-full px-3 py-1.5 transition", plan === p ? "bg-panel-2 text-fg" : "text-muted hover:text-fg")}
            >
              {PLAN_LABEL[p]}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3 min-h-[124px] rounded-xl border border-border bg-panel p-4" aria-live="polite">
        {catalog.status === "error" ? (
          <p className="text-[14px] text-muted">The model list couldn&apos;t be loaded just now, so the routing can&apos;t be shown. Try again later, or start a free account to use Auto directly.</p>
        ) : catalog.status !== "ready" ? (
          <div role="status" aria-label="Loading the model list" className="space-y-2">
            <div className="h-4 w-1/2 animate-pulse rounded bg-panel-2 motion-reduce:animate-none" />
            <div className="h-4 w-5/6 animate-pulse rounded bg-panel-2 motion-reduce:animate-none" />
          </div>
        ) : !task.trim() ? (
          <p className="text-[14px] text-muted">Type a task above.</p>
        ) : !route ? (
          <p className="text-[14px] text-muted">No model is available for this plan right now.</p>
        ) : (
          <>
            <p className="flex flex-wrap items-center gap-2 text-[16px] text-fg">
              <Sparkles className="h-4 w-4 text-accent-2" aria-hidden />
              <span className="font-medium">{route.model.displayName}</span>
              <span className="rounded-full border border-border px-2 py-0.5 text-[12px] text-muted">
                {route.task === "long-document" ? "long document" : route.task} · {route.complexity === "complex" ? "harder task" : "everyday task"}
              </span>
              {typeof route.model.units === "number" && (
                <span className="rounded-full border border-border px-2 py-0.5 text-[12px] text-muted">
                  {route.model.units} usage unit{route.model.units === 1 ? "" : "s"}
                </span>
              )}
            </p>
            <p className="mt-2 text-[14px] leading-relaxed text-muted">{route.reason}</p>
          </>
        )}
      </div>

      {next && (
        <div className="mt-6">
          <p className="text-[15px] font-medium text-fg">3. Compare or review when it matters</p>
          <p className="mt-1.5 text-[14px] leading-relaxed text-muted">
            {next.text}{" "}
            <Link href={next.href} className="inline-flex items-center gap-1 text-fg underline underline-offset-4 hover:text-accent-2">
              {next.label} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          </p>
        </div>
      )}

      <p className="mt-6 flex items-start gap-2 border-t border-border pt-4 text-[12.5px] leading-relaxed text-muted">
        <Cpu className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        This runs the same routing rules Orbis uses, in your browser, against today&apos;s model list. No AI model is called and what you type isn&apos;t sent anywhere. The suggested next step is a
        fixed link for each kind of task.
      </p>
    </div>
  );
}
