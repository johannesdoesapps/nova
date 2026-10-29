import { clipText, messageSize, toJsonChat, type TranscriptMessage } from "./protocol";

/**
 * Compacting a session's conversation: the model writes a summary of everything after the first message (the
 * request and the project), and the conversation continues from the first message plus that summary. Asked for
 * with /compact (optionally saying what to keep), or done automatically when the conversation fills most of the
 * room the plan gives it. Files aren't touched; the summary says what changed so the agent re-reads what it needs.
 */

export const COMPACT_SYSTEM = `You summarise a coding session between a user and Orbis's coding agent so the agent can carry on with less context. You are given the conversation after the user's first message: the agent's thinking, the tools it called and their results, and any later messages from the user.

Write a summary the agent can work from, in this order:
1. What the user asked for, including every later message or correction from them (quote short instructions exactly).
2. What has been done: files created, changed or deleted (paths), commands and tests run and their results, checks that passed or failed.
3. Decisions made and why, and anything the user approved or declined.
4. What is still to do, problems not yet solved, and the next step.
Be specific (paths, function names, error messages, exact commands). Don't invent anything that isn't in the conversation. Plain text with short headed sections, at most 600 words.`;

const INPUT_CHARS = 120_000;

/** Characters the whole conversation takes up. */
export const transcriptChars = (t: TranscriptMessage[]) => t.reduce((n, m) => n + messageSize(m), 0);

/** Compact automatically once the conversation fills 90% of its room (and has enough steps to be worth it). */
export function shouldAutoCompact(t: TranscriptMessage[], budgetChars: number): boolean {
  return t.length >= 8 && transcriptChars(t) > budgetChars * 0.9;
}

/** The conversation after the first message as text for the summary (the newest part when it's too long). */
export function compactionInput(t: TranscriptMessage[], focus?: string | null, maxChars = INPUT_CHARS): string {
  const rest = toJsonChat(t.slice(1)).map((m) => `${m.role === "assistant" ? "AGENT" : "USER / RESULTS"}:\n${clipText(m.content, 12_000)}`);
  const kept: string[] = [];
  let used = 0;
  for (let i = rest.length - 1; i >= 0; i--) {
    if (used + rest[i]!.length > maxChars) {
      kept.unshift(`(${i + 1} older messages left out; they're covered by any earlier summary in the first message)`);
      break;
    }
    used += rest[i]!.length;
    kept.unshift(rest[i]!);
  }
  return [focus?.trim() ? `When you summarise, keep in particular: ${focus.trim().slice(0, 500)}` : "", kept.join("\n\n---\n\n")].filter(Boolean).join("\n\n");
}

/** The conversation after compacting: the first message, with the summary added to it. */
export function applyCompaction(t: TranscriptMessage[], summary: string): TranscriptMessage[] {
  const first = t[0];
  if (!first) return t;
  const base = first.content.replace(/\n\n<session-summary>[\s\S]*<\/session-summary>[\s\S]*$/, "");
  return [
    {
      role: "user",
      content: `${base}\n\n<session-summary>\n${clipText(summary.trim(), 8_000)}\n</session-summary>\nThe conversation since the first message was summarised above to make room (by you, from the real conversation). The project's files are as they are now: re-read any file before changing it. Carry on from where the summary ends.`,
    },
  ];
}
