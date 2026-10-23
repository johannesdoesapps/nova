"use client";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Bot, Bug, ChartColumn, Code2, FileText, Flag, Flame, Globe, GraduationCap, Lightbulb, PenLine, Play, Plug, Scale, Sparkles, Swords, Telescope, Users } from "lucide-react";
import { greetingFor, homeActionById, planDayPrompt, type HomeAction, type IconName } from "@/lib/home";
import type { StarterTask, StarterTaskId } from "@/lib/starter";
import { FirstRun } from "./first-run";
import { TaskStarter, type StarterEnv } from "./task-starter";
import { OrbisMark } from "./ui";

export const HOME_ICONS: Record<IconName, ReactNode> = {
  telescope: <Telescope />,
  users: <Users />,
  swords: <Swords />,
  globe: <Globe />,
  bug: <Bug />,
  file: <FileText />,
  bot: <Bot />,
  flag: <Flag />,
  plug: <Plug />,
  play: <Play />,
  flame: <Flame />,
  scale: <Scale />,
  graduation: <GraduationCap />,
  pen: <PenLine />,
  lightbulb: <Lightbulb />,
  chart: <ChartColumn />,
  code: <Code2 />,
  sparkles: <Sparkles />,
};

const noSubscribe = () => () => {};

export interface HomeProps {
  name: string | null;
  composer: ReactNode;
  onAction: (a: HomeAction) => void;
  notice?: ReactNode;
  starter: { active: StarterTaskId | null; onChoose: (task: StarterTask | null) => void; env: StarterEnv };
  /** A new account (see lib/onboarding): show the guided start instead of the usual start screen. */
  firstRun?: boolean;
  signedIn?: boolean;
  /** GitHub import is set up on this site (otherwise onboarding doesn't offer it). */
  github?: boolean;
}

/** The start page: the logo, a greeting with today's date, one question, the prompt box and the task starter. */
export function Home({ name, composer, onAction, notice, starter, firstRun = false, signedIn = false, github = false }: HomeProps) {
  const router = useRouter();
  const params = useSearchParams();
  // First-run onboarding: new accounts, or anyone who opens "Getting started" (/home?welcome=1).
  const [welcome, setWelcome] = useState(() => signedIn && (firstRun || params.get("welcome") === "1"));

  // The time is only known in the browser; render placeholders on the server.
  const now = useSyncExternalStore(
    noSubscribe,
    () => Math.floor(Date.now() / 60_000),
    () => null,
  );
  const date = now === null ? null : new Date(now * 60_000);

  // "/home?try=<id>" (from Discover and elsewhere): run that suggestion here once.
  const tryId = params.get("try");
  useEffect(() => {
    if (!tryId) return;
    const a = homeActionById(tryId);
    router.replace("/home", { scroll: false });
    if (a) onAction(a);
  }, [tryId, onAction, router]);

  // "Plan my day" has no prompt of its own: it asks a few questions first.
  const runAction = (a: HomeAction) => {
    if (a.kind === "send" && !a.prompt) {
      if (!date) return;
      onAction({
        kind: "send",
        mode: "analyst",
        prompt: planDayPrompt({ date: date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }), focus: [], tasks: [], events: [], calendar: "unavailable" }),
      });
    } else onAction(a);
  };

  const greeting = date ? greetingFor(date.getHours(), name) : null;

  if (welcome)
    return (
      <div className="mx-auto flex min-h-full w-full max-w-[1080px] flex-col justify-center px-4 pb-24 pt-6 sm:px-6 sm:pt-10 lg:pt-14">
        <div className="mx-auto flex w-full max-w-[760px] flex-col items-center">
          <OrbisMark className="s-in mb-6 h-9 w-9" />
          <FirstRun name={name} onAction={runAction} onClose={() => setWelcome(false)} github={github} />
          <p className="mt-8 w-full text-left text-[12.5px] font-medium text-s-ink-3">Or ask anything</p>
          <div className="mt-2 w-full text-left">{composer}</div>
          {notice && <div className="mt-5 text-center text-[12.5px] text-s-ink-3">{notice}</div>}
        </div>
      </div>
    );

  return (
    <div className="mx-auto flex min-h-full w-full max-w-[1080px] flex-col justify-center px-4 pb-24 pt-6 sm:px-6 sm:pt-10 lg:pt-14">
      <div className="mx-auto flex w-full max-w-[760px] flex-col items-center text-center">
        <OrbisMark className="s-in h-9 w-9" />
        <p className="s-in mt-6 h-5 text-[13.5px] text-s-ink-3" suppressHydrationWarning>
          {greeting && date ? `${greeting} · ${date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}` : " "}
        </p>
        <h1 className="mt-1.5 text-balance font-serif text-[clamp(32px,5.6vw,48px)] leading-[1.08] tracking-[-0.01em]">What do you want to accomplish?</h1>
        <div className="mt-7 w-full text-left">{composer}</div>
        <TaskStarter active={starter.active} onChoose={starter.onChoose} onAction={runAction} env={starter.env} home />
        {notice && <div className="mt-5 text-center text-[12.5px] text-s-ink-3">{notice}</div>}
        {signedIn && (
          <Link href="/home?welcome=1" onClick={() => setWelcome(true)} className="mt-6 text-[12.5px] text-s-ink-3 underline-offset-4 hover:text-s-ink hover:underline">
            Getting started with Orbis
          </Link>
        )}
      </div>
    </div>
  );
}
