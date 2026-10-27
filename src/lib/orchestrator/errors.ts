import { ApiError } from "../http";
import { redact } from "../workforce/redact";

/**
 * What went wrong in an execution, and whether trying again could help. Retries are bounded by the task's
 * max attempts; errors that would happen again (bad credentials, an unknown model, the owner's plan allowance, a
 * request the provider rejects) are never retried. Messages are safe to store and show: providers' raw error text
 * is never included (it can echo key fragments), and anything credential-like is redacted.
 */
export type ErrorKind =
  | "auth"
  | "not_configured"
  | "model_unavailable"
  | "rate_limit"
  | "timeout"
  | "network"
  | "outage"
  | "billing"
  | "quota"
  | "bad_request"
  | "output_invalid"
  | "cancelled"
  | "internal";

export interface Classified {
  kind: ErrorKind;
  retryable: boolean;
  message: string;
}

/** An error the orchestrator raises itself, with its kind decided up front. */
export class OrchError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

const safe = (m: string) => redact(m).slice(0, 1000);

export function classifyError(err: unknown): Classified {
  if (err instanceof OrchError) return { kind: err.kind, retryable: err.retryable, message: safe(err.message) };
  if (err instanceof ApiError) {
    const m = safe(err.message);
    switch (err.code) {
      case "not_configured":
        // Missing or rejected credentials (providers map 401/403 here): retrying can't fix it.
        return { kind: "auth", retryable: false, message: m };
      case "rate_limited":
        return { kind: "rate_limit", retryable: true, message: m };
      case "timeout":
        return { kind: "timeout", retryable: true, message: m };
      case "upstream_error":
        return { kind: /reach|network|connect/i.test(err.message) ? "network" : "outage", retryable: true, message: m };
      case "provider_unavailable":
        return { kind: "billing", retryable: false, message: m };
      case "quota_exceeded":
      case "payment_required":
      case "plan_required":
        return { kind: "quota", retryable: false, message: m };
      case "payload_too_large":
      case "bad_request":
        return { kind: "bad_request", retryable: false, message: m };
      default:
        return { kind: "internal", retryable: true, message: m };
    }
  }
  const e = err as { name?: string; message?: string; code?: string; cause?: { code?: string } } | null;
  if (e?.name === "AbortError" || e?.name === "TimeoutError") return { kind: "timeout", retryable: true, message: "The model didn't answer within the agent's time limit." };
  if (e?.name === "TypeError" && /fetch failed|network/i.test(e.message ?? "")) return { kind: "network", retryable: true, message: "Couldn't reach the AI provider (network error)." };
  if (["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"].includes(e?.code ?? e?.cause?.code ?? "")) {
    return { kind: "network", retryable: true, message: "Couldn't reach the AI provider (network error)." };
  }
  return { kind: "internal", retryable: true, message: safe(e?.message || "Unexpected error.") };
}
