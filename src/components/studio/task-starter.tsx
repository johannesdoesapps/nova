"use client";
import Link from "next/link";
import { track } from "@vercel/analytics";
import { ArrowRight, CodeXml, Globe, ListChecks, MessageCircle, PenLine, Plus, Sparkles, Swords, Telescope, X } from "lucide-react";
import type { ReactNode } from "react";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { MODE_LABELS } from "@/lib/ai/modes";
import { ROUTER_MODES } from "@/lib/ai/router-modes";
import type { HomeAction } from "@/lib/home";
import { exampleAction, STARTER_TASKS, starterTask, type StarterTask, type StarterTaskId } from "@/lib/starter";
import { cn } from "@/lib/utils";

const ICONS: Record<StarterTaskId, ReactNode> = { research: <Telescope />, writing: <PenLine />, coding: <CodeXml />, planning: <ListChecks />, compare: <Swords />, chat: <MessageCircle /> };

export interface StarterEnv {
  /** Web search is set up on this site. */
  search: boolean;
  /** Auto routing is on (otherwise the user's model stays). */
  autoOn: boolean;
}

/**
 * "What do you want to accomplish?": six tasks under the prompt box. Choosing
 * one sets the box up for it (mode, model, web sources), says why, and shows
 * examples that start straight away, fill in the box, or open a workspace.
 * Nothing blocks typing: the box works without choosing anything, and the
 * whole row can be hidden.
 */
export function TaskStarter({
  active,
  onChoose,
  onAction,
  env,
  home,
}: {
  active: StarterTaskId | null;
  /** The task chosen (or null when it's chosen again); the parent applies its setup. */
  onChoose: (task: StarterTask | null) => void;
  onAction: (a: HomeAction) => void;
  env: StarterEnv;
  home?: boolean;
}) {
  const [hidden, setHidden] = useLocalStorage("orbis:starter");
  const task = starterTask(active);

  if (hidden === "hidden")
    return (
      <button type="button" onClick={() => setHidden("shown")} className="s-in mt-4 text-[12.5px] text-s-ink-3 underline-offset-4 hover:text-s-ink hover:underline">
        Show starting ideas
      </button>
    );

  const choose = (t: StarterTask) => {
    const next = active === t.id ? null : t;
    if (next) track("starter_task", { task: next.id });
    onChoose(next);
  };

  return (
    <div className="w-full">
      <div role="group" aria-label="What do you want to accomplish?" className="s-in mt-4 flex w-full gap-1.5 overflow-x-auto pb-1 [animation-delay:160ms] sm:flex-wrap sm:justify-center">
        {STARTER_TASKS.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-pressed={active === t.id}
            aria-controls={active === t.id ? "starter-panel" : undefined}
            onClick={() => choose(t)}
            className={cn(
              "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-[13px] transition active:scale-[0.98] [&_svg]:h-3.5 [&_svg]:w-3.5",
              active === t.id ? "border-s-line-strong bg-s-hover text-s-ink" : "border-s-line text-s-ink-2 hover:border-s-line-strong hover:text-s-ink",
            )}
          >
            {ICONS[t.id]}
            {t.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            onChoose(null);
            setHidden("hidden");
          }}
          aria-label="Hide starting ideas"
          title="Hide starting ideas"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-s-ink-3 transition hover:bg-s-hover hover:text-s-ink [&_svg]:h-3.5 [&_svg]:w-3.5"
        >
          <X />
        </button>
      </div>

      {task && (
        <section id="starter-panel" aria-label={`${task.label}: suggested setup and examples`} className="s-in mt-3 w-full s-card rounded-2xl p-4 text-left">
          <p className="text-[14px] font-medium text-s-ink">{task.short}</p>
          <Setup task={task} env={env} />
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-s-ink-3">{task.why}</p>
          <ul className="mt-3 grid gap-2 sm:grid-cols-3">
            {task.examples.map((ex) => {
              const a = exampleAction(task, ex, { ...env, home });
              const icon = a.kind === "link" ? <ArrowRight /> : a.kind === "send" ? <Sparkles /> : <Plus />;
              const hint = a.kind === "link" ? "Opens" : a.kind === "send" ? "Starts now" : "Fills in the box";
              return (
                <li key={ex.label}>
                  <button
                    type="button"
                    onClick={() => {
                      track("starter_example", { task: task.id, kind: a.kind });
                      onAction(a);
                    }}
                    className="group flex h-full w-full items-start gap-2.5 rounded-xl border border-s-line p-3 text-left transition hover:border-s-line-strong hover:bg-s-hover active:scale-[0.99] [&_svg]:h-3.5 [&_svg]:w-3.5"
                  >
                    <span className="mt-0.5 shrink-0 text-s-ink-3 group-hover:text-s-ink-2">{icon}</span>
                    <span className="min-w-0">
                      <span className="block text-[13.5px] font-medium text-s-ink">{ex.label}</span>
                      <span className="mt-0.5 block text-[12px] text-s-ink-3">{hint}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {task.next && (
            <Link href={task.next.href} className="mt-3 inline-flex items-center gap-1 text-[13px] text-s-ink-2 underline-offset-4 hover:text-s-ink hover:underline">
              {task.next.label} <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          )}
        </section>
      )}
    </div>
  );
}

/** What choosing the task set in the box, honestly (Auto or web sources may be off on this site). */
function Setup({ task, env }: { task: StarterTask; env: StarterEnv }) {
  if (!task.setup) return null;
  const router = ROUTER_MODES.find((m) => m.id === task.setup!.router)!;
  const pill = "inline-flex items-center gap-1 rounded-full border border-s-line px-2 py-0.5 text-[12px] text-s-ink-2 [&_svg]:h-3 [&_svg]:w-3";
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="text-[12px] text-s-ink-3">Set up for you:</span>
      <span className={pill}>{MODE_LABELS[task.setup.mode].label} mode</span>
      <span className={pill}>
        <Sparkles /> {env.autoOn ? (router.id === "balanced" ? "Auto" : `Auto · ${router.label}`) : "Your chosen model"}
      </span>
      {task.setup.web && (
        <span className={pill}>
          <Globe /> {env.search ? "Web sources on" : "Web sources (not set up on this site)"}
        </span>
      )}
      <span className="text-[12px] text-s-ink-3">· change them in the box above.</span>
    </div>
  );
}
