"use client";
import { useEffect, useState } from "react";
import { InfinityMark } from "@/components/brand/infinity";
import { useAnimatedLogo } from "./prefs";

/** After this long without any text, say so honestly instead of looping the same words. */
const SLOW_AFTER_MS = 15_000;

/** True while the text ends inside an unfinished ``` code block, i.e. code is being written right now. */
export function inOpenCodeBlock(text: string): boolean {
  return (text.match(/^\s*```/gm) ?? []).length % 2 === 1;
}

/** Whether a request is about code, for the waiting label: Coding mode, or a message containing a code block. */
export function isCodeRequest(mode: string | null | undefined, lastUserMessage: string | undefined): boolean {
  return mode === "coding" || /```/.test(lastUserMessage ?? "");
}

/**
 * Shown from the moment a message is sent until the first words of the reply
 * arrive: the Orbis logo, moving, with what Orbis is doing in plain words. Tied to the
 * reply's real "streaming" state by its parent, so it disappears as soon as
 * text arrives, the reply fails, or the user stops it.
 */
export function GeneratingIndicator({ label }: { label: string }) {
  const animated = useAnimatedLogo();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => clearTimeout(t);
  }, []);
  return (
    <div role="status" className="s-in flex items-center gap-2.5 py-0.5">
      {animated ? <InfinityMark wide animate weight={6.5} className="h-[14px] w-6 shrink-0" /> : <ProgressDots />}
      <div className="min-w-0">
        <p className="s-shimmer text-[14px]">{label}…</p>
        {slow && <p className="s-in mt-0.5 text-[12.5px] text-s-ink-3">Still working on it. Longer requests can take a minute.</p>}
      </div>
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
