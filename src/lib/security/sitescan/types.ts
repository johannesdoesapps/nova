/**
 * Orbis website security scan: the shapes every check reports in. A check always says what happened, so a report
 * can never hide what wasn't looked at:
 *
 * - passed       the check ran and the site met it (evidence attached)
 * - failed       the check ran and found a problem (evidence attached); "confirmed" says whether it was observed
 *                directly or inferred from other evidence
 * - warning      ran; not a failure but worth attention (e.g. certificate expires in 3 weeks)
 * - info         ran; reported for context, no judgement
 * - skipped      not run on purpose (e.g. exposure probes in passive scope, TLS 1.0 ciphers when TLS 1.0 is off)
 * - inconclusive ran but couldn't decide (timeout, ambiguous answer)
 * - untested     Orbis can't test this (its TLS client can't speak SSLv3, crafted-packet vulnerability tests, …)
 */

export type CheckStatus = "passed" | "failed" | "warning" | "info" | "skipped" | "inconclusive" | "untested";
export type CheckSeverity = "critical" | "high" | "medium" | "low" | "info";
export type CheckCategory = "tls" | "certificate" | "headers" | "cookies" | "content" | "dns" | "exposure" | "server";

export const CATEGORY_LABEL: Record<CheckCategory, string> = {
  tls: "SSL/TLS",
  certificate: "Certificate",
  headers: "HTTP security headers",
  cookies: "Cookies",
  content: "Content",
  dns: "DNS",
  exposure: "Exposed files",
  server: "Web server configuration",
};

export interface Evidence {
  label: string;
  value: string;
}

export interface CheckResult {
  id: string;
  category: CheckCategory;
  title: string;
  status: CheckStatus;
  /** How serious a failure is (for passed/info checks, how serious it would have been). */
  severity: CheckSeverity;
  /** For failures: seen directly (true) or inferred from other evidence (false). */
  confirmed: boolean;
  summary: string;
  evidence: Evidence[];
  remediation: string | null;
  references: string[];
}

export type GradeLetter = "A+" | "A" | "B" | "C" | "D" | "F";

export interface Grade {
  /** 0–100, from the documented deductions (see grade.ts). */
  score: number;
  letter: GradeLetter;
  /** The two halves of the score: transport security (TLS + certificate) and web configuration. */
  parts: { tls: number; web: number };
  /** Why the letter is lower than the score alone would give. */
  caps: string[];
  /** What earned (or blocked) the A+. */
  plus: string | null;
  method: string;
}

export interface CertificateSummary {
  subject: string;
  issuer: string;
  names: string[];
  validFrom: string;
  validTo: string;
  daysLeft: number;
  key: string;
  signature: string;
  trusted: boolean;
  chain: { subject: string; issuer: string; validTo: string; key: string; signature: string }[];
}

export interface ScanReport {
  version: 1;
  /** The stored run this report belongs to (set once saved). */
  runId?: string;
  host: string;
  scope: "passive" | "active";
  startedAt: string;
  finishedAt: string;
  addresses: string[];
  grade: Grade | null;
  /** Why there's no grade (e.g. the site couldn't be reached over HTTPS). */
  gradeNote: string | null;
  checks: CheckResult[];
  certificate: CertificateSummary | null;
  protocols: Record<string, "supported" | "not supported" | "untested" | "inconclusive">;
  ciphers: { protocol: string; name: string; strength: "strong" | "acceptable" | "weak" | "insecure"; forwardSecrecy: boolean }[];
  requests: number;
  handshakes: number;
  durationMs: number;
  notes: string[];
  /** What a scan like this can't cover (shown so a clean report isn't read as "secure"). */
  notCovered: string[];
  /** The report was shortened to fit storage (full details are in the findings and the Markdown report). */
  trimmed?: boolean;
}

export const SEVERITY_RANK: Record<CheckSeverity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

/** A small helper so checks read like sentences. */
export function check(c: Omit<CheckResult, "evidence" | "remediation" | "references" | "confirmed"> & Partial<Pick<CheckResult, "evidence" | "remediation" | "references" | "confirmed">>): CheckResult {
  return { evidence: [], remediation: null, references: [], confirmed: true, ...c };
}
