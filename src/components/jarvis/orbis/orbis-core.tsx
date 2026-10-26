"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { qualityFor } from "./config";
import type { OrbisScene, SceneOptions } from "./scene";
import { orbisStore, VISUALS } from "./state";

/**
 * OrbisCore: the live particle core. It loads three.js only on the client, sizes itself to its box, pauses when
 * the page is hidden or the core is scrolled out of view, draws a still picture for people who prefer reduced
 * motion. It draws with WebGL when it can and with the 2D canvas when the browser gives the page no WebGL (or
 * the GPU drops the context), so the core looks the same either way; `fallback` shows only if neither works.
 */

/** What OrbisCore needs from a renderer; OrbisScene (WebGL) and OrbisScene2D (2D canvas) both provide it. */
type Renderer = Pick<OrbisScene, "quality" | "resize" | "setTarget" | "pulse" | "setPointer" | "setPointerEnabled" | "start" | "stop" | "dispose">;
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
  const scene = useRef<Renderer | null>(null);
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
    if (!el) return;
    // The canvas is made here rather than by React, because switching renderers needs a new one.
    const makeCanvas = () => {
      const c = document.createElement("canvas");
      c.className = "block h-full w-full";
      c.setAttribute("aria-hidden", "true");
      el.replaceChildren(c);
      return c;
    };
    const cv = makeCanvas();
    let disposed = false;
    let visible = true;
    let onScreen = true;
    let cleanup: (() => void) | null = null;
    const nav = navigator as Navigator & { deviceMemory?: number };
    const options = (onLost: () => void): SceneOptions => ({
      tier: qualityFor({ cores: nav.hardwareConcurrency, memoryGb: nav.deviceMemory, width: window.innerWidth, coarsePointer: matchMedia("(pointer: coarse)").matches }),
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      pointer: pointerRef.current,
      audioLevel: () => audioRef.current?.() ?? 0,
      onLost,
    });

    const mount = (s: Renderer, kind: "webgl" | "2d") => {
      scene.current = s;
      el.dataset.orbisRenderer = kind;
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
      cleanup = () => {
        ro.disconnect();
        io.disconnect();
        document.removeEventListener("visibilitychange", onVis);
        offPulse();
        s.dispose();
        scene.current = null;
        cleanup = null;
      };
    };

    // A canvas that has had a WebGL context can't give a 2D one, so the 2D renderer gets a fresh canvas.
    const switchTo2d = async (reason: string) => {
      console.warn(`ORBIS core: drawing with the 2D canvas (${reason}).`);
      const { OrbisScene2D } = await import("./scene-2d");
      if (disposed) return;
      cleanup?.();
      mount(new OrbisScene2D(makeCanvas(), options(() => setFailed(true))), "2d");
    };

    void (async () => {
      let webgl: OrbisScene | null = null;
      let reason = "";
      try {
        const { OrbisScene } = await import("./scene");
        if (disposed) return;
        webgl = new OrbisScene(cv, options(() => void switchTo2d("the WebGL context was lost").catch(() => setFailed(true))));
      } catch (e) {
        reason = e instanceof Error ? e.message : "WebGL isn't available";
      }
      if (disposed) return webgl?.dispose();
      if (webgl) mount(webgl, "webgl");
      else await switchTo2d(reason);
    })().catch(() => setFailed(true));
    return () => {
      disposed = true;
      cleanup?.();
      el.replaceChildren();
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
    />
  );
}
