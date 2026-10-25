/**
 * The agents Aegis coordinates, and the truth about each: which exist, what they actually cover, how a task is
 * handed to them, and what's missing. Agents that aren't built are listed as unavailable — Aegis plans around
 * them and reports the gap; it never simulates their work.
 */

export type RosterId = "sentinel" | "threat_hunter" | "code_guardian" | "bastion" | "cloud_guardian" | "red_team" | "supply_chain" | "identity_guardian" | "incident_commander" | "compliance_privacy";

export interface RosterAgent {
  id: RosterId;
  name: string;
  domain: string;
  status: "available" | "partial" | "unavailable";
  /** What it really does today. */
  covers: string[];
  /** What's needed before it can run (permissions, data). */
  requires: string[];
  /** What it can't do, or why it isn't available. */
  gaps: string[];
  /** Where a task for it is started. */
  start: string | null;
}

export const ROSTER: RosterAgent[] = [
  {
    id: "sentinel",
    name: "Sentinel",
    domain: "Application security",
    status: "available",
    covers: [
      "Read-only checks of websites you've verified: transport, headers, cookies, exposed files, a bounded crawl, client bundles",
      "Optional active read-only endpoint checks",
      "Audit modes with attack paths, coverage and a release gate",
    ],
    requires: ["A website whose ownership you've verified"],
    gaps: ["Doesn't sign in, submit forms or exploit anything"],
    start: "/agents/security",
  },
  {
    id: "threat_hunter",
    name: "Threat Hunter",
    domain: "Suspicious activity and threat intelligence",
    status: "available",
    covers: [
      "Hunts in log exports you upload (web, SSH/Linux auth, CloudTrail, Okta, Windows, DNS)",
      "Investigations with evidence, hypotheses and response plans",
      "IP reputation (when configured) and the CISA KEV catalogue",
    ],
    requires: ["Log files you upload or paste"],
    gaps: ["No live SIEM, EDR, network or email telemetry; nothing is monitored continuously"],
    start: "/agents/security",
  },
  {
    id: "code_guardian",
    name: "Code Guardian",
    domain: "Code security, defects and verified repairs",
    status: "available",
    covers: ["Security rules, application map and OSV dependency checks", "Defects, dependency compatibility, module graph and change impact", "Repairs through the coding agent with your approval"],
    requires: ["A GitHub repository or uploaded code (repairs need GitHub)"],
    gaps: ["Reads code without running it; tests run only during repairs"],
    start: "/agents/security",
  },
  {
    id: "bastion",
    name: "Bastion",
    domain: "Runtime protection of Orbis itself",
    status: "available",
    covers: ["Policy checks before Orbis agents run commands, change files, use connectors or fetch URLs", "Emergency controls and an audit trail of decisions"],
    requires: ["Nothing: always on"],
    gaps: ["Protects Orbis's own agents; it doesn't protect your infrastructure"],
    start: "/agents/security/bastion",
  },
  {
    id: "supply_chain",
    name: "Supply Chain Guardian",
    domain: "Dependencies, packages and build pipeline",
    status: "partial",
    covers: ["Known vulnerabilities (OSV) and dependency compatibility, through Code Guardian", "CI workflow configuration checks in Code Guardian's rules"],
    requires: ["A repository audit"],
    gaps: ["No package-integrity, provenance or build-artifact verification", "No registry or typosquatting monitoring"],
    start: "/agents/security",
  },
  {
    id: "identity_guardian",
    name: "Identity Guardian",
    domain: "Identity, permissions and credentials",
    status: "partial",
    covers: ["Sign-in attacks, privilege grants and new credentials found by Threat Hunter in uploaded identity and cloud logs", "Hard-coded secrets found by Code Guardian and Sentinel"],
    requires: ["Identity-provider or cloud audit logs you upload"],
    gaps: ["No connection to your identity provider or cloud IAM: can't list users, roles or permissions, or check MFA"],
    start: null,
  },
  {
    id: "cloud_guardian",
    name: "Cloud Guardian",
    domain: "Cloud infrastructure and configuration",
    status: "unavailable",
    covers: [],
    requires: ["A read-only cloud connection (not built)"],
    gaps: ["Not built: cloud configuration isn't assessed. CloudTrail exports can be hunted by Threat Hunter; infrastructure-as-code files get basic checks from Code Guardian."],
    start: null,
  },
  {
    id: "red_team",
    name: "Red Team",
    domain: "Authorized security validation",
    status: "unavailable",
    covers: [],
    requires: ["A written authorization and an isolated test environment (not built)"],
    gaps: ["Not built: no attack path is ever reproduced, so every path stays a hypothesis"],
    start: null,
  },
  {
    id: "incident_commander",
    name: "Incident Commander",
    domain: "Incident coordination and recovery",
    status: "partial",
    covers: ["Threat Hunter investigations: states, response plans with approval flags, decisions and action tracking"],
    requires: ["A Threat Hunter investigation"],
    gaps: ["No paging, on-call or ticketing integration; no containment actions on your systems"],
    start: "/agents/security/hunter",
  },
  {
    id: "compliance_privacy",
    name: "Compliance & Privacy Guardian",
    domain: "Controls, privacy risks and audit evidence",
    status: "unavailable",
    covers: [],
    requires: ["A control framework mapping (not built)"],
    gaps: ["Not built: findings aren't mapped to frameworks such as SOC 2 or ISO 27001, and no privacy assessment is made"],
    start: null,
  },
];

export const rosterById = (id: string) => ROSTER.find((a) => a.id === id);
