"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { qualityFor } from "./config";
import type { OrbisScene } from "./scene";
import { orbisStore, VISUALS } from "./state";

/**
 * OrbisCore: the live particle core. It loads three.js only on the client, sizes itself to its box, pauses when
 * the page is hidden or the core is scrolled out of view, draws a still picture for people who prefer reduced
 * motion, and falls back to `fallback` when WebGL isn't available or the GPU drops the context.
 */
export function OrbisCore({
  look,
  pointer,
  audioLevel,
  fallback,
  className,
}: {
  look: keyof typeof VISUALS;
  pointer: boolean;
  audioLevel?: () => number;
  fallback: ReactNode;
  className?: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useRef<OrbisScene | null>(null);
  const lookRef = useRef(look);
  const audioRef = useRef(audioLevel);
  const pointerRef = useRef(pointer);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    lookRef.current = look;
    audioRef.current = audioLevel;
    pointerRef.current = pointer;
  });

  useEffect(() => {
    const el = wrap.current;
    const cv = canvas.current;
    if (!el || !cv) return;
    let disposed = false;
    let visible = true;
    let onScreen = true;
    const cleanups: (() => void)[] = [];
    void import("./scene")
      .then(({ OrbisScene }) => {
        if (disposed) return;
        const nav = navigator as Navigator & { deviceMemory?: number };
        let s: OrbisScene;
        try {
          s = new OrbisScene(cv, {
            tier: qualityFor({ cores: nav.hardwareConcurrency, memoryGb: nav.deviceMemory, width: window.innerWidth, coarsePointer: matchMedia("(pointer: coarse)").matches }),
            reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
            pointer: pointerRef.current,
            audioLevel: () => audioRef.current?.() ?? 0,
            onLost: () => setFailed(true),
          });
        } catch {
          setFailed(true);
          return;
        }
        scene.current = s;
        s.setTarget(lookRef.current);
        const size = () => {
          const r = el.getBoundingClientRect();
          s.resize(r.width, r.height);
          el.dataset.orbisQuality = `${s.quality.tier}:${s.quality.particles}`;
        };
        size();
        const run = () => (visible && onScreen ? s.start() : s.stop());
        run();
        const ro = new ResizeObserver(size);
        ro.observe(el);
        const io = new IntersectionObserver(([e]) => {
          onScreen = !!e?.isIntersecting;
          run();
        });
        io.observe(el);
        const onVis = () => {
          visible = document.visibilityState === "visible";
          run();
        };
        document.addEventListener("visibilitychange", onVis);
        const offPulse = orbisStore.onPulse((strength) => s.pulse(strength));
        cleanups.push(() => {
          ro.disconnect();
          io.disconnect();
          document.removeEventListener("visibilitychange", onVis);
          offPulse();
          s.dispose();
          scene.current = null;
        });
      })
      .catch(() => setFailed(true));
    return () => {
      disposed = true;
      cleanups.forEach((c) => c());
    };
  }, []);

  useEffect(() => {
    scene.current?.setTarget(look);
    if (wrap.current) wrap.current.dataset.orbisLook = look;
  }, [look]);
  useEffect(() => scene.current?.setPointerEnabled(pointer), [pointer]);

  if (failed) return <div className={cn("grid place-items-center", className)}>{fallback}</div>;
  return (
    <div
      ref={wrap}
      className={className}
      onPointerMove={(e) => {
        if (!pointerRef.current) return;
        const r = e.currentTarget.getBoundingClientRect();
        scene.current?.setPointer({ x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -(((e.clientY - r.top) / r.height) * 2 - 1) });
      }}
      onPointerLeave={() => scene.current?.setPointer(null)}
    >
      <canvas ref={canvas} aria-hidden className="block h-full w-full" />
    </div>
  );
}
