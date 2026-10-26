/**
 * Website scan reports: findings for the shared findings store, Markdown/HTML/JSON exports, and a compact copy of the
 * report that fits the run's stats column. Pure functions.
 */
import { fingerprint, type FindingDraft } from "../types";
import { CATEGORY_LABEL, SEVERITY_RANK, type CheckCategory, type CheckResult, type CheckStatus, type ScanReport } from "./types";

export const RULE_PREFIX = "sitescan.";

export const NOT_COVERED = [
  "Pages behind a sign-in, and session handling after login (needs authenticated testing).",
  "Application vulnerabilities such as XSS, SQL injection or broken access control (needs an authorised application test).",
  "Other hostnames, subdomains and ports than the one scanned.",
  "TLS implementation bugs that need crafted handshakes (Heartbleed, ROBOT, …) and SSL 2/3, 3DES, RC4 and EXPORT suites.",
  "Load, rate-limit and denial-of-service resilience (never tested, by design).",
  "Content loaded later by JavaScript; only the home page's HTML and headers were read.",
];

/** A stored report as the API returns it (the static "not covered" list is dropped from tightly trimmed copies). */
export function readStored(report: ScanReport, runId: string): ScanReport {
  return { ...report, runId, notCovered: report.notCovered?.length ? report.notCovered : NOT_COVERED };
}

/** Failed checks and warnings become findings (one per check, stable fingerprint per host). */
export function findingsFrom(r: ScanReport): FindingDraft[] {
  return r.checks
    .filter((c) => (c.status === "failed" || c.status === "warning") && c.severity !== "info")
    .map((c) => ({
      agent: "sentinel",
      ruleId: `${RULE_PREFIX}${c.id}`,
      fingerprint: fingerprint("sentinel", `${RULE_PREFIX}${c.id}`, r.host, ""),
      title: `${c.title} — ${c.status === "warning" ? "needs attention" : "failed"}`.slice(0, 300),
      description: c.summary,
      severity: c.severity,
      confidence: c.confirmed ? "confirmed" : "firm",
      rationale: c.confirmed ? "Observed directly by the website scan." : "Inferred from other observations; verify manually.",
      asset: r.host,
      location: `https://${r.host}/`,
      evidence: c.evidence.slice(0, 12).map((e) => ({ source: e.label, detail: e.value })),
      evidenceSource: "orbis:sitescan",
      remediation: c.remediation ?? "",
      references: c.references.slice(0, 10),
    }));
}

/** Rule ids the scan checked and found fine: earlier findings for them are marked "not detected". */
export function clearedRules(r: ScanReport): string[] {
  return r.checks.filter((c) => c.status === "passed" || c.status === "info").map((c) => `${RULE_PREFIX}${c.id}`);
}

export function counts(checks: CheckResult[]) {
  const by = (s: CheckStatus) => checks.filter((c) => c.status === s).length;
  const sev = (v: CheckResult["severity"]) => checks.filter((c) => (c.status === "failed" || c.status === "warning") && c.severity === v).length;
  return {
    passed: by("passed"),
    failed: by("failed"),
    warning: by("warning"),
    info: by("info"),
    skipped: by("skipped"),
    inconclusive: by("inconclusive"),
    untested: by("untested"),
    severity: { critical: sev("critical"), high: sev("high"), medium: sev("medium"), low: sev("low") },
  };
}

const bytes = (o: unknown) => Buffer.byteLength(JSON.stringify(o), "utf8");
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Shrink the report until it fits `max` bytes: shorter evidence first, then fewer evidence rows and references. */
export function fitReport(r: ScanReport, max = 19_000): ScanReport {
  if (bytes(r) <= max) return r;
  const steps: [number, number, number, number][] = [
    [8, 200, 400, 3],
    [5, 140, 300, 2],
    [3, 100, 220, 1],
    [2, 80, 160, 0],
    [0, 0, 120, 0],
  ];
  for (const [rows, len, text, refs] of steps) {
    const fitted: ScanReport = {
      ...r,
      trimmed: true,
      ciphers: r.ciphers.slice(0, rows ? 60 : 30),
      certificate: r.certificate ? { ...r.certificate, names: r.certificate.names.slice(0, 20) } : null,
      checks: r.checks.map((c) => ({
        ...c,
        summary: cut(c.summary, text * 2),
        remediation: c.remediation ? cut(c.remediation, text) : null,
        evidence: c.evidence.slice(0, c.status === "failed" || c.status === "warning" ? rows : Math.min(rows, 2)).map((e) => ({ label: cut(e.label, 80), value: cut(e.value, len) })),
        references: c.references.slice(0, refs),
      })),
    };
    if (bytes(fitted) <= max) return fitted;
  }
  // Last resort: problems keep a short summary; checks that passed or didn't run keep only their outcome
  // (the Markdown report saved with the run and the findings keep everything).
  const problem = (c: CheckResult) => c.status === "failed" || c.status === "warning";
  const minimal = (n: number): ScanReport => ({
    ...r,
    trimmed: true,
    ciphers: [],
    notes: r.notes.slice(0, 5).map((x) => cut(x, 200)),
    // Restored from NOT_COVERED when the report is read back.
    notCovered: [],
    certificate: r.certificate ? { ...r.certificate, names: r.certificate.names.slice(0, 5), chain: [] } : null,
    checks: r.checks.map((c) => ({ ...c, summary: problem(c) ? cut(c.summary, n) : "", remediation: null, evidence: [], references: [] })),
  });
  for (const n of [140, 80]) {
    const m = minimal(n);
    if (bytes(m) <= max) return m;
  }
  return minimal(0);
}

