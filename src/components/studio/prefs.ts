"use client";
/** Per-device preferences: theme, chat settings, saved prompts and feedback. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { CHAT_MODES, type ChatMode } from "@/lib/ai/modes";

function useStoredJson<T>(key: string, fallback: T, valid: (v: unknown) => v is T): [T, (v: T) => void] {
  const [raw, setRaw] = useLocalStorage(key);
  const value = useMemo(() => {
    if (!raw) return fallback;
    try {
      const v = JSON.parse(raw) as unknown;
      return valid(v) ? v : fallback;
    } catch {
      return fallback;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw]);
  const set = useCallback((v: T) => setRaw(JSON.stringify(v)), [setRaw]);
  return [value, set];
}

/* Theme ------------------------------------------------------------------ */

export type ThemePref = "light" | "dark" | "system";

function systemDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyTheme(pref: ThemePref) {
  const html = document.documentElement;
  html.classList.add("theming");
  html.dataset.theme = pref === "dark" || (pref === "system" && systemDark()) ? "dark" : "light";
  window.setTimeout(() => html.classList.remove("theming"), 400);
}

export function useTheme() {
  const [stored, setStored] = useLocalStorage("nova:theme", "dark");
  const pref: ThemePref = stored === "light" || stored === "system" ? stored : "dark";
  const [resolved, setResolved] = useState<"light" | "dark">("dark");

  useEffect(() => {
    const sync = () => setResolved(document.documentElement.dataset.theme === "light" ? "light" : "dark");
    sync();
    if (pref !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      applyTheme("system");
      sync();
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref]);

  const setTheme = useCallback(
    (p: ThemePref) => {
      setStored(p);
      applyTheme(p);
      setResolved(document.documentElement.dataset.theme === "light" ? "light" : "dark");
    },
    [setStored],
  );
  return { pref, resolved, setTheme };
}

/* Chat settings ---------------------------------------------------------- */

export interface StudioSettings {
  enterToSend: boolean;
  defaultMode: ChatMode;
  /** Let another compatible model answer if the chosen one fails (only when the site allows fallback). */
  allowFallback?: boolean;
}

const DEFAULT_SETTINGS: StudioSettings = { enterToSend: true, defaultMode: "research", allowFallback: false };

export function useSettings() {
  const [value, set] = useStoredJson<StudioSettings>("nova:studio:settings", DEFAULT_SETTINGS, (v): v is StudioSettings => {
    const s = v as StudioSettings;
    return !!s && typeof s.enterToSend === "boolean" && (CHAT_MODES as readonly string[]).includes(s.defaultMode);
  });
  const update = useCallback((patch: Partial<StudioSettings>) => set({ ...value, ...patch }), [set, value]);
  return [value, update] as const;
}

/* Saved prompts ---------------------------------------------------------- */

export interface SavedPrompt {
  id: string;
  text: string;
  createdAt: string;
}

export function useSavedPrompts() {
  const [prompts, set] = useStoredJson<SavedPrompt[]>("nova:studio:prompts", [], (v): v is SavedPrompt[] => Array.isArray(v));
  const add = useCallback(
    (text: string) => {
      const t = text.trim().slice(0, 4000);
      if (!t || prompts.some((p) => p.text === t)) return false;
      set([{ id: crypto.randomUUID(), text: t, createdAt: new Date().toISOString() }, ...prompts].slice(0, 100));
      return true;
    },
    [prompts, set],
  );
  const remove = useCallback((id: string) => set(prompts.filter((p) => p.id !== id)), [prompts, set]);
  return { prompts, add, remove };
}

/* Feedback --------------------------------------------------------------- */

export type Feedback = "up" | "down";

/** Thumbs up/down on replies, kept on this device. */
export function useFeedback() {
  const [map, set] = useStoredJson<Record<string, Feedback>>(
    "nova:studio:feedback",
    {},
    (v): v is Record<string, Feedback> => !!v && typeof v === "object" && !Array.isArray(v),
  );
  const give = useCallback(
    (id: string, f: Feedback) => {
      const next = { ...map };
      if (next[id] === f) delete next[id];
      else next[id] = f;
      const keys = Object.keys(next);
      if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete next[k];
      set(next);
    },
    [map, set],
  );
  return { feedback: map, give };
}
