/**
 * OrbisStateManager: what the ORBIS core shows, and how it eases between states.
 *
 * Two inputs, kept apart so the core never pretends:
 * - setOrbisState(s): the assistant reports what it is really doing (Jarvis calls this from its own events).
 * - setOrbisMode(m): "auto" follows the assistant; a state name previews that look (labelled as a preview).
 * Speech can also send pulses (pulseOrbis) as words are spoken.
 */

export type OrbisState = "idle" | "listening" | "thinking" | "speaking" | "error";
export type OrbisMode = "auto" | OrbisState;
/** Extra assistant situations that look like one of the five states, with their own label. */
export type AssistantActivity = OrbisState | "working" | "approval" | "stopped";

export const ORBIS_STATES: OrbisState[] = ["idle", "listening", "thinking", "speaking", "error"];

export interface Visual {
  rotation: number; // radians per second
  noise: number; // displacement, in radii
  noiseSpeed: number;
  glow: number; // centre glow 0–1+
  brightness: number;
  breathe: number; // breathing amplitude (scale)
  breatheRate: number; // Hz
  wave: number; // travelling displacement wave, in radii
  waveSpeed: number;
  flashRate: number; // flashes per second
  links: number; // link opacity
  autoPulse: number; // seconds between automatic brightness pulses (0: none)
  audio: number; // how much the audio level swells the core
  hue: number; // 0 green, 1 error, 2 warn, 3 dim
}

export const VISUALS: Record<OrbisState | "approval" | "stopped", Visual> = {
  idle: { rotation: 0.055, noise: 0.03, noiseSpeed: 0.22, glow: 0.55, brightness: 0.82, breathe: 0.022, breatheRate: 0.16, wave: 0.006, waveSpeed: 0.35, flashRate: 1.2, links: 0.3, autoPulse: 0, audio: 0, hue: 0 },
  listening: { rotation: 0.08, noise: 0.045, noiseSpeed: 0.42, glow: 0.72, brightness: 0.95, breathe: 0.01, breatheRate: 0.3, wave: 0.01, waveSpeed: 0.6, flashRate: 3, links: 0.36, autoPulse: 0, audio: 0.11, hue: 0 },
  thinking: { rotation: 0.15, noise: 0.055, noiseSpeed: 0.75, glow: 1.0, brightness: 1.05, breathe: 0.018, breatheRate: 0.5, wave: 0.022, waveSpeed: 1.4, flashRate: 6, links: 0.43, autoPulse: 1.1, audio: 0, hue: 0 },
  speaking: { rotation: 0.09, noise: 0.042, noiseSpeed: 0.45, glow: 0.85, brightness: 1.0, breathe: 0.012, breatheRate: 0.4, wave: 0.012, waveSpeed: 0.9, flashRate: 3, links: 0.37, autoPulse: 0, audio: 0.06, hue: 0 },
  error: { rotation: 0.03, noise: 0.028, noiseSpeed: 0.2, glow: 0.62, brightness: 0.78, breathe: 0.028, breatheRate: 0.5, wave: 0.004, waveSpeed: 0.3, flashRate: 0.6, links: 0.26, autoPulse: 0, audio: 0, hue: 1 },
  approval: { rotation: 0.04, noise: 0.03, noiseSpeed: 0.22, glow: 0.62, brightness: 0.86, breathe: 0.03, breatheRate: 0.35, wave: 0.006, waveSpeed: 0.35, flashRate: 1, links: 0.3, autoPulse: 0, audio: 0, hue: 2 },
  stopped: { rotation: 0.015, noise: 0.018, noiseSpeed: 0.12, glow: 0.25, brightness: 0.45, breathe: 0.01, breatheRate: 0.12, wave: 0, waveSpeed: 0.2, flashRate: 0.15, links: 0.16, autoPulse: 0, audio: 0, hue: 3 },
};

/** Which of the five looks (and which control) an assistant activity shows. */
export function lookFor(a: AssistantActivity): { state: OrbisState; visual: keyof typeof VISUALS } {
  if (a === "working") return { state: "thinking", visual: "thinking" };
  if (a === "approval") return { state: "idle", visual: "approval" };
  if (a === "stopped") return { state: "idle", visual: "stopped" };
  return { state: a, visual: a };
}

export const ACTIVITY_LABEL: Record<AssistantActivity, string> = {
  idle: "Idle",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  error: "Error",
  working: "Working",
  approval: "Awaiting approval",
  stopped: "Stopped",
};

/** Eases every value toward its target (exponential smoothing: no jumps, frame-rate independent). */
export function ease(current: Visual, target: Visual, dt: number, rate = 2.4): Visual {
  const k = 1 - Math.exp(-Math.max(0, dt) * rate);
  const out = { ...current };
  for (const key of Object.keys(target) as (keyof Visual)[]) out[key] = current[key] + (target[key] - current[key]) * k;
  return out;
}

/* The shared store ------------------------------------------------------------------------------------------ */

interface Snapshot {
  activity: AssistantActivity;
  mode: OrbisMode;
}
let snap: Snapshot = { activity: "idle", mode: "auto" };
const listeners = new Set<() => void>();
const pulseListeners = new Set<(strength: number) => void>();
const emit = () => listeners.forEach((l) => l());

/** The assistant reports its real activity. */
export function setOrbisState(activity: AssistantActivity) {
  if (snap.activity === activity) return;
  snap = { ...snap, activity };
  emit();
}

/** "auto" follows the assistant; a state previews that look. */
export function setOrbisMode(mode: OrbisMode) {
  if (snap.mode === mode) return;
  snap = { ...snap, mode };
  emit();
}

/** A brief wave of light from the centre (e.g. each spoken word). */
export function pulseOrbis(strength = 1) {
  pulseListeners.forEach((l) => l(strength));
}

export const orbisStore = {
  get: () => snap,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  onPulse(l: (strength: number) => void) {
    pulseListeners.add(l);
    return () => pulseListeners.delete(l);
  },
};

/** What the core shows now: the preview when one is chosen, else the assistant's real activity. */
export function effective(s: Snapshot): { activity: AssistantActivity; preview: boolean } {
  return s.mode === "auto" ? { activity: s.activity, preview: false } : { activity: s.mode, preview: true };
}