/* ---------------------------------------------------------------- exports */

const STATUS_LABEL: Record<CheckStatus, string> = { passed: "Passed", failed: "Failed", warning: "Warning", info: "Info", skipped: "Skipped", inconclusive: "Inconclusive", untested: "Not tested" };
const ORDER: CheckCategory[] = ["certificate", "tls", "headers", "cookies", "content", "server", "exposure", "dns"];
const proto = (k: string) => (k === "TLSv1" ? "TLS 1.0" : k.replace("TLSv", "TLS "));

export function toMarkdown(r: ScanReport): string {
  const c = counts(r.checks);
  const md: string[] = [];
  md.push(`# Website security scan: ${r.host}`, "");
  md.push(`Scanned ${r.finishedAt.replace("T", " ").slice(0, 16)} UTC · ${r.scope} scope · ${r.handshakes} TLS handshakes, ${r.requests} HTTP requests · ${(r.durationMs / 1000).toFixed(1)} s`, "");
  if (r.grade) {
    md.push(`**Orbis grade: ${r.grade.letter}** (${r.grade.score}/100; transport ${r.grade.parts.tls}, web ${r.grade.parts.web})`, "");
    if (r.grade.caps.length) md.push(`Grade limited by: ${r.grade.caps.join("; ")}.`, "");
    if (r.grade.plus) md.push(r.grade.plus, "");
    md.push(`> ${r.grade.method}`, "");
  } else md.push(`**No grade.** ${r.gradeNote ?? ""}`, "");
  md.push(`Results: ${c.passed} passed, ${c.failed} failed, ${c.warning} warnings, ${c.inconclusive} inconclusive, ${c.untested} not tested, ${c.skipped} skipped, ${c.info} informational.`, "");
  md.push("A limited, external scan can't show that a website is secure; it reports what it could observe from outside.", "");
  if (r.certificate) {
    const k = r.certificate;
    md.push("## Certificate", "", `- Subject: ${k.subject}`, `- Issuer: ${k.issuer}`, `- Names: ${k.names.join(", ") || "(none)"}`, `- Valid: ${k.validFrom.slice(0, 10)} → ${k.validTo.slice(0, 10)} (${k.daysLeft} days left)`, `- Key: ${k.key} · Signature: ${k.signature} · Trusted: ${k.trusted ? "yes" : "no"}`, "");
  }
  md.push("## Protocols", "", ...Object.entries(r.protocols).map(([k, v]) => `- ${proto(k)}: ${v}`), "");
  if (r.ciphers.length) md.push("## Cipher suites accepted", "", ...r.ciphers.map((x) => `- ${proto(x.protocol)} ${x.name}: ${x.strength}${x.forwardSecrecy ? "" : ", no forward secrecy"}`), "");
  for (const cat of ORDER) {
    const list = r.checks.filter((x) => x.category === cat);
    if (!list.length) continue;
    md.push(`## ${CATEGORY_LABEL[cat]}`, "");
    for (const x of [...list].sort((a, b) => rank(a) - rank(b))) {
      md.push(`### ${STATUS_LABEL[x.status]}: ${x.title}${x.status === "failed" || x.status === "warning" ? ` (${x.severity}${x.confirmed ? "" : ", inferred"})` : ""}`, "", x.summary, "");
      if (x.evidence.length) md.push(...x.evidence.map((e) => `- ${e.label}: \`${e.value.replace(/`/g, "'")}\``), "");
      if (x.remediation) md.push(`**Fix:** ${x.remediation}`, "");
      if (x.references.length) md.push(`References: ${x.references.join(", ")}`, "");
    }
  }
  if (r.notes.length) md.push("## Notes", "", ...r.notes.map((n) => `- ${n}`), "");
  md.push("## Not covered by this scan", "", ...r.notCovered.map((n) => `- ${n}`), "");
  if (r.trimmed) md.push("_Some evidence was shortened to fit storage; the findings list keeps the full evidence._", "");
  return md.join("\n");
}

