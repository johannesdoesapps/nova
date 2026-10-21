"use client";
import { postNdjson } from "@/hooks/use-ndjson";

export interface StepResult {
  text: string;
  latencyMs: number | null;
  usage: { inputTokens: number | null; outputTokens: number | null; estimated: boolean } | null;
  estimatedCost: number | null;
  simulated: boolean;
}

type StepEvent =
  | { type: "meta"; model: { id: string; displayName: string } }
  | { type: "delta"; text: string }
  | ({ type: "done" } & StepResult)
  | { type: "error"; message: string };

/**
 * Run one Council/Arena step (answer, critique, improve, synthesize) and
 * stream its text into `onText`. Resolves with timing and usage, rejects with
 * the server's plain-language error, or with an AbortError when cancelled.
 */
export async function runStep(path: "answer" | "critique" | "improve" | "synthesize", body: unknown, signal: AbortSignal, onText: (text: string) => void): Promise<StepResult> {
  let text = "";
  for await (const ev of postNdjson<StepEvent>(`/api/council/${path}`, body, signal)) {
    if (ev.type === "delta") {
      text += ev.text;
      onText(text);
    } else if (ev.type === "done") {
      onText(ev.text || text);
      return { ...ev, text: ev.text || text };
    } else if (ev.type === "error") throw new Error(ev.message);
  }
  throw new Error("The response ended unexpectedly.");
}

export const LABELS = ["Response A", "Response B", "Response C", "Response D"] as const;

export function isAbort(e: unknown): boolean {
  return (e as Error)?.name === "AbortError";
}

/** A model's error in plain words (timeouts said as such). */
export function friendlyError(message: string): string {
  return /timed? ?out|timeout|aborted due to timeout/i.test(message) ? "Timed out: the model took longer than about a minute." : message;
}
