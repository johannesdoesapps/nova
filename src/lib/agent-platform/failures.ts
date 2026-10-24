/**
 * Why a task failed, from its recorded error (and the coding agent's failure kind when there is one), and
 * what recovery makes sense. Retrying only helps a transient failure or a wrong approach; a permission,
 * setup, input or limit problem fails the same way again, so those go back to the person with what to change.
 *
 * Pure and rule-based: the same error always gets the same answer, and the tests pin it down.
 */

export const FAILURE_CLASSES = ["transient", "permission", "setup", "invalid_input", "limit", "strategy", "unknown"] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

export interface FailureInfo {
  class: FailureClass;
  label: string;
  /** Trying the same thing again may work. */
  retryable: boolean;
  /** What the person can do. */
  advice: string;
}

const INFO: Record<FailureClass, Omit<FailureInfo, "class">> = {
  transient: { label: "Temporary problem", retryable: true, advice: "A service was busy or didn't answer in time. Trying again usually works." },
  permission: { label: "Not allowed", retryable: false, advice: "Your plan or account doesn't allow this. Retrying won't change that; check your plan or sign in." },
  setup: { label: "Not set up", retryable: false, advice: "Something this task needs isn't set up on Orbis (a model provider, a connection or a computer). Retrying won't help until it is." },
  invalid_input: { label: "Request needs changing", retryable: false, advice: "Something in the request couldn't be used as given. Change it, then start again." },
  limit: { label: "Limit reached", retryable: false, advice: "A usage or task limit was reached. Wait for it to reset, raise the task's limit, or make the task smaller." },
  strategy: { label: "Approach didn't work", retryable: true, advice: "The agent's approach didn't work. Try again with more detail, a different model, or a smaller task." },
  unknown: { label: "Failed", retryable: true, advice: "Open the task to see what happened. One more try is reasonable; if it fails the same way, change the request." },
};

/** The coding agent's own failure kinds (code/agent/types.ts FailureKind). */
const BY_KIND: Record<string, FailureClass> = {
  no_model: "setup",
  provider_not_configured: "setup",
  provider_unavailable: "transient",
  provider_rejected: "invalid_input",
  refused: "strategy",
  unreadable_replies: "strategy",
  internal: "transient",
};

const RULES: [FailureClass, RegExp][] = [
  ["limit", /\b(limit (was )?reached|usage limit|out of (units|credits)|quota|budget|rate.?limit(ed)?|too many (requests|tasks)|step limit|token (budget|limit)|time limit|computer minutes)\b/i],
  [
    "permission",
    /\b((?:not|isn'?t|aren'?t) included in your plan|upgrade|plan_required|forbidden|not allowed|unauthori[sz]ed|sign in|permission|paused this agent|has paused|access denied|ownership)\b/i,
  ],
  ["setup", /\b(not (set up|configured)|isn'?t (set up|configured)|no (ai )?provider|missing (api )?key|not_configured|provider .*not available here)\b/i],
  [
    "transient",
    /\b(timed? ?out|timeout|temporar(y|ily)|try again (later|in a moment)|unavailable|overloaded|econnreset|network|socket|502|503|504|upstream|connection (reset|refused|closed)|couldn'?t reach|already working on this project|another task|busy)\b/i,
  ],
  ["invalid_input", /\b(invalid|not found|doesn'?t exist|too (long|large|big)|unsupported|couldn'?t (read|parse)|malformed|bad request|must be|is required|no such file)\b/i],
  ["strategy", /\b(same failure|failed (three|3) times|tests? (still )?fail(ed|ing)?|couldn'?t (fix|reproduce)|refused|unreadable|repeat(ed|ing)|went in circles|no progress)\b/i],
];

/** The class of a failure, from its error text and (for coding tasks) its recorded failure kind. */
export function classifyFailure(error: string | null | undefined, kind?: string | null): FailureInfo {
  const fromKind = kind ? BY_KIND[kind] : undefined;
  const text = error ?? "";
  const cls: FailureClass = fromKind ?? RULES.find(([, re]) => re.test(text))?.[0] ?? "unknown";
  return { class: cls, ...INFO[cls] };
}

/** Errors are the same failure when they read the same once numbers, ids and quoted values are set aside. */
export function sameFailure(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, "#")
      .replace(/\d+/g, "#")
      .replace(/["“”'`][^"“”'`]{0,80}["“”'`]/g, "…")
      .replace(/\s+/g, " ")
      .trim();
  return norm(a) === norm(b);
}

/**
 * Whether another attempt is worth it: the class is retryable, attempts are left, and the last two
 * attempts didn't fail the same way (repeating an identical failure is a loop, not a recovery).
 */
export function shouldRetry(errors: string[], attempts: number, maxAttempts: number, kind?: string | null): { retry: boolean; reason: string } {
  const last = errors[errors.length - 1] ?? null;
  const info = classifyFailure(last, kind);
  if (attempts >= maxAttempts) return { retry: false, reason: `It has been tried ${attempts} times.` };
  if (!info.retryable) return { retry: false, reason: info.advice };
  if (errors.length >= 2 && sameFailure(errors[errors.length - 1], errors[errors.length - 2]))
    return { retry: false, reason: "It failed the same way twice in a row, so trying again unchanged would only repeat it. Change the request or the model first." };
  return { retry: true, reason: info.advice };
}