const RANK: Record<CheckStatus, number> = { failed: 0, warning: 1, inconclusive: 2, untested: 3, skipped: 4, info: 5, passed: 6 };
const rank = (c: CheckResult) => RANK[c.status] * 10 - SEVERITY_RANK[c.severity];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A self-contained HTML report (no scripts, no external resources). */
export function toHtml(r: ScanReport): string {
  const c = counts(r.checks);
  const color: Record<CheckStatus, string> = { passed: "#15803d", failed: "#b91c1c", warning: "#b45309", info: "#475569", skipped: "#64748b", inconclusive: "#7c3aed", untested: "#64748b" };
  const rows = ORDER.map((cat) => {
    const list = r.checks.filter((x) => x.category === cat).sort((a, b) => rank(a) - rank(b));
    if (!list.length) return "";
    return `<h2>${esc(CATEGORY_LABEL[cat])}</h2>${list
      .map(
        (x) => `<details${x.status === "failed" ? " open" : ""}><summary><span class="b" style="background:${color[x.status]}">${STATUS_LABEL[x.status]}</span> ${esc(x.title)}${x.status === "failed" || x.status === "warning" ? ` <small>${x.severity}${x.confirmed ? "" : ", inferred"}</small>` : ""}</summary><p>${esc(x.summary)}</p>${
          x.evidence.length ? `<table>${x.evidence.map((e) => `<tr><th>${esc(e.label)}</th><td><code>${esc(e.value)}</code></td></tr>`).join("")}</table>` : ""
        }${x.remediation ? `<p><b>Fix:</b> ${esc(x.remediation)}</p>` : ""}${x.references.length ? `<p class="r">${x.references.map((u) => `<a href="${esc(u)}" rel="noreferrer">${esc(u)}</a>`).join(" · ")}</p>` : ""}</details>`,
      )
      .join("")}`;
  }).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Security scan: ${esc(r.host)}</title><style>
body{font:15px/1.5 system-ui,sans-serif;max-width:860px;margin:2rem auto;padding:0 16px;color:#0f172a;background:#fff}h1{font-size:1.6rem}h2{margin-top:2rem;border-bottom:1px solid #e2e8f0;padding-bottom:.3rem}
.g{font-size:3rem;font-weight:800}.b{display:inline-block;color:#fff;border-radius:6px;padding:0 .45rem;font-size:.75rem;font-weight:600;min-width:5.5rem;text-align:center}
details{border:1px solid #e2e8f0;border-radius:10px;padding:.5rem .8rem;margin:.4rem 0}summary{cursor:pointer}table{border-collapse:collapse;width:100%;font-size:.85rem}th{text-align:left;padding:.2rem .6rem .2rem 0;vertical-align:top;white-space:nowrap;color:#475569}td{word-break:break-all}.r{font-size:.8rem}small{color:#64748b}
</style></head><body><h1>Website security scan: ${esc(r.host)}</h1><p>${esc(r.finishedAt.replace("T", " ").slice(0, 16))} UTC · ${r.scope} scope · ${r.handshakes} TLS handshakes · ${r.requests} HTTP requests</p>${
    r.grade ? `<p><span class="g">${r.grade.letter}</span> ${r.grade.score}/100 (transport ${r.grade.parts.tls}, web ${r.grade.parts.web})</p>${r.grade.caps.length ? `<p>Limited by: ${esc(r.grade.caps.join("; "))}</p>` : ""}<p><small>${esc(r.grade.method)}</small></p>` : `<p><b>No grade.</b> ${esc(r.gradeNote ?? "")}</p>`
  }<p>${c.passed} passed · ${c.failed} failed · ${c.warning} warnings · ${c.inconclusive} inconclusive · ${c.untested} not tested · ${c.skipped} skipped</p><p><small>A limited, external scan can't show that a website is secure; it reports what it could observe from outside.</small></p>${rows}${
    r.notes.length ? `<h2>Notes</h2><ul>${r.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""
  }<h2>Not covered</h2><ul>${r.notCovered.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></body></html>`;
}
