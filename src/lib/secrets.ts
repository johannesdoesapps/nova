/**
 * Recognising credentials in text, so they're never kept in agent or chat memory, audit records or logs.
 * Pure (no server code): used by the memory stores, the audit log and the tests.
 *
 * Memory refuses text with a secret in it rather than saving a redacted copy: a half-kept key is still a
 * leak, and the person should store it where secrets belong (environment variables).
 */

export const SECRET_PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: "AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/ },
  { kind: "Stripe key", re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { kind: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: "OpenAI-style API key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}/ },
  { kind: "API key", re: /\b(?:xai|gsk|hf)[-_][A-Za-z0-9_-]{20,}/ },
  { kind: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { kind: "Google API key", re: /\bAIza[0-9A-Za-z_-]{30,}/ },
  { kind: "JSON web token", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { kind: "Supabase key", re: /\b(?:sb_secret|sbp)_[A-Za-z0-9_-]{20,}/ },
  { kind: "bearer token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/i },
  { kind: "connection string with a password", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]{3,}@[^\s/]+/i },
  // "password = hunter2", "API_KEY: abc…": a credential name followed by a value (not a sentence about passwords).
  { kind: "password or key value", re: /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\b["']?\s*[:=]\s*["']?[^\s"']{6,}/i },
];

/** The kinds of credential found in the text (empty when there are none). */
export function findSecrets(text: string): string[] {
  return [...new Set(SECRET_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.kind))];
}

/** The text with every credential replaced, for records that must keep the rest (audit details, logs). */
export function redactAll(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS) out = out.replace(new RegExp(p.re.source, p.re.flags.includes("g") ? p.re.flags : `${p.re.flags}g`), `[redacted ${p.kind}]`);
  return out;
}

/** The message shown when memory refuses a secret. */
export function secretRefusal(kinds: string[]): string {
  return `This looks like it contains a secret (${kinds.join(", ")}), so it wasn't saved. Keep passwords and keys in your project's environment variables, not in memory.`;
}
