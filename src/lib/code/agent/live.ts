import type { AgentEvent } from "./types";

/**
 * Live updates for a run while a step request streams them to the page: the model's words as it writes them, and
 * each activity event as it's saved. Only within this server process (the request that is taking the step); the
 * activity log in the database stays the record, and the page still reads it to catch up after a reload.
 */
export type LiveMessage = { t: "step"; step: number } | { t: "text"; d: string } | { t: "model_done" } | { t: "events"; events: AgentEvent[] };

const watchers = new Map<string, Set<(m: LiveMessage) => void>>();

/** Receive a run's live updates until the returned function is called. */
export function watchRun(runId: string, fn: (m: LiveMessage) => void): () => void {
  let set = watchers.get(runId);
  if (!set) watchers.set(runId, (set = new Set()));
  set.add(fn);
  return () => {
    set.delete(fn);
    if (!set.size) watchers.delete(runId);
  };
}

export function emitLive(runId: string, m: LiveMessage): void {
  for (const fn of watchers.get(runId) ?? []) {
    try {
      fn(m);
    } catch {
      /* a watcher that has gone away doesn't stop the step */
    }
  }
}

export const hasWatchers = (runId: string) => (watchers.get(runId)?.size ?? 0) > 0;
