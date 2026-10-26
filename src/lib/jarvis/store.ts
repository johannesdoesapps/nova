import { isAutonomy, type Autonomy } from "./permissions";
import { JARVIS_MODES, type JarvisMode } from "./planner";
import type { Mission } from "./mission";

/**
 * Jarvis Mode's settings and mission history, kept in this browser only (nothing about your computer is sent to
 * Orbis's database). History keeps the request, the steps and their results (paths and summaries, never file
 * contents, clipboard text or screenshots) and can be cleared at any time.
 */

export const VOICE_PROFILES = [
  { id: "classic", name: "Classic Assistant", rate: 1, pitch: 1, style: "Composed and courteous; short sentences." },
  { id: "professional", name: "Professional", rate: 1, pitch: 0.95, style: "Formal, precise and brief." },
  { id: "calm", name: "Calm and Minimal", rate: 0.92, pitch: 0.9, style: "As few words as possible, unhurried." },
  { id: "futuristic", name: "Futuristic", rate: 1.05, pitch: 0.85, style: "Crisp and efficient, like a ship's computer, without catchphrases." },
  { id: "friendly", name: "Friendly Companion", rate: 1.04, pitch: 1.08, style: "Warm and encouraging, still concise." },
  { id: "executive", name: "Executive Assistant", rate: 1.08, pitch: 1, style: "Bottom line first, then decisions needed." },
] as const;
export type VoiceProfileId = (typeof VOICE_PROFILES)[number]["id"];

/** A push-to-talk key combination, e.g. { key: "j", alt: true }. */
export interface Shortcut {
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export interface JarvisSettings {
  autonomy: Autonomy;
  mode: JarvisMode;
  voice: VoiceProfileId;
  speak: boolean;
  shortcut: Shortcut;
  /** Days to keep mission history (0: don't keep any). */
  keepDays: number;
}

export const DEFAULT_SHORTCUT: Shortcut = { key: "j", ctrl: false, alt: true, shift: false, meta: false };
export const DEFAULT_SETTINGS: JarvisSettings = { autonomy: 3, mode: "jarvis", voice: "classic", speak: true, shortcut: DEFAULT_SHORTCUT, keepDays: 30 };

const SETTINGS_KEY = "orbis:jarvis:settings";
const HISTORY_KEY = "orbis:jarvis:missions";
const HALT_KEY = "orbis:jarvis:halted";
const MAX_HISTORY = 50;

function read(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}
function write(key: string, v: unknown) {
  try {
    if (v === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage unavailable: settings last for this page only */
  }
}

function validShortcut(v: unknown): v is Shortcut {
  const s = v as Shortcut;
  return !!s && typeof s.key === "string" && s.key.length >= 1 && s.key.length <= 20 && ["ctrl", "alt", "shift", "meta"].every((k) => typeof s[k as keyof Shortcut] === "boolean");
}

export function parseSettings(v: unknown): JarvisSettings {
  const s = (v ?? {}) as Partial<JarvisSettings>;
  return {
    autonomy: isAutonomy(s.autonomy) ? s.autonomy : DEFAULT_SETTINGS.autonomy,
    mode: JARVIS_MODES.some((m) => m.id === s.mode) ? (s.mode as JarvisMode) : DEFAULT_SETTINGS.mode,
    voice: VOICE_PROFILES.some((p) => p.id === s.voice) ? (s.voice as VoiceProfileId) : DEFAULT_SETTINGS.voice,
    speak: typeof s.speak === "boolean" ? s.speak : DEFAULT_SETTINGS.speak,
    shortcut: validShortcut(s.shortcut) ? s.shortcut : DEFAULT_SHORTCUT,
    keepDays: typeof s.keepDays === "number" && [0, 1, 7, 30, 90].includes(s.keepDays) ? s.keepDays : DEFAULT_SETTINGS.keepDays,
  };
}

export const loadSettings = () => parseSettings(read(SETTINGS_KEY));
export const saveSettings = (s: JarvisSettings) => write(SETTINGS_KEY, s);

/** Missions to keep: within the retention period, newest first, without clipboard text or screen answers. */
export function trimHistory(list: Mission[], keepDays: number, now = Date.now()): Mission[] {
  if (keepDays <= 0) return [];
  const cutoff = now - keepDays * 86_400_000;
  return list
    .filter((m) => Date.parse(m.createdAt) >= cutoff)
    .slice(0, MAX_HISTORY)
    .map((m) => ({
      ...m,
      steps: m.steps.map((s) => (s.result?.details?.kind === "text" ? { ...s, result: { ...s.result, summary: s.tool === "look_at_screen" ? "Answered a question about the screen." : s.result.summary, details: undefined } } : s)),
    }));
}

export function loadHistory(keepDays: number): Mission[] {
  const v = read(HISTORY_KEY);
  return Array.isArray(v) ? trimHistory(v.filter((m) => m && typeof m.id === "string" && Array.isArray(m.steps)) as Mission[], keepDays) : [];
}
export const saveHistory = (list: Mission[], keepDays: number) => write(HISTORY_KEY, trimHistory(list, keepDays));
export const clearHistory = () => write(HISTORY_KEY, null);

/** The emergency stop survives reloads: automation stays off until the user resumes it. */
export const loadHalted = () => read(HALT_KEY) === true;
export const saveHalted = (v: boolean) => write(HALT_KEY, v ? true : null);

export function shortcutLabel(s: Shortcut, mac: boolean): string {
  const key = s.key === " " ? "Space" : s.key.length === 1 ? s.key.toUpperCase() : s.key;
  return [s.ctrl && (mac ? "⌃" : "Ctrl"), s.alt && (mac ? "⌥" : "Alt"), s.shift && (mac ? "⇧" : "Shift"), s.meta && (mac ? "⌘" : "Win"), key].filter(Boolean).join(mac ? "" : "+");
}

/** Combinations browsers or systems keep for themselves (a warning, not a block). */
export function shortcutConflict(s: Shortcut): string | null {
  const k = s.key.toLowerCase();
  const mod = s.ctrl || s.meta;
  if (!s.ctrl && !s.alt && !s.meta && !s.shift && k.length === 1) return "A single letter would trigger while typing. Add Ctrl, Alt or ⌘.";
  if (mod && ["t", "w", "n", "q", "l", "r", "tab", "c", "v", "x", "a", "z", "f", "p", "s"].includes(k)) return "Browsers and apps already use this for common commands.";
  if (s.alt && k === " ") return "Windows uses Alt+Space for the window menu.";
  if (s.meta && k === " ") return "macOS uses ⌘Space for Spotlight.";
  if (s.ctrl && k === " ") return "macOS uses Ctrl+Space to switch input sources.";
  return null;
}

/** Whether a key event matches the shortcut's key and modifiers. */
export function matchesShortcut(e: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">, s: Shortcut): boolean {
  // With Alt (Option) held, macOS changes the character typed, so letters are matched by their physical key.
  const key = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : /^Digit\d$/.test(e.code) ? e.code.slice(5) : e.code === "Space" ? " " : e.key.toLowerCase();
  return key === s.key.toLowerCase() && e.ctrlKey === s.ctrl && e.altKey === s.alt && e.shiftKey === s.shift && e.metaKey === s.meta;
}
