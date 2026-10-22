"use client";
import { useId } from "react";

/**
 * Orbis's brand: the chip logo and Chip, the mascot made from it. Both draw
 * the same gradient processor; the mascot adds a screen face and pin limbs.
 * Gradient ids come from useId so several copies on one page never clash.
 */

const useGradientId = () => "chip" + useId().replace(/[^a-zA-Z0-9_-]/g, "");

const STOPS = (
  <>
    <stop offset="0" stopColor="#7c3aed" />
    <stop offset="0.5" stopColor="#d946ef" />
    <stop offset="1" stopColor="#fb7185" />
  </>
);

/** The logo's infinity loop (same path as InfinityMark), drawn small on Chip. */
const LOOP = "M32 32C38 22 52 20 54 32C56 44 40 42 32 32C24 22 8 20 10 32C12 44 26 42 32 32Z";

const PINS = "M24 16V9M32 16V9M40 16V9M24 48V55M32 48V55M40 48V55M16 24H9M16 32H9M16 40H9M48 24H55M48 32H55M48 40H55";
/** Fewer, thicker pins for small sizes (favicons, avatars). */
const PINS_SIMPLE = "M24 14V7M40 14V7M24 50V57M40 50V57M14 24H7M14 40H7M50 24H57M50 40H57";

/** The logo mark. `simple` drops pins and detail so it reads at 16–20px. */
export function ChipMark({ className, simple = false, title }: { className?: string; simple?: boolean; title?: string }) {
  const id = useGradientId();
  return (
    <svg viewBox="0 0 64 64" className={className} role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <defs>
        <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="16" y1="48" x2="48" y2="16">
          {STOPS}
        </linearGradient>
      </defs>
      <path d={simple ? PINS_SIMPLE : PINS} stroke="#c084fc" strokeWidth={simple ? 5 : 4} strokeLinecap="round" fill="none" />
      {simple ? <rect x="14" y="14" width="36" height="36" rx="8" fill={`url(#${id})`} /> : <rect x="16" y="16" width="32" height="32" rx="7" fill={`url(#${id})`} />}
      <circle cx="32" cy="32" r={simple ? 8 : 7.5} fill="none" stroke="#ffffff" strokeWidth={simple ? 5 : 4.2} />
      {!simple && <circle cx="40.5" cy="23.5" r="2.2" fill="#ffffff" />}
    </svg>
  );
}

export type ChipMood = "hello" | "thinking" | "working" | "writing" | "happy" | "oops";

/**
 * Chip, the mascot: the logo with a screen face, pin arms and little legs.
 * With `animate`, Chip floats, blinks, looks around and moves its arms (CSS
 * transforms only; all motion stops when reduced motion is preferred). The
 * movement is decoration, not a picture of what the AI is doing.
 */
