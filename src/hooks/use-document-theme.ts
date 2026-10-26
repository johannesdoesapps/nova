"use client";
import { useSyncExternalStore } from "react";

function subscribe(cb: () => void) {
  const obs = new MutationObserver(cb);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => obs.disconnect();
}
const read = (): "dark" | "light" => (document.documentElement.dataset.theme === "light" ? "light" : "dark");

/** The theme in use (`<html data-theme>`). Renders "dark", the default, on the server and during hydration. */
export function useDocumentTheme(): "dark" | "light" {
  return useSyncExternalStore(subscribe, read, () => "dark");
}
