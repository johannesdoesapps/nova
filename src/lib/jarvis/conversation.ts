/**
 * Conversation mode: hands-free back-and-forth. Jarvis listens, sends what you said once you pause, replies, and
 * listens again. It never listens while it is speaking (so it can't hear itself), while it is working on a
 * request or mission, while you're typing, or while the tab is in the background.
 */

/** A pause this long after your last word ends your turn. */
export const END_OF_TURN_MS = 1300;
/** A listening round with no words at all ends after this long. */
export const QUIET_ROUND_MS = 15_000;
/** Conversation mode switches itself off after this many quiet rounds in a row (about 30 seconds of silence). */
export const QUIET_ROUNDS = 2;
/** A short gap before listening again, so the tail of Jarvis's own voice isn't picked up. */
export const RELISTEN_DELAY_MS = 350;

const STOP_PHRASES = new Set([
  "stop",
  "stop listening",
  "stop the conversation",
  "stop conversation",
  "end conversation",
  "end the conversation",
  "goodbye",
  "good bye",
  "bye",
  "thats all",
  "that is all",
  "thats it",
  "were done",
  "we are done",
  "im done",
  "never mind",
  "nevermind",
]);

/** Lower case, no punctuation, and without a leading "Jarvis", "OK", "thanks" and so on. */
function normalise(text: string): string {
  let t = text
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (let prev = ""; prev !== t; ) {
    prev = t;
    t = t.replace(/^(ok|okay|hey|thanks|thank you|alright|all right|jarvis|orbis)\s+/, "").replace(/\s+(jarvis|orbis|thanks|thank you)$/, "");
  }
  return t;
}

/**
 * Whether what you said means "end the conversation". Only the whole utterance counts, so a request that merely
 * contains the word ("stop the music", "say goodbye to Sam") is still sent.
 */
export function isStopPhrase(text: string): boolean {
  const t = normalise(text);
  return t.length > 0 && STOP_PHRASES.has(t);
}

export interface ListenGate {
  on: boolean;
  supported: boolean;
  listening: boolean;
  busy: boolean;
  speaking: boolean;
  visible: boolean;
  typing: boolean;
}

/** Whether conversation mode should start listening now. */
export function shouldListen(g: ListenGate): boolean {
  return g.on && g.supported && g.visible && !g.listening && !g.busy && !g.speaking && !g.typing;
}
