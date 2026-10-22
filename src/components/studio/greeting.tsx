"use client";
import { useSyncExternalStore } from "react";
import { OrbisMark } from "./ui";

const noSubscribe = () => () => {};

/** "Good evening, Sam": the time of day, plus the first name of whoever is signed in (none for guests). */
export function greetingFor(hour: number, name: string | null | undefined): string {
  const part = hour < 5 || hour >= 18 ? "Good evening" : hour < 12 ? "Good morning" : "Good afternoon";
  const first = name?.trim().split(/\s+/)[0];
  return first ? `${part}, ${first}` : part;
}

/**
 * The Orbis logo with a greeting, at the top of the Chat and Code start
 * screens. `name` is the signed-in person's own name, so everyone sees theirs.
 */
export function Greeting({ name }: { name: string | null | undefined }) {
  // The hour is only known in the browser; render nothing on the server.
  const hour = useSyncExternalStore(
    noSubscribe,
    () => new Date().getHours(),
    () => null,
  );
  return (
    <>
      <OrbisMark className="s-in h-9 w-9" />
      <p className="s-in mt-6 h-5 text-[14px] text-s-ink-3 [animation-delay:40ms]">{hour === null ? null : greetingFor(hour, name)}</p>
    </>
  );
}
