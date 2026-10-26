"use client";
import { ImageGeneration, type ImageGenerationHandle } from "img-fx";
import { useEffect, useRef, useState } from "react";

/**
 * The card shown while an image is being created: a churning pixel mosaic (img-fx, WebGL) that resolves into the
 * finished image. `src` is null while the image is on its way; once it's set the mosaic dissolves into it and
 * `onRevealed` fires, so the caller can swap in the normal card. Without WebGL, or with reduced motion, the reveal is
 * skipped and `onRevealed` fires straight away.
 */
export default function ImageLoader({ src, aspect, onRevealed }: { src: string | null; aspect: string; onRevealed: () => void }) {
  const fx = useRef<ImageGenerationHandle>(null);
  const done = useRef(false);
  const [still] = useState(() => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const finish = useRef(onRevealed);
  useEffect(() => {
    finish.current = onRevealed;
  });

  useEffect(() => {
    if (!src) return;
    const end = () => {
      if (done.current) return;
      done.current = true;
      finish.current();
    };
    if (still) return end();
    fx.current?.triggerReveal({ hold: "manual" });
    // The reveal takes about a second; if it never reports back (no WebGL), show the image anyway.
    const t = window.setTimeout(end, 4000);
    return () => window.clearTimeout(t);
  }, [src, still]);

  const card = <div className="w-full rounded-[18px]" style={{ aspectRatio: aspect }} />;
  if (still) return <div className="glass w-full animate-pulse rounded-[18px]" style={{ aspectRatio: aspect }} />;
  return (
    <ImageGeneration
      ref={fx}
      preset="pixels-organic"
      images={src ? [src] : []}
      revealFadeOutMs={0}
      onCycle={(e) => {
        if (e.phase === "visible" && !done.current) {
          done.current = true;
          finish.current();
        }
      }}
      className="w-full"
    >
      {card}
    </ImageGeneration>
  );
}
