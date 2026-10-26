"use client";
import { useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
import { JarvisCore, type CoreState } from "../jarvis-core";
import { OrbisCore } from "./orbis-core";
import { ACTIVITY_LABEL, effective, lookFor, ORBIS_STATES, orbisStore, setOrbisMode, type OrbisMode, type OrbisState } from "./state";

const PILL: Record<OrbisState | "auto", string> = { idle: "Idle", listening: "Listening", thinking: "Thinking", speaking: "Speaking", error: "Error", auto: "Auto" };

/**
 * OrbisInterface: the ORBIS screen, in Orbis's colours (the logo's violet, magenta and rose). The core fills the middle; a system line runs along the top, the name and
 * the state controls along the bottom, over a perspective floor. The controls preview each look; Auto (the
 * default) shows what the assistant is really doing, and a preview is always labelled as one.
 */
export function OrbisHero({
  vault,
  terminals,
  pointer,
  audioLevel,
}: {
  /** The account's saved data (memories, history) is reachable: signed in. */
  vault: boolean;
  /** The Desktop Agent is connected. */
  terminals: boolean;
  pointer: boolean;
  audioLevel?: () => number;
}) {
  const snap = useSyncExternalStore(orbisStore.subscribe, orbisStore.get, orbisStore.get);
  const { activity, preview } = effective(snap);
  const look = lookFor(activity);
  const tone = activity === "error" ? "bg-[#ff6a4d]" : activity === "approval" ? "bg-[#ffc14d]" : activity === "stopped" ? "bg-[#6b5f80]" : "bg-[#d946ef]";

  const pill = (id: OrbisMode) => {
    const pressed = id === "auto" ? snap.mode === "auto" : snap.mode === id;
    const showing = id !== "auto" && look.state === id;
    return (
      <button
        key={id}
        type="button"
        aria-pressed={pressed}
        onClick={() => setOrbisMode(id)}
        className={cn(
          "pointer-events-auto h-8 rounded-md border px-3 font-mono text-[11px] tracking-[0.06em] transition-[color,background-color,border-color,box-shadow] duration-500",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d8b4fe]",
          pressed || showing ? "border-[#c084fc]/50 bg-[#a855f7]/12 text-[#f5ecff] shadow-[0_0_18px_-4px_rgba(217,70,239,0.6)]" : "border-transparent text-[#c9b8e8]/70 hover:text-[#f5ecff]",
        )}
      >
        {PILL[id]}
      </button>
    );
  };

  return (
    <section aria-label="ORBIS core" className="relative isolate h-[clamp(460px,74vh,860px)] overflow-hidden rounded-[28px] bg-[#05030b] text-[#efe6ff]">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_55%_50%_at_50%_42%,rgba(124,58,237,0.26),rgba(30,10,45,0.35)_55%,transparent_80%)]" />
      <OrbisCore
        className="absolute inset-0"
        look={look.visual}
        pointer={pointer}
        audioLevel={audioLevel}
        fallback={<JarvisCore state={activity as CoreState} size={200} />}
      />
      <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-[38%] bg-gradient-to-t from-[#05030b] via-[#05030b]/55 to-transparent" />

      <div role="status" aria-live="polite" className="absolute inset-x-0 top-4 flex flex-wrap justify-center gap-x-8 gap-y-1 px-4 font-mono text-[10.5px] uppercase tracking-[0.22em] text-[#cbb8f0]/85">
        <span className="inline-flex items-center gap-2">
          <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full shadow-[0_0_8px_currentColor] transition-colors duration-700", tone)} />
          Core · {ACTIVITY_LABEL[activity]}
          {preview && <span className="text-[#ffd37a]">(preview)</span>}
        </span>
        <span className={vault ? "" : "text-[#cbb8f0]/45"}>{vault ? "Connected vault" : "Vault · offline"}</span>
        <span className={terminals ? "" : "text-[#cbb8f0]/45"}>Terminals · {terminals ? "connected" : "offline"}</span>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center px-4 pb-5 text-center">
        <h2 className="origin-bottom scale-y-[1.28] pl-[0.3em] text-[clamp(48px,9.5vw,108px)] font-extralight leading-none tracking-[0.3em] text-[#fbf7ff] [text-shadow:0_0_42px_rgba(217,70,239,0.32)]">
          ORBIS
        </h2>
        <p className="mt-4 font-mono text-[11px] tracking-[0.16em] text-[#cbb8f0]/70">Personal AI Intelligence</p>
        <div role="group" aria-label="Core state" className="mt-4 flex flex-wrap justify-center gap-1.5">
          {ORBIS_STATES.map((s) => pill(s))}
          <span aria-hidden className="mx-1 hidden w-px bg-[#c084fc]/20 sm:block" />
          {pill("auto")}
        </div>
      </div>
    </section>
  );
}
