/**
 * Blinding helpers. Identity leaks in blind trials come from three places:
 * the text itself ("As an OpenAI model…"), presentation order, and timing.
 * We redact self-identification, randomise order with a CSPRNG, and only show
 * both answers once both have finished (latency is revealed after the vote).
 */

const IDENTITY_PATTERNS: RegExp[] = [
  /\b(?:chat\s?gpt|gpt[-\s]?\d+(?:\.\d+)?(?:[-\s]?(?:mini|nano|turbo|o|pro))?|gpt-oss(?:-\d+b)?|o[134](?:-mini)?)\b/gi,
  /\b(?:openai|anthropic|claude(?:\s+(?:opus|sonnet|haiku|fable))?|google\s+deepmind|deepmind|gemini|bard|meta\s+ai|llama(?:\s?\d+(?:\.\d+)?)?|mistral(?:\s+ai)?|mixtral|qwen\d*|deepseek|grok|xai|cohere|command\s?r\+?|hugging\s?face|phi-\d)\b/gi,
];

export const REDACTION = "[model identity hidden]";

export function redactIdentity(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const re of IDENTITY_PATTERNS) {
    out = out.replace(re, () => {
      count++;
      return REDACTION;
    });
  }
  return { text: out, count };
}

/** Fisher–Yates with a cryptographically secure source (Web Crypto works in Node 20+ and browsers). */
export function secureShuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    const j = buf[0]! % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Pick two distinct models at random (for "surprise me" trials). */
export function randomPair<T>(items: T[]): [T, T] | null {
  if (items.length < 2) return null;
  const s = secureShuffle(items);
  return [s[0]!, s[1]!];
}
