/**
 * Application assessment modes and the pre-deployment gate. Pure.
 *
 * All four modes read an Orbis Code project's files with Code Guardian's rules; none runs the application, so
 * none is a runtime test. Runtime evidence comes only from Sentinel scans of a verified live site (or logs given
 * to Threat Hunter) and is labelled that way.
 */

export const APP_MODES = ["quick", "deep", "gate", "recheck"] as const;
export type AppMode = (typeof APP_MODES)[number];
export const APP_MODE_INFO: Record<AppMode, { label: string; does: string; network: boolean }> = {
  quick: { label: "Quick check", does: "Secret and insecure-code rules over the project's files. Seconds; nothing leaves Orbis.", network: false },
  deep: { label: "Deep assessment", does: "Quick check plus the application map (routes, access checks, configuration) and known-vulnerable dependencies (OSV.dev).", network: true },
  gate: { label: "Pre-deployment gate", does: "A deep assessment with a pass/fail decision against the gate's criteria. Static checks only.", network: true },
  recheck: { label: "Targeted recheck", does: "Re-runs the rules behind chosen findings to confirm whether a fix worked.", network: false },
};

/** Rule prefixes each mode checks (a finding can be marked "not detected" only by a mode that checked its prefix). */
export function checkedPrefixes(mode: AppMode, depsRan: boolean): string[] {
  const quick = ["secret.", "code.", "py.", "php.", "config."];
  if (mode === "quick") return quick;
  return [...quick, "map.", ...(depsRan ? ["deps."] : [])];
}

/** The mode a recheck needs for these rules: map and dependency findings need the deep checks. */
export const recheckDepth = (ruleIds: string[]): "quick" | "deep" => (ruleIds.some((r) => r.startsWith("map.") || r.startsWith("deps.")) ? "deep" : "quick");

export interface GateInput {
  rule_id: string;
  severity: string;
  confidence: string;
  status: string;
  title: string;
}

export const GATE_CRITERIA = [
  "No open critical finding.",
  "No open high finding that's confirmed or firm.",
  "No exposed credential (any secret finding).",
  "Static checks only: passing the gate doesn't mean the running application was tested.",
];

/** Pass/fail against the criteria, with every reason. Suppressed (accepted/false-positive) and resolved findings don't block. */
export function evaluateGate(findings: GateInput[], opts: { depsChecked: boolean }): { passed: boolean; reasons: string[]; blocking: number } {
  const open = findings.filter((f) => !["fixed", "verified", "false_positive", "accepted_risk"].includes(f.status));
  const block = open.filter((f) => f.severity === "critical" || (f.severity === "high" && f.confidence !== "tentative") || f.rule_id.startsWith("secret."));
  const reasons = block.slice(0, 10).map((f) => `${f.severity}: ${f.title}`);
  if (!opts.depsChecked) reasons.push("Dependencies weren't checked (OSV.dev couldn't be reached or no manifest was found) — the gate is incomplete.");
  return { passed: block.length === 0 && opts.depsChecked, reasons, blocking: block.length };
}
