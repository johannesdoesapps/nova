import type { SecurityAgentId } from "./types";

/**
 * The security team. Adding an agent means adding an entry here (and its
 * runner in ./runners); the dashboard, findings, history and coordination
 * pick it up from this list. Planned agents are shown but cannot be launched.
 */
export interface SecurityAgentDef {
  id: SecurityAgentId;
  name: string;
  role: string;
  description: string;
  icon: "radar" | "crosshair" | "code" | "siren" | "globe";
  status: "active" | "planned";
  capabilities: string[];
  /** Tool ids from ./tools this agent may use — and nothing else. */
  tools: string[];
  action: { id: string; label: string } | null;
}

export const SECURITY_AGENTS: SecurityAgentDef[] = [
  {
    id: "sentinel",
    name: "Nova Sentinel",
    role: "Website security assessment",
    description: "Checks websites you own for missing security headers, insecure cookies and configuration, and exposed sensitive files.",
    icon: "radar",
    status: "active",
    capabilities: [
      "HTTPS, redirect and HSTS checks",
      "Security header and CSP review",
      "Cookie flag review",
      "Exposed files (.env, .git) — with active scope only",
      "Re-check findings after fixes",
    ],
    tools: ["nova-headers", "nova-exposure", "zap"],
    action: { id: "scan", label: "Scan website" },
  },
  {
    id: "threat_hunter",
    name: "Nova Threat Hunter",
    role: "Suspicious activity investigation",
    description: "Analyses log files you upload for brute-force logins, password spraying, scanners and attack payloads, and builds an incident timeline.",
    icon: "crosshair",
    status: "active",
    capabilities: [
      "Web server and SSH auth log parsing",
      "Repeated failures, spraying and success-after-failure",
      "Attack payload and scanner detection",
      "Incident timeline and alert grouping",
      "IP reputation (when a reputation service is connected)",
    ],
    tools: ["nova-logs", "abuseipdb", "wazuh"],
    action: { id: "investigate", label: "Investigate threat" },
  },
  {
    id: "code_guardian",
    name: "Nova Code Guardian",
    role: "Secure code review and fixes",
    description: "Reviews source code for secrets and insecure patterns, checks dependencies against known vulnerabilities, and proposes fixes for your review.",
    icon: "code",
    status: "active",
    capabilities: [
      "Secret and API key detection",
      "Injection, XSS, unsafe eval and crypto rules",
      "Dependency vulnerabilities (OSV database)",
      "AI review with evidence checked against your code",
      "Proposed patches and regression tests — never applied automatically",
    ],
    tools: ["nova-code-rules", "osv", "ai-review", "github", "semgrep", "trivy"],
    action: { id: "audit", label: "Audit code" },
  },
  {
    id: "incident_responder",
    name: "Nova Incident Responder",
    role: "Containment and recovery",
    description: "Will organise evidence and timelines, guide containment and recovery, and track incident tasks.",
    icon: "siren",
    status: "planned",
    capabilities: ["Evidence and timeline organisation", "Containment and recovery guidance", "Recovery task tracking"],
    tools: [],
    action: null,
  },
  {
    id: "threat_intel",
    name: "Nova Threat Intelligence",
    role: "Indicator enrichment and advisories",
    description: "Will enrich indicators from trusted intelligence sources and link advisories to your findings.",
    icon: "globe",
    status: "planned",
    capabilities: ["Indicator reputation and context", "Advisory tracking", "Links intelligence to findings"],
    tools: [],
    action: null,
  },
];

export const agentDef = (id: string) => SECURITY_AGENTS.find((a) => a.id === id);
export const agentName = (id: string) => agentDef(id)?.name ?? (id === "coordinated" ? "Coordinated investigation" : id);
