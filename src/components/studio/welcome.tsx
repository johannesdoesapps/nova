"use client";
import Link from "next/link";
import { useSyncExternalStore, type ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import type { HomeAction } from "@/lib/home";
import type { StarterTask, StarterTaskId } from "@/lib/starter";
import type { ConvSummary } from "./history";
import { TaskStarter, type StarterEnv } from "./task-starter";
import { ChipMascot } from "@/components/brand/chip";

const noSubscribe = () => () => {};

/**
 * The chat's start screen: one question, the prompt box, and the task starter
 * underneath (optional: typing works straight away). Returning users get a
 * link back to their latest conversation.
 */
export function Welcome({
  name,
  composer,
  onAction,
  notice,
  starter,
  recent,
}: {
  name: string | null;
  composer: ReactNode;
  onAction: (a: HomeAction) => void;
  notice?: ReactNode;
  starter: { active: StarterTaskId | null; onChoose: (task: StarterTask | null) => void; env: StarterEnv };
  /** The latest conversation, to continue it. */
  recent?: ConvSummary | null;
}) {
  // The hour is only known in the browser; render nothing on the server.
  const hour = useSyncExternalStore(
    noSubscribe,
    () => new Date().getHours(),
    () => null,
  );
  const part = hour === null ? null : hour < 5 || hour >= 18 ? "Good evening" : hour < 12 ? "Good morning" : "Good afternoon";
  const greeting = part && (name ? `${part}, ${name}` : part);

  return (
    <div className="mx-auto flex min-h-full w-full max-w-[760px] flex-col items-center justify-center px-4 pb-16 pt-10 sm:px-6">
      <ChipMascot mood="hello" className="s-in h-20 w-20" />
      <p className="s-in mt-6 h-5 text-[14px] text-s-ink-3 [animation-delay:40ms]">{greeting}</p>
      <h1 className="s-in mt-2 text-balance text-center font-serif text-[clamp(32px,5.6vw,48px)] leading-[1.08] tracking-[-0.01em] [animation-delay:80ms]">What do you want to accomplish?</h1>

      <div className="s-in mt-8 w-full [animation-delay:120ms]">{composer}</div>

      <TaskStarter active={starter.active} onChoose={starter.onChoose} onAction={onAction} env={starter.env} />

      {recent && (
        <Link
          href={`/chat?c=${recent.id}`}
          className="s-in mt-5 inline-flex max-w-full items-center gap-1.5 text-[13px] text-s-ink-3 underline-offset-4 [animation-delay:200ms] hover:text-s-ink hover:underline"
        >
          <span className="shrink-0">Continue:</span>
          <span className="truncate text-s-ink-2">{recent.title}</span>
          <ArrowRight className="h-3.5 w-3.5 shrink-0" />
        </Link>
      )}

      {notice && <div className="s-in mt-7 text-center text-[12.5px] text-s-ink-3 [animation-delay:240ms]">{notice}</div>}
    </div>
  );
}
