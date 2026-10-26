"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { VoiceBeam, type VoiceBeamMotion } from "voice-glow";

/** The app's theme (`data-theme` on <html>, dark unless set to light), kept in sync with the theme switch. */
export function useDocumentTheme(): "dark" | "light" {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  useEffect(() => {
    const el = document.documentElement;
    const read = () => setTheme(el.dataset.theme === "light" ? "light" : "dark");
    read();
    const obs = new MutationObserver(read);
    obs.observe(el, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  return theme;
}

/**
 * A sound-reactive glow along the bottom of the chat composer (voice-glow). While voice input is on it rises with
 * the microphone level; while Orbis is answering the glow gathers into one beam that sweeps from side to side.
 * Otherwise it's off. `stream` is the microphone, when there is one.
 */
export function ComposerGlow({ stream, listening, busy, children }: { stream: MediaStream | null; listening: boolean; busy: boolean; children: ReactNode }) {
  const theme = useDocumentTheme();
  const busyRef = useRef(busy);
  useEffect(() => {
    busyRef.current = busy;
  });
  // Eased each frame so the beam gathers and lets go smoothly instead of snapping.
  const gather = useRef(0);
  const last = useRef(0);

  const motion = (): VoiceBeamMotion | null => {
    const now = performance.now();
    const dt = last.current ? Math.min(0.1, (now - last.current) / 1000) : 0;
    last.current = now;
    gather.current += ((busyRef.current ? 1 : 0) - gather.current) * Math.min(1, dt * 4);
    if (gather.current < 0.01) return null;
    return { gather: gather.current, offset: Math.sin(now / 900) * 0.8, stretch: 0.25, heldLevel: 0.55 };
  };

  return (
    <VoiceBeam stream={listening ? stream : null} active={listening || busy} motion={motion} theme={theme} strength={theme === "light" ? 0.7 : 0.9}>
      {children}
    </VoiceBeam>
  );
}
