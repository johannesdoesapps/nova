import { agentById } from "./agents";
import type { CheckResult, Step, Task, Verification } from "./types";

/**
 * The final report is assembled from stored step outputs and real check
 * results — never written by a model — so it can't claim anything that
 * didn't happen.
 */
export function buildReport(task: Task, steps: Step[], v: Verification | null, opts: { analysisOnly?: boolean } = {}): string {
  const L: string[] = [];
  const verdict = opts.analysisOnly ? "Analysis only (Assist mode — no changes were made)" : v?.verdict === "verified" ? "✅ Verified" : "⚠️ Not verified";
  L.push(`# ${task.title}`, "", `**Result:** ${verdict}`, "", "## What was requested", "", task.objective, "");
  if (task.acceptance_criteria.length) L.push("**Acceptance criteria**", ...task.acceptance_criteria.map((c) => `- ${c}`), "");
  if (task.plan) {
    L.push("## Plan", "", task.plan.summary, "", `Risk: **${task.plan.risk}**`, "");
    L.push(...task.plan.changes.map((c) => `- \`${c.path}\` (${c.action}) — ${c.intent}`), "");
  }
  if (!opts.analysisOnly) {
    L.push("## What changed", "");
    L.push(task.changed_files.length ? task.changed_files.map((f) => `- \`${f}\``).join("\n") : "No files changed.", "");
    const tests = steps.filter((s) => /^(baseline|test-\d+|buildcheck)$/.test(s.key) && s.status === "succeeded");
    if (tests.length) {
      L.push("## Checks that actually ran", "", "| Run | Check | Result | Exit | Time |", "|---|---|---|---|---|");
      for (const s of tests) for (const r of ((s.output as { results?: CheckResult[] }).results ?? []) as CheckResult[]) L.push(`| ${s.key} | ${r.label} | ${r.passed ? "passed" : r.timedOut ? "timed out" : "failed"} | ${r.exitCode ?? "—"} | ${(r.durationMs / 1000).toFixed(1)}s |`);
      L.push("", "_baseline = before any change. Failures present in the baseline are pre-existing._", "");
    } else L.push("## Checks", "", "No checks completed.", "");
    const repairs = steps.filter((s) => s.key.startsWith("repair-"));
    if (repairs.length) {
      L.push("## Repairs", "");
      for (const r of repairs) L.push(`- ${r.key}: ${r.status}${(r.output as { rootCause?: string } | null)?.rootCause ? ` — root cause: ${(r.output as { rootCause: string }).rootCause}` : r.error ? ` — ${r.error}` : ""}`);
      L.push("");
    }
    if (v) {
      L.push("## Verification", "");
      for (const c of v.checks) L.push(`- ${c.passed ? "✅" : "❌"} ${c.name} — ${c.evidence}`);
      if (v.criteria.length) {
        L.push("", "**Acceptance criteria** (judged by the reviewer model against the diff and check results)");
        for (const c of v.criteria) L.push(`- ${c.status === "met" ? "✅" : c.status === "not_met" ? "❌" : "❔"} ${c.criterion} — ${c.evidence}`);
      }
      if (v.reasons.length) L.push("", "**Why it isn't verified**", ...v.reasons.map((r) => `- ${r}`));
      L.push("");
    }
    const sec = steps.find((s) => s.key === "security" && s.status === "succeeded")?.output as { findings?: { severity: string; issue: string; file: string; source: string }[] } | undefined;
    const rev = steps.find((s) => s.key === "review" && s.status === "succeeded")?.output as { findings?: { severity: string; issue: string; file?: string }[] } | undefined;
    if (sec?.findings?.length || rev?.findings?.length) {
      L.push("## Findings", "");
      for (const f of sec?.findings ?? []) L.push(`- [security · ${f.severity}] ${f.issue} (${f.file}; ${f.source})`);
      for (const f of rev?.findings ?? []) L.push(`- [review · ${f.severity}] ${f.issue}${f.file ? ` (${f.file})` : ""}`);
      L.push("");
    }
  }
  L.push("## Usage", "", `- Model calls: ${task.tokens_used.toLocaleString("en-US")} tokens; estimated cost $${task.spent_usd.toFixed(4)}${task.spent_unpriced_calls ? ` plus ${task.spent_unpriced_calls} call(s) on models without a known price` : ""}`, `- Steps: ${steps.length} (${steps.filter((s) => s.status === "failed").length} failed, ${steps.reduce((n, s) => n + Math.max(0, s.attempt - 1), 0)} retries)`, "");
  L.push("## Agents involved", "", ...[...new Set(steps.map((s) => s.agent))].map((a) => `- ${agentById(a)?.name ?? a} v${steps.find((s) => s.agent === a)?.agent_version}`), "");
  L.push("## Remaining actions for a human", "");
  if (opts.analysisOnly) L.push("- Review the plan; switch the task to Collaborate mode to implement it.");
  else {
    L.push("- Review the diff. Nothing has been pushed, merged or deployed.");
    if (v?.verdict !== "verified") L.push("- Resolve the verification problems above (Rework, or fix manually).");
    L.push("- Apply the patch to a branch (download it from the task page) and open a pull request.");
  }
  return L.join("\n");
}
