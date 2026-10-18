import type { ChatMessage } from "./types";

/**
 * Every turn resends the conversation, so long chats cost more on each reply.
 * Keep only the most recent messages that fit the budget, starting on a user
 * turn so the model never sees an orphaned reply.
 */
export function trimHistory(history: ChatMessage[], maxMessages = 20, maxChars = 24_000): ChatMessage[] {
  const kept: ChatMessage[] = [];
  let chars = 0;
  for (let i = history.length - 1; i >= 0 && kept.length < maxMessages; i--) {
    const m = history[i]!;
    if (m.role === "system") continue;
    if (chars + m.content.length > maxChars && kept.length > 0) break;
    chars += m.content.length;
    kept.unshift(m);
  }
  while (kept.length && kept[0]!.role !== "user") kept.shift();
  return kept;
}
