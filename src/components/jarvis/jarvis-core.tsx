import { cn } from "@/lib/utils";

export type CoreState = "idle" | "listening" | "thinking" | "working" | "approval" | "speaking" | "error" | "stopped";

export const CORE_LABEL: Record<CoreState, string> = {
  idle: "Ready",
  listening: "Listening…",
  thinking: "Thinking…",
  working: "Working…",
  approval: "Waiting for your approval",
  speaking: "Speaking…",
  error: "Something went wrong",
  stopped: "Automation stopped",
};

/**
 * Orbis's core: rings that show what Jarvis is really doing right now (it only moves when something is
 * happening). With reduced motion it keeps the colours and drops the movement.
 */
export function JarvisCore({ state, size = 176 }: { state: CoreState; size?: number }) {
  const tone =
    state === "approval"
      ? "text-amber-400"
      : state === "error"
        ? "text-s-danger"
        : state === "stopped"
          ? "text-s-ink-3"
          : state === "listening" || state === "speaking"
            ? "text-sky-400"
            : "text-s-accent";
  return (
    <div className={cn("jarvis-core relative grid shrink-0 place-items-center", tone, `jarvis-${state}`)} style={{ width: size, height: size }} aria-hidden>
      <span className="jarvis-ring jarvis-ring-outer absolute inset-0 rounded-full border border-current opacity-25" />
      <span className="jarvis-ring jarvis-ring-arc absolute inset-[9%] rounded-full border-2 border-transparent border-t-current border-r-current opacity-70" />
      <span className="jarvis-ring jarvis-ring-inner absolute inset-[20%] rounded-full border border-current opacity-40" />
      <span className="jarvis-glow absolute inset-[30%] rounded-full bg-current opacity-20 blur-xl" />
      <span className="jarvis-heart relative h-[26%] w-[26%] rounded-full bg-current opacity-90 shadow-[0_0_40px_currentColor]" />
    </div>
  );
}
