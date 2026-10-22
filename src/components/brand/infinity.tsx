"use client";
import { useId } from "react";

/** The infinity loop: two O's joined into one endless line. */
const LOOP = "M32 32C38 22 52 20 54 32C56 44 40 42 32 32C24 22 8 20 10 32C12 44 26 42 32 32Z";

/**
 * The Orbis logo mark, a violet-to-pink infinity loop. `wide` crops the box to
 * the loop's shape for use beside the wordmark; the default square box suits
 * avatars and icons. The gradient id comes from useId so copies never clash.
 */
export function InfinityMark({ className, wide = false, weight = 6, title }: { className?: string; wide?: boolean; weight?: number; title?: string }) {
  const id = "loop" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return (
    <svg viewBox={wide ? "6 17 52 30" : "6 6 52 52"} className={className} role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <defs>
        <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="8" y1="32" x2="56" y2="32">
          <stop offset="0" stopColor="#7c3aed" />
          <stop offset="0.5" stopColor="#d946ef" />
          <stop offset="1" stopColor="#fb7185" />
        </linearGradient>
      </defs>
      <path d={LOOP} fill="none" stroke={`url(#${id})`} strokeWidth={weight} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
