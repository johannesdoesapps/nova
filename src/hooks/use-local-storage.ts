"use client";
import { useCallback, useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
function subscribe(cb: () => void) {
  listeners.add(cb);
  const onStorage = () => cb();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}
function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * SSR-safe localStorage string value. Renders `fallback` on the server and
 * during hydration, then the stored value. Storage errors are ignored.
 */
export function useLocalStorage(key: string, fallback: string | null = null): [string | null, (v: string) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => read(key) ?? fallback,
    () => fallback,
  );
  const set = useCallback(
    (v: string) => {
      try {
        localStorage.setItem(key, v);
      } catch {
        /* storage unavailable */
      }
      listeners.forEach((l) => l());
    },
    [key],
  );
  return [value, set];
}