export function ChipMascot({ mood = "hello", animate = false, className, title }: { mood?: ChipMood; animate?: boolean; className?: string; title?: string }) {
  const id = useGradientId();
  const a = (cls: string) => (animate ? cls : undefined);
  // Arms follow the mood: one waving for hello, both up when happy, typing while writing.
  const leftArm = mood === "happy" ? "M14 30L8 23" : "M14 30H8";
  const rightArm = mood === "hello" || mood === "happy" ? "M50 30L56 23" : "M50 30H56";
  const pin = { stroke: "#c084fc", strokeWidth: 3, strokeLinecap: "round" as const, fill: "none" };
  return (
    <svg viewBox="0 0 64 64" className={className} role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <defs>
        <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="14" y1="50" x2="50" y2="14">
          {STOPS}
        </linearGradient>
        {animate && (
          <radialGradient id={`${id}g`}>
            <stop offset="0" stopColor="#d946ef" stopOpacity="0.45" />
            <stop offset="1" stopColor="#d946ef" stopOpacity="0" />
          </radialGradient>
        )}
      </defs>
      {animate && <circle className="chip-glow" cx="32" cy="32" r="30" fill={`url(#${id}g)`} />}
      <g className={a("chip-float")}>
        <path d="M24 14V8M32 14V8M40 14V8M14 38H8M50 38H56M26 50V57M38 50V57M23 57H28M35 57H41" {...pin} />
        <path className={a(mood === "writing" ? "chip-type" : mood === "working" ? "chip-tap-l" : "")} d={leftArm} {...pin} />
        <path className={a(mood === "writing" ? "chip-type chip-type-2" : mood === "hello" ? "chip-wave" : mood === "working" ? "chip-tap" : "")} d={rightArm} {...pin} />
        <rect x="14" y="14" width="36" height="36" rx="9" fill={`url(#${id})`} />
        <rect x="19" y="21" width="26" height="20" rx="6" fill="#141217" />
        <circle className={a("chip-led")} cx="45.5" cy="18" r="1.8" fill="#ffffff" />
        {/* The Orbis infinity loop on Chip's front, so mascot and logo read as one brand. */}
        <path d={LOOP} transform="translate(32 45.6) scale(0.2) translate(-32 -32)" fill="none" stroke="#ffffff" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
        {(mood === "hello" || mood === "working") && (
          <g className={a("chip-look")}>
            <g className={a("chip-blink")}>
              <rect x="24.5" y="25.5" width="4.5" height="7" rx="2.25" fill="#ffffff" />
              <rect x="35" y="25.5" width="4.5" height="7" rx="2.25" fill="#ffffff" />
            </g>
          </g>
        )}
        {mood === "hello" && <path d="M28 36.5Q32 39.5 36 36.5" fill="none" stroke="#ffffff" strokeWidth="1.8" strokeLinecap="round" />}
        {mood === "working" && (
          <>
            <circle className={a("chip-dot")} cx="28.5" cy="37" r="1.3" fill="#f0abfc" />
            <circle className={a("chip-dot chip-dot-2")} cx="32" cy="37" r="1.3" fill="#f0abfc" />
            <circle className={a("chip-dot chip-dot-3")} cx="35.5" cy="37" r="1.3" fill="#f0abfc" />
          </>
        )}
        {mood === "writing" && (
          <>
            <g className={a("chip-blink")}>
              <rect x="24.5" y="28" width="4.5" height="4.5" rx="2.25" fill="#ffffff" />
              <rect x="35" y="28" width="4.5" height="4.5" rx="2.25" fill="#ffffff" />
            </g>
            <path d="M29 36.5Q32 38.5 35 36.5" fill="none" stroke="#ffffff" strokeWidth="1.8" strokeLinecap="round" />
          </>
        )}
        {mood === "thinking" && (
          <>
            <circle className="s-dot [transform-box:fill-box]" cx="26" cy="31" r="2.2" fill="#f0abfc" />
            <circle className="s-dot [animation-delay:160ms] [transform-box:fill-box]" cx="32" cy="31" r="2.2" fill="#f0abfc" />
            <circle className="s-dot [animation-delay:320ms] [transform-box:fill-box]" cx="38" cy="31" r="2.2" fill="#f0abfc" />
          </>
        )}
        {mood === "happy" && (
          <>
            <path d="M24 31Q26.75 27 29.5 31M34.5 31Q37.25 27 40 31" fill="none" stroke="#ffffff" strokeWidth="2.2" strokeLinecap="round" />
            <path d="M27 35Q32 40 37 35" fill="none" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" />
          </>
        )}
        {mood === "oops" && (
          <>
            <circle cx="27" cy="29.5" r="2" fill="#ffffff" />
            <circle cx="37" cy="29.5" r="2" fill="#ffffff" />
            <path d="M27 36.5Q29.5 34.5 32 36.5Q34.5 38.5 37 36.5" fill="none" stroke="#ffffff" strokeWidth="1.8" strokeLinecap="round" />
          </>
        )}
      </g>
    </svg>
  );
}
