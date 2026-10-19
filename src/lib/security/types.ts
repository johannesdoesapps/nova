/** The shared, structured finding format every security agent produces. */

export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * How sure we are the finding is real — separate from how bad it would be.
 * confirmed: observed directly by a scanner/rule with unambiguous evidence.
 * firm: strong pattern match that usually indicates the issue.
 * tentative: heuristic or AI-suggested; needs a human to check.
 */
export const CONFIDENCES = ["confirmed", "firm", "tentative"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const FINDING_STATUSES = ["open", "investigating", "fix_proposed", "fixed", "accepted_risk", "verified", "false_positive"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export const VERIFICATIONS = ["not_verified", "still_present", "not_detected"] as const;
export type Verification = (typeof VERIFICATIONS)[number];

export const AGENT_IDS = ["sentinel", "threat_hunter", "code_guardian", "incident_responder", "threat_intel"] as const;
export type SecurityAgentId = (typeof AGENT_IDS)[number];

export interface Evidence {
  /** Where the evidence came from, e.g. "HTTP response headers", "src/app.ts:42", "auth.log line 118". */
  source: string;
  /** The observed data (headers, code line, log line). Secrets are masked. */
  detail: string;
}

/** A finding as produced by a tool, before it is stored. */
export interface FindingDraft {
  agent: SecurityAgentId;
  /** Stable rule identifier, e.g. "headers.hsts-missing" or "code.eval". */
  ruleId: string;
  /** Stable across scans of the same asset so re-scans update rather than duplicate. */
  fingerprint: string;
  title: string;
  description: string;
  severity: Severity;
  confidence: Confidence;
  /** Why this severity. */
  rationale: string;
  asset: string;
  location: string | null;
  evidence: Evidence[];
  /** Which tool produced it: "nova:headers", "nova:code-rules", "osv.dev", "nova:log-analyzer", "ai-review". */
  evidenceSource: string;
  remediation: string;
  references: string[];
  /** Tool-local keys of related drafts, resolved to ids when stored. */
  relatedKeys?: string[];
}

export interface ToolRun {
  tool: string;
  status: "ok" | "skipped" | "failed";
  detail: string;
  durationMs?: number;
}

export const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

/** Short, stable hash for fingerprints (FNV-1a, hex). Not for security purposes. */
export function fingerprint(...parts: (string | number | null | undefined)[]): string {
  let h = 0x811c9dc5;
  const s = parts.map((p) => String(p ?? "")).join("|");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let h2 = 0x9e3779b9;
  for (let i = s.length - 1; i >= 0; i--) {
    h2 ^= s.charCodeAt(i);
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  return `${(h >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0).toString(16).padStart(8, "0")}`;
}

/** Mask the middle of a secret so evidence never re-exposes it. */
export function maskSecret(s: string): string {
  if (s.length <= 8) return "•".repeat(s.length);
  return `${s.slice(0, 4)}${"•".repeat(Math.min(12, s.length - 6))}${s.slice(-2)}`;
}
