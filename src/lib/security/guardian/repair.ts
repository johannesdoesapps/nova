import { defectRuleById } from "./defects";
import type { ImpactReport } from "./impact";

/**
 * The task Code Guardian hands to the coding agent to repair an engineering finding. The coding agent does the
 * work in its own sandboxed copy of the repository, with plan approval and edit review on, so nothing changes
 * without the user's approval and nothing is pushed or deployed. The task spells out the root-cause workflow,
 * what the change could affect (from the impact analysis), which checks to run, what needs explicit approval,
 * and the report the agent must end with — implemented-but-unverified is an allowed outcome, "fixed" without
 * evidence is not.
 */

export interface RepairFinding {
  title: string;
  rule_id: string;
  severity: string;
  confidence: string;
  location: string | null;
  asset: string;
  description: string;
  remediation: string;
  evidence: { source: string; detail: string }[];
}

/** Changes that need the user's explicit go-ahead before the agent makes them. */
export function approvalNeeded(f: RepairFinding, impact: ImpactReport | null): string[] {
  const out: string[] = [];
  if (f.rule_id.startsWith("compat.")) out.push("Any dependency install, upgrade, removal or lockfile regeneration (say which versions change and why first).");
  if (impact?.concerns.some((c) => c.includes("database"))) out.push("Any database migration or data change.");
  if (impact?.concerns.some((c) => c.includes("authentication"))) out.push("Any change to authentication or authorisation behaviour.");
  if (impact?.concerns.some((c) => c.includes("CI"))) out.push("Any change to CI, build or deployment configuration.");
  if (f.rule_id.startsWith("arch.")) out.push("Moving code between modules or renaming exports used elsewhere (this is a refactor: list every file it touches first).");
  if ((impact?.affectedTotal ?? 0) >= 25) out.push(`Changing the exported interface of ${impact!.changed.map((c) => c.file).join(", ")} (${impact!.affectedTotal} files depend on it).`);
  out.push("Deleting files, or any change outside the files the fix needs.");
  return out;
}

export function repairTask(f: RepairFinding, impact: ImpactReport | null): string {
  const rule = defectRuleById(f.rule_id);
  const reproduce =
    rule?.test ??
    (f.rule_id.startsWith("compat.")
      ? "Run the install the way CI does (npm ci) and the build, and record the error before changing anything."
      : "Write a test (or a short script) that shows the current behaviour.");
  const lines = [
    `Repair this Code Guardian finding by fixing its root cause with the smallest correct change.`,
    "",
    `${f.title} (${f.severity}; confidence: ${f.confidence})`,
    `Where: ${f.location ?? f.asset}`,
    `Evidence: ${f.evidence
      .map((e) => `${e.source}: ${e.detail}`)
      .join(" | ")
      .slice(0, 600)}`,
    `Problem: ${f.description}`,
    `Suggested direction (verify it before following it): ${f.remediation}`,
    "",
  ];
  if (impact) {
    lines.push("What this change could affect (static import analysis):");
    lines.push(`- Risk: ${impact.risk} — ${impact.riskReasons.slice(0, 3).join(" ")}`);
    if (impact.affectedTotal)
      lines.push(
        `- ${impact.affectedTotal} file(s) depend on the changed code, e.g. ${impact.affected
          .slice(0, 6)
          .map((a) => a.file)
          .join(", ")}.`,
      );
    if (impact.entryPoints.length) lines.push(`- Entry points that reach it: ${impact.entryPoints.slice(0, 6).join(", ")}${impact.entryPoints.length > 6 ? ", …" : ""}.`);
    if (impact.tests.length)
      lines.push(
        `- Tests that exercise it: ${impact.tests
          .slice(0, 8)
          .map((t) => t.file)
          .join(", ")}.`,
      );
    else lines.push("- No existing test reaches this code.");
    for (const step of impact.plan.filter((p) => p.command)) lines.push(`- Check: ${step.command} (${step.why})`);
    lines.push("");
  }
  lines.push(
    "Work through these steps and keep the user informed:",
    "1. Detect: read the flagged code and its callers. If the finding is wrong (the pattern is intended or handled elsewhere), say why with evidence and change nothing.",
    `2. Reproduce: before editing, add a minimal test that fails because of this problem. ${reproduce} If you can't reproduce it, say so clearly and stop — don't claim a root cause from a plausible explanation.`,
    "3. Trace: follow the execution and data flow through the files involved.",
    "4. Isolate: name the smallest component or interaction responsible.",
    "5. Check alternatives: rule out other explanations for the symptom.",
    "6. Fix the root cause with the smallest change that follows the project's existing conventions. No unrelated refactoring or formatting changes; no new dependencies unless unavoidable.",
    "7. Test: run the reproducer (it must now pass) and the checks listed above, smallest first. If something fails, investigate why before changing anything else; stop after two unsuccessful attempts and explain what you found.",
    "8. Side effects: look at the dependents listed above for code that relied on the old behaviour, and at similar code elsewhere with the same root cause (list it; fix it only if it's the same cause).",
    "9. Report.",
    "",
    "Ask for approval before:",
    ...approvalNeeded(f, impact).map((a) => `- ${a}`),
    "",
    "Your final report must state: what you inspected and changed and why; which files changed; which tests and checks actually ran, and which passed, failed or couldn't run; whether the original problem was reproduced before the fix and passes after it; remaining regression risks; what you couldn't verify; and whether human review is still needed. If no check could run, report the change as implemented but unverified — never as fixed.",
    "Don't push, deploy, or change secrets, CI or infrastructure.",
  );
  return lines.join("\n");
}
