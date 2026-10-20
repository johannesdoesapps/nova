/**
 * How the user likes replies in chat: length and style. Applied as an
 * instruction to the model, and (for short replies) a lower output limit.
 * Temperature isn't used: current reasoning models don't accept it.
 */

export const REPLY_LENGTHS = ["short", "normal", "detailed"] as const;
export type ReplyLength = (typeof REPLY_LENGTHS)[number];
export const REPLY_STYLES = ["precise", "balanced", "creative"] as const;
export type ReplyStyle = (typeof REPLY_STYLES)[number];

export const REPLY_LENGTH_LABEL: Record<ReplyLength, string> = { short: "Short", normal: "Normal", detailed: "Detailed" };
export const REPLY_STYLE_LABEL: Record<ReplyStyle, string> = { precise: "Precise", balanced: "Balanced", creative: "Creative" };

const LENGTH_TEXT: Record<ReplyLength, string | null> = {
  short: "Keep replies brief: a few sentences or a short list. Go longer only if the user asks for more or the task truly needs it (for example, code they asked for).",
  normal: null,
  detailed: "Give thorough replies: explain your reasoning, cover edge cases, and include examples where they help.",
};
const STYLE_TEXT: Record<ReplyStyle, string | null> = {
  precise: "Be precise and literal: stick to what's well established, give exact figures and definitions, avoid speculation and flourish, and say plainly when you're unsure.",
  balanced: null,
  creative: "Be imaginative: offer original ideas, varied phrasing and alternatives the user may not have considered, while staying accurate about facts.",
};

/** Extra system-prompt text for the user's settings (empty for the defaults). */
export function replyInstruction(length?: ReplyLength, style?: ReplyStyle): string {
  return [length && LENGTH_TEXT[length], style && STYLE_TEXT[style]].filter(Boolean).join("\n");
}

/** The longest reply for a setting, within the plan's limit. */
export function replyTokens(planMax: number, length?: ReplyLength): number {
  return length === "short" ? Math.min(planMax, Math.max(400, Math.round(planMax * 0.4))) : planMax;
}
