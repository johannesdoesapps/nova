"use client";
import { useSyncExternalStore } from "react";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { ANALYTICS_OFF_KEY } from "./site-analytics";

const noop = () => () => {};

/**
 * This browser's choice about anonymous visit counts: whether visits are
 * counted, whether the browser itself asks not to be tracked (then nothing is
 * counted whatever the choice), and a setter.
 */
export function useAnalyticsChoice(): { counted: boolean; browserSignal: boolean; setCounted: (on: boolean) => void } {
  const [off, setOff] = useLocalStorage(ANALYTICS_OFF_KEY);
  const browserSignal = useSyncExternalStore(
    noop,
    () => {
      const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
      return nav.globalPrivacyControl === true || nav.doNotTrack === "1";
    },
    () => false,
  );
  return { counted: off !== "1" && !browserSignal, browserSignal, setCounted: (on) => setOff(on ? "0" : "1") };
}
