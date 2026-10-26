/**
 * The Orbis website grade. It is Orbis's own, documented method, inspired by SSL Labs' idea of a letter grade with
 * hard caps for serious problems; it does NOT reproduce SSL Labs' rating methodology and the two can differ.
 *
 * 1. Two part scores start at 100: transport (TLS and certificate checks) and web (headers, cookies, content, server,
 *    exposed files, DNS). Each check deducts by severity: failed = critical 40, high 25, medium 12, low 4;
 *    a warning deducts half of that; a failure inferred rather than observed (confirmed: false) deducts half.
 *    passed, info, skipped, inconclusive and untested checks deduct nothing. Parts are floored at 0.
 * 2. score = round(0.6 × transport + 0.4 × web).
 * 3. Letter from the score: A ≥ 90, B ≥ 80, C ≥ 65, D ≥ 50, else F.
 * 4. Caps (the letter can't be better than): any confirmed critical failure → F; any confirmed high failure → C;
 *    TLS 1.0/1.1 accepted, no forward secrecy for modern clients, or DH groups under 2048 bits → B.
 * 5. A+ = an A with no caps, HSTS of at least 180 days, TLS 1.3 supported and no warnings in the transport checks.
 * 6. No grade when HTTPS couldn't be reached or no certificate was received: there's nothing to grade.
 * Checks that weren't run never count in either direction, so the grade only describes what was tested.
 */
import type { CheckCategory, CheckResult, CheckSeverity, Grade, GradeLetter } from "./types";

export const GRADE_METHOD =
  "Orbis grade (not SSL Labs): transport and web scores start at 100 and lose points per failed check by severity (critical 40, high 25, medium 12, low 4; warnings and inferred failures count half); score = 60% transport + 40% web; A ≥ 90, B ≥ 80, C ≥ 65, D ≥ 50; confirmed critical → F, confirmed high → at most C, legacy TLS / no forward secrecy / weak DH → at most B; A+ needs an uncapped A, HSTS ≥ 180 days, TLS 1.3 and no transport warnings. Untested checks don't count.";

const POINTS: Record<CheckSeverity, number> = { critical: 40, high: 25, medium: 12, low: 4, info: 0 };
const TRANSPORT: CheckCategory[] = ["tls", "certificate"];
const ORDER: GradeLetter[] = ["F", "D", "C", "B", "A", "A+"];
const worse = (a: GradeLetter, b: GradeLetter) => (ORDER.indexOf(a) <= ORDER.indexOf(b) ? a : b);

export function deduction(c: CheckResult): number {
  const base = POINTS[c.severity];
  if (c.status === "failed") return c.confirmed ? base : base / 2;
  if (c.status === "warning") return base / 2;
  return 0;
}

export function gradeChecks(checks: CheckResult[]): { grade: Grade | null; note: string | null } {
  const byId = new Map(checks.map((c) => [c.id, c]));
  if (byId.get("https.available")?.status === "inconclusive" && !byId.get("cert.trusted"))
    return { grade: null, note: "No grade: the website couldn't be reached over HTTPS, so there was nothing to grade." };
  if (!byId.get("cert.trusted")) return { grade: null, note: "No grade: no certificate was received, so the transport security couldn't be assessed." };

  const part = (inTransport: boolean) => Math.max(0, 100 - checks.filter((c) => TRANSPORT.includes(c.category) === inTransport).reduce((n, c) => n + deduction(c), 0));
  const tls = Math.round(part(true));
  const web = Math.round(part(false));
  const score = Math.round(0.6 * tls + 0.4 * web);
  let letter: GradeLetter = score >= 90 ? "A" : score >= 80 ? "B" : score >= 65 ? "C" : score >= 50 ? "D" : "F";
  const caps: string[] = [];
  const cap = (to: GradeLetter, why: string) => {
    letter = worse(letter, to);
    caps.push(`${why} (at most ${to})`);
  };
  for (const c of checks.filter((c) => c.status === "failed" && c.confirmed && c.severity === "critical")) cap("F", c.title);
  for (const c of checks.filter((c) => c.status === "failed" && c.confirmed && c.severity === "high")) cap("C", c.title);
  if (byId.get("tls.legacy-protocols")?.status === "failed") cap("B", "TLS 1.0/1.1 accepted");
  if (byId.get("tls.forward-secrecy")?.status === "failed") cap("B", "No forward secrecy for modern clients");
  if (byId.get("tls.dh-strength")?.status === "failed") cap("B", "Diffie-Hellman group under 2048 bits");

  let plus: string | null = null;
  if (letter === "A") {
    const hsts = byId.get("headers.hsts");
    const missing = [
      hsts?.status !== "passed" && "HSTS of at least 180 days",
      byId.get("tls.tls13")?.status !== "passed" && "TLS 1.3",
      checks.some((c) => TRANSPORT.includes(c.category) && c.status === "warning") && "no transport warnings",
    ].filter(Boolean) as string[];
    if (!missing.length && !caps.length) {
      letter = "A+";
      plus = "A+: HSTS for 180+ days, TLS 1.3 and no transport warnings.";
    } else if (missing.length) plus = `Not A+: needs ${missing.join(", ")}.`;
  }
  return { grade: { score, letter, parts: { tls, web }, caps, plus, method: GRADE_METHOD }, note: null };
}
