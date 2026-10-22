"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { InfinityMark } from "@/components/brand/infinity";
import { useAnimatedLogo } from "./prefs";

/** After this long without any text, say so honestly instead of looping the same words. */
const SLOW_AFTER_MS = 15_000;

/** True while the text ends inside an unfinished ``` code block, i.e. code is being written right now. */
export function inOpenCodeBlock(text: string): boolean {
  return (text.match(/^\s*```/gm) ?? []).length % 2 === 1;
}

/** Whether a request is about code, for the waiting text: Coding mode, or a message containing a code block. */
export function isCodeRequest(mode: string | null | undefined, lastUserMessage: string | undefined): boolean {
  return mode === "coding" || /```/.test(lastUserMessage ?? "");
}

/**
 * What kind of work the waiting text describes. "web" and "data" are only
 * used when the app knows a web search or data analysis is part of the
 * request; "agent" stays general because the Code panel lists the real steps.
 */
export type StatusKind = "general" | "code" | "web" | "data" | "agent" | "build";

const GENERAL = [
  "Thinking",
  "Let me think",
  "Processing your request",
  "Working on it",
  "Exploring possibilities",
  "Connecting the dots",
  "Analyzing your question",
  "Putting ideas together",
  "Working through the details",
  "Preparing an answer",
  "Organizing my thoughts",
  "Checking the details",
  "Crafting a response",
];
const CODE = ["Analyzing the code", "Planning the solution", "Writing some code", "Checking the logic", "Refining the implementation", "Reviewing the code"];
const AGENT = ["Working on it", "Thinking", "Planning the next step", "Working through the details", "Connecting the dots", "Organizing my thoughts"];

/** The first entry shows first; the rest rotate. No "almost done" lines: Orbis can't know how close it is. */
export const STATUS_MESSAGES: Record<StatusKind, readonly string[]> = {
  general: GENERAL,
  code: ["Thinking", ...CODE, "Working through the details", "Putting ideas together", "Preparing an answer"],
  web: ["Searching the web", ...GENERAL.slice(1)],
  data: ["Analyzing data", ...GENERAL.slice(1)],
  agent: AGENT,
  build: ["Starting the build", ...AGENT.slice(1)],
};

/** A random index other than `current`, so the same line never shows twice in a row. */
export function nextStatusIndex(length: number, current: number, rand: () => number = Math.random): number {
  if (length < 2) return 0;
  const i = Math.floor(rand() * (length - 1));
  return i >= current ? i + 1 : i;
}

/** A new line every 1.6–2.8 seconds. Runs only while mounted, i.e. while the work is really happening. */
function useRotatingStatus(kind: StatusKind) {
  const list = STATUS_MESSAGES[kind];
  const [state, setState] = useState({ index: 0, previous: -1, beat: 0 });
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(
        () => {
          setState((s) => {
            const current = s.index % list.length;
            return { index: nextStatusIndex(list.length, current), previous: current, beat: s.beat + 1 };
          });
          schedule();
        },
        1600 + Math.random() * 1200,
      );
    };
    schedule();
    return () => clearTimeout(timer);
  }, [list]);
  return { list, index: state.index % list.length, previous: state.previous, beat: state.beat };
}

const REACTIONS: Keyframe[][] = [
  [{ transform: "scale(1)" }, { transform: "scale(1.16)" }, { transform: "scale(1)" }],
  [{ transform: "rotate(0deg)" }, { transform: "rotate(-10deg)" }, { transform: "rotate(6deg)" }, { transform: "rotate(0deg)" }],
  [{ transform: "translateY(0)" }, { transform: "translateY(-3px)" }, { transform: "translateY(0)" }],
];

/**
 * The Orbis loop while it works: it floats, a light runs around it, and it
 * gives a small pulse, tilt or hop each time the status text changes. This is
 * decoration, not a picture of the AI's reasoning, and none of it runs when
 * reduced motion is preferred.
 */
