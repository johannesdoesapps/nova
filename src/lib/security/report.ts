import { agentName } from "./agents";
import { SEVERITIES } from "./types";

interface ExportFinding {
  id: string;
  agent: string;
  title: string;
  description: string;
  severity: string;
  confidence: string;
  rationale: string;
  asset: string;
  location: string | null;
  evidence: { source: string; detail: string }[];
  evidence_source: string;
  remediation: string;
  refs: string[];
  status: string;
  verification: string;
  verification_note: string | null;
  related: string[];
  duplicate_of: string | null;
  user_note: string | null;
  patch: string | null;
  first_seen: string;
  last_seen: string;
}

const STATUS_LABEL: Record<string, string> = {
  open: "Open",
  investigating: "In progress",
  fix_proposed: "Fix proposed",
  fixed: "Awaiting verification",
  accepted_risk: "Accepted risk",
  verified: "Fixed (verified by re-check)",
  false_positive: "False positive / disproven",
};

/** A shareable Markdown report. Counts are plain tallies of the listed findings; there is no score. */
export function findingsToMarkdown(findings: ExportFinding[], now: Date): string {
  const lines: string[] = [`# Orbis security findings`, ``, `Generated ${now.toISOString().slice(0, 16).replace("T", " ")} UTC. ${findings.length} finding(s).`, ``];
  lines.push(`| Severity | Count |`, `|---|---|`);
  for (const s of SEVERITIES) lines.push(`| ${s} | ${findings.filter((f) => f.severity === s).length} |`);
  lines.push(``, `Severity is how serious the issue would be if real; confidence is how sure the tool is that it is real. These are tallies, not a security score.`, ``);
  findings.forEach((f, i) => {
    lines.push(
      `## ${i + 1}. ${f.title}`,
      ``,
      `- **ID:** ${f.id}`,
      `- **Agent:** ${agentName(f.agent)} (source: ${f.evidence_source})`,
      `- **Severity:** ${f.severity} — ${f.rationale}`,
      `- **Confidence:** ${f.confidence}`,
      `- **Asset:** ${f.asset}${f.location ? ` — ${f.location}` : ""}`,
      `- **Status:** ${STATUS_LABEL[f.status] ?? f.status}; verification: ${f.verification.replace("_", " ")}${f.verification_note ? ` (${f.verification_note})` : ""}`,
      `- **First / last seen:** ${f.first_seen.slice(0, 10)} / ${f.last_seen.slice(0, 10)}`,
      f.related.length ? `- **Related:** ${f.related.join(", ")}` : "",
      f.duplicate_of ? `- **Duplicate of:** ${f.duplicate_of}` : "",
      ``,
      f.description,
      ``,
      `**Evidence**`,
      ...f.evidence.map((e) => `- ${e.source}: \`${e.detail.replace(/`/g, "'")}\``),
      ``,
      `**Remediation:** ${f.remediation}`,
      f.user_note ? `\n**Reviewer note:** ${f.user_note}` : "",
      f.patch ? `\n**Proposed patch (not applied):**\n\n\`\`\`diff\n${f.patch}\n\`\`\`` : "",
      f.refs.length ? `\n**References:** ${f.refs.join(" · ")}` : "",
      ``,
    );
  });
  return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}
