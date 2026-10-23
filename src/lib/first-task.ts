import { track } from "@vercel/analytics";

/**
 * A new account's first task, counted anonymously (Vercel Web Analytics) so
 * the activation funnel can be read: started, then succeeded or failed. Each
 * step is counted once per browser; only the kind of task and its outcome are
 * sent, never what was asked or the reply.
 */
export type FirstTaskStep = "started" | "succeeded" | "failed";

export function countFirstTask(step: FirstTaskStep, props: Record<string, string>): void {
  try {
    const key = `orbis:first-task:${step}`;
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, "1");
    track(`first_task_${step}`, props);
  } catch {
    /* not counted */
  }
}