export function WorkingLoop({ beat = 0, small = false }: { beat?: number; small?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!beat || !el || typeof el.animate !== "function") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    el.animate(REACTIONS[Math.floor(Math.random() * REACTIONS.length)], { duration: 520, easing: "ease-in-out" });
  }, [beat]);
  return (
    <span className="loop-float inline-flex shrink-0" aria-hidden>
      <span ref={ref} className="inline-flex">
        <InfinityMark wide animate weight={small ? 7 : 6.5} className={small ? "h-3 w-5" : "h-[14px] w-6"} />
      </span>
    </span>
  );
}

/** The changing line of text, cross-fading from the old line to the new one. Hidden from screen readers. */
function StatusLine({ list, index, previous, beat }: { list: readonly string[]; index: number; previous: number; beat: number }) {
  return (
    <span className="inline-grid" aria-hidden>
      {previous >= 0 && (
        <span key={`out${beat}`} className="s-status-out [grid-area:1/1]">
          {list[previous]}…
        </span>
      )}
      <span key={`in${beat}`} className="s-status-in [grid-area:1/1]">
        <span className="s-shimmer">{list[index]}…</span>
      </span>
    </span>
  );
}

/**
 * Shown from the moment a request starts until the first words of the reply
 * arrive: the moving logo with a changing line of text. Its parent renders it
 * only while the reply's real state is "streaming" with no text yet, so it is
 * gone as soon as text arrives, the reply fails, or the user stops it.
 *
 * Screen readers hear one steady message (and one more if it takes long),
 * not every change of the visible text.
 */
export function GeneratingIndicator({ kind = "general", announce = true }: { kind?: StatusKind; announce?: boolean }) {
  const animated = useAnimatedLogo();
  const status = useRotatingStatus(kind);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="s-in flex items-center gap-2.5 py-0.5">
      {announce && (
        <span role="status" className="sr-only">
          {slow ? "Still working on it. Longer requests can take a minute." : "Orbis is working on a reply."}
        </span>
      )}
      {animated ? <WorkingLoop beat={status.beat} /> : <ProgressDots />}
      <div className="min-w-0 text-[14px]">
        <StatusLine {...status} />
        {slow && (
          <p className="s-in mt-0.5 text-[12.5px] text-s-ink-3" aria-hidden>
            Still working on it. Longer requests can take a minute.
          </p>
        )}
      </div>
    </div>
  );
}

/** The moving logo (or `fallback` when it's turned off) with a changing line of text, for other places Orbis works, like the Code panel. */
export function WorkingStatus({ kind, fallback, className }: { kind: StatusKind; fallback: ReactNode; className?: string }) {
  const animated = useAnimatedLogo();
  const status = useRotatingStatus(kind);
  return (
    <div className={className}>
      <span role="status" className="sr-only">
        Orbis is working.
      </span>
      {animated ? <WorkingLoop beat={status.beat} small /> : fallback}
      <StatusLine {...status} />
    </div>
  );
}

/** While the reply is appearing: a small moving logo, then gone when the reply is complete. */
export function WritingIndicator({ code }: { code: boolean }) {
  const animated = useAnimatedLogo();
  return (
    <div role="status" className="s-in mt-2 flex items-center gap-1.5 text-[12.5px] text-s-ink-3">
      {animated && <InfinityMark wide animate weight={7} className="h-[10px] w-[18px] shrink-0" />}
      <span>{code ? "Writing code…" : "Writing your answer…"}</span>
    </div>
  );
}

/** Plain progress dots, when the animated logo is turned off. */
function ProgressDots() {
  return (
    <span className="flex gap-1" aria-hidden>
      <span className="s-dot h-1.5 w-1.5 rounded-full bg-s-accent" />
      <span className="s-dot h-1.5 w-1.5 rounded-full bg-s-accent [animation-delay:160ms]" />
      <span className="s-dot h-1.5 w-1.5 rounded-full bg-s-accent [animation-delay:320ms]" />
    </span>
  );
}
