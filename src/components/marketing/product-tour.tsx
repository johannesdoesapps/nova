"use client";
import Image from "next/image";
import Link from "next/link";
import { useRef, useState, type KeyboardEvent } from "react";
import { ArrowRight, Check, CircleAlert, FileCode2, ListChecks, Search, ShieldCheck, Terminal } from "lucide-react";
import type { Demo, DemoStep } from "@/content/demos";
import { cn } from "@/lib/utils";

const STEP_ICON: Record<DemoStep["kind"], typeof Check> = {
  inspect: Search,
  plan: ListChecks,
  approval: ShieldCheck,
  command: Terminal,
  edit: FileCode2,
  summary: Check,
};

/**
 * "See it work": real captures of Orbis, one tab per workflow. Read-only, so
 * visitors can look around without an account. Each capture says when and
 * how it was made.
 */
export function ProductTour({ demos }: { demos: Demo[] }) {
  const [active, setActive] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!dir && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const next = e.key === "Home" ? 0 : e.key === "End" ? demos.length - 1 : (active + dir + demos.length) % demos.length;
    setActive(next);
    tabs.current[next]?.focus();
  };
  const d = demos[active]!;
  return (
    <div>
      <div role="tablist" aria-label="Workflows" onKeyDown={onKey} className="mx-auto flex w-fit max-w-full gap-1 overflow-x-auto rounded-full border border-border bg-panel p-1">
        {demos.map((x, i) => (
          <button
            key={x.id}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`tour-tab-${x.id}`}
            aria-selected={i === active}
            aria-controls={`tour-panel-${x.id}`}
            tabIndex={i === active ? 0 : -1}
            onClick={() => setActive(i)}
            className={cn("shrink-0 rounded-full px-4 py-2 text-sm transition", i === active ? "bg-accent text-accent-fg" : "text-muted hover:text-fg")}
          >
            {x.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`tour-panel-${d.id}`} aria-labelledby={`tour-tab-${d.id}`} className="mt-8 grid items-start gap-8 lg:grid-cols-[1.55fr_1fr]">
        {/* On phones the Code tab's step list says more than a shrunken screenshot of the same workspace as the hero. */}
        <figure className={cn("min-w-0", d.steps && "hidden sm:block")}>
          <div className="lux-card overflow-hidden rounded-[20px] p-1.5">
            <Image key={d.image.src} src={d.image.src} alt={d.image.alt} width={d.image.width} height={d.image.height} sizes="(min-width: 1024px) 680px, 100vw" className="h-auto w-full rounded-[14px]" />
          </div>
          <figcaption className="mt-3 text-xs leading-relaxed text-muted">{d.caption}</figcaption>
        </figure>

        <div className="min-w-0">
          <h3 className="text-balance font-serif text-[30px] leading-[1.1] text-fg">{d.title}</h3>
          <p className="mt-3 text-[15.5px] leading-relaxed text-muted">{d.text}</p>
          {d.steps ? (
            <ol className="mt-5 space-y-1.5" aria-label="What the agent did, in order">
              {d.steps.map((s, i) => {
                const Icon = STEP_ICON[s.kind];
                return (
                  <li key={i} className="flex items-start gap-2.5 rounded-lg border border-border bg-panel px-3 py-2 text-[13.5px] leading-snug">
                    <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", s.result === "fail" ? "text-danger" : s.result === "pass" ? "text-success" : "text-muted")} aria-hidden />
                    <span className={cn("min-w-0 flex-1 break-words text-fg", s.kind === "command" && "font-mono text-[12.5px]")}>{s.text}</span>
                    {s.result && (
                      <span className={cn("shrink-0 text-[12px]", s.result === "fail" ? "text-danger" : "text-success")}>
                        {s.result === "fail" ? (
                          <span className="inline-flex items-center gap-1">
                            <CircleAlert className="h-3 w-3" aria-hidden /> failed
                          </span>
                        ) : (
                          "passed"
                        )}
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          ) : (
            <ul className="mt-5 space-y-2.5">
              {d.points.map((p) => (
                <li key={p} className="flex gap-2.5 text-[15px] leading-relaxed text-muted">
                  <Check className="mt-1 h-4 w-4 shrink-0 text-success" aria-hidden />
                  {p}
                </li>
              ))}
            </ul>
          )}
          <Link href={d.href} className="mt-6 inline-flex items-center gap-1.5 text-sm text-fg underline-offset-4 hover:underline">
            {d.cta} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </div>
      </div>
    </div>
  );
}
