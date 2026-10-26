"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { track } from "@vercel/analytics";
import { ArrowRight, Bug, FolderGit2, Globe, Info, MessageCircle, PenLine } from "lucide-react";
import type { HomeAction } from "@/lib/home";
import { START, startPathsFor, type StartOption, type StartPath } from "@/lib/onboarding";
import { cn } from "@/lib/utils";

const ICONS: Record<StartPath, ReactNode> = { website: <Globe />, project: <FolderGit2 />, bug: <Bug />, question: <MessageCircle /> };

/**
 * Chosen or skipped during this visit. The account's "first run" flag comes with the page and isn't refreshed by
 * moving around the app, so without this the start screen would come back on the next "New chat".
 */
let settledThisVisit = false;
export const onboardingSettled = () => settledThisVisit;

/** Save the choice on the account (so it isn't shown again anywhere); never blocks what the user is doing. */
export function saveOnboarding(status: "chosen" | "skipped", path: StartPath | null = null) {
  settledThisVisit = true;
  try {
    void fetch("/api/onboarding", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status, path }), keepalive: true }).catch(() => {});
  } catch {
    /* kept for this visit only */
  }
}

const count = (event: string, props: Record<string, string> = {}) => {
  try {
    track(event, props);
  } catch {
    /* not counted */
  }
};

/**
 * First-run onboarding on Home: a two-line introduction and four starting
 * points, each a real workflow. Picking one explains what it needs, then
 * opens it (or fills the prompt box below to edit and send). Skipping, or
 * picking anything, is saved on the account. Counted anonymously: which
 * starting point, never what anyone types.
 */
export function FirstRun({ name, onAction, onClose, github = false }: { name: string | null; onAction: (a: HomeAction) => void; onClose: () => void; github?: boolean }) {
  const paths = startPathsFor({ github });
  const router = useRouter();
  const [open, setOpen] = useState<StartPath | null>(null);
  const counted = useRef(false);
  useEffect(() => {
    if (counted.current) return;
    counted.current = true;
    count("onboarding_started");
  }, []);

  const pick = (path: StartPath, o: StartOption, which: "primary" | "example") => {
    count("onboarding_choice", { path, option: which });
    saveOnboarding("chosen", path);
    if (o.action.kind === "link") return router.push(o.action.href);
    onClose();
    onAction({ kind: "draft", prompt: o.action.prompt, mode: o.action.mode ?? "research" });
  };

  const skip = () => {
    count("onboarding_skipped");
    saveOnboarding("skipped");
    onClose();
  };

  const current = paths.find((p) => p.id === open);
  const openIndex = paths.findIndex((p) => p.id === open);

  /** What the chosen starting point needs, and its actions. Shown under the card on phones, under its row on wider screens. */
  const detail = (c: (typeof START)[number], id: string) => (
    <div id={id} className="s-in s-card rounded-2xl p-4">
      {c.needs && (
        <p className="flex gap-2 text-[12.5px] leading-relaxed text-s-ink-2">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-s-ink-3" aria-hidden />
          {c.needs}
        </p>
      )}
      <div className={cn("flex flex-wrap items-center gap-2", c.needs && "mt-3")}>
        <button
          type="button"
          onClick={() => pick(c.id, c.primary, "primary")}
          className="inline-flex h-9 items-center gap-1.5 rounded-full bg-s-accent px-4 text-[13px] font-medium text-s-accent-ink transition hover:brightness-110"
        >
          {c.primary.label} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </button>
        {c.examples.map((ex) => (
          <button
            key={ex.label}
            type="button"
            onClick={() => pick(c.id, ex, "example")}
            className="inline-flex h-9 items-center gap-1.5 rounded-full border border-s-line px-3.5 text-[13px] text-s-ink-2 transition hover:border-s-line-strong hover:text-s-ink"
          >
            {ex.action.kind === "draft" ? <PenLine className="h-3.5 w-3.5" aria-hidden /> : null}
            {ex.label}
          </button>
        ))}
      </div>
      {c.id === "website" && <p className="mt-2 text-[12px] text-s-ink-3">Examples open with the request filled in, so you can change it before the agent starts.</p>}
    </div>
  );

  return (
    <section aria-labelledby="first-run-title" className="w-full text-left">
      <h1 id="first-run-title" className="text-balance text-center font-serif text-[clamp(30px,5.2vw,44px)] leading-[1.08] tracking-[-0.01em]">
        Welcome to Orbis{name ? `, ${name}` : ""}
      </h1>
      <p className="mx-auto mt-3 max-w-[560px] text-center text-[15px] leading-relaxed text-s-ink-2">
        A coding agent that builds, runs and checks its work, and chat with Claude and GPT models. Pick a place to start, or skip and type anything.
      </p>

      <ul role="list" className="mt-6 grid gap-2 sm:grid-cols-2">
        {paths.map((p, i) => [
          <li key={p.id}>
            <button
              type="button"
              aria-expanded={open === p.id}
              aria-controls={open === p.id ? "first-run-detail-m first-run-detail-d" : undefined}
              onClick={() => setOpen(open === p.id ? null : p.id)}
              className={cn(
                "s-card s-card-hover flex h-full w-full items-start gap-3 rounded-2xl p-3.5 text-left transition active:scale-[0.99] [&_svg]:h-4 [&_svg]:w-4",
                open === p.id && "border-s-line-strong bg-s-hover",
              )}
            >
              <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl border border-s-line text-s-ink-2">{ICONS[p.id]}</span>
              <span className="min-w-0">
                <span className="block text-[14.5px] font-medium text-s-ink">{p.title}</span>
                <span className="mt-0.5 block text-[12.5px] leading-relaxed text-s-ink-3">{p.text}</span>
              </span>
            </button>
          </li>,
          current && openIndex === i && (
            <li key="detail-m" className="sm:hidden">
              {detail(current, "first-run-detail-m")}
            </li>
          ),
          // Under the chosen card's row: the second card of the row, or the chosen card when it ends the list alone.
          current && ((openIndex | 1) === i || (openIndex === i && i === paths.length - 1)) && (
            <li key="detail-d" className="hidden sm:col-span-2 sm:block">
              {detail(current, "first-run-detail-d")}
            </li>
          ),
        ])}
      </ul>

      <p className="mt-4 text-center">
        <button type="button" onClick={skip} className="text-[13px] text-s-ink-3 underline-offset-4 hover:text-s-ink hover:underline">
          Skip, I&apos;ll explore on my own
        </button>
      </p>
    </section>
  );
}
