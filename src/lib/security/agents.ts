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
    name: "Orbis Sentinel",
    role: "Website security assessment",
    description:
      "Audits websites you own and their code: maps pages, forms, scripts and API endpoints, checks headers, cookies, client-side secrets and configuration, links findings into attack paths, and says what it couldn't assess.",
    icon: "radar",
    status: "active",
    capabilities: [
      "Audit modes: Quick scan, Deep audit, Attack-path audit, Pre-release gate",
      "Site mapping: pages, forms, scripts, API endpoints (read-only, within budget)",
      "Headers, CSP, cookies, CORS, HTTPS and exposed files",
      "Secrets and source maps in served JavaScript",
      "Signed-out checks of discovered API endpoints (active testing only)",
      "Attack paths, coverage and a release gate",
      "Re-check findings after fixes",
    ],
    tools: ["orbis-headers", "orbis-surface", "orbis-exposure", "zap"],
    action: { id: "scan", label: "Scan website" },
  },
  {
    id: "threat_hunter",
    name: "Orbis Threat Hunter",
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
    tools: ["orbis-logs", "abuseipdb", "wazuh"],
    action: { id: "investigate", label: "Investigate threat" },
  },
  {
    id: "code_guardian",
    name: "Orbis Code Guardian",
    role: "Secure code review and fixes",
    description: "Reviews source code for secrets and insecure patterns, checks dependencies against known vulnerabilities, and proposes fixes for your review.",
    icon: "code",
    status: "active",
    capabilities: [
      "Secret and API key detection",
      "Application map: routes, sign-in and owner checks, webhooks, trust boundaries",
      "Config checks: database row rules, CI workflows, containers, storage",
      "Injection, XSS, unsafe eval and crypto rules",
      "Dependency vulnerabilities (OSV database)",
      "AI review with evidence checked against your code",
      "Fix with the coding agent: your approval for every plan and edit, tests run, nothing pushed",
    ],
    tools: ["orbis-code-rules", "orbis-code-map", "osv", "ai-review", "github", "semgrep", "trivy"],
    action: { id: "audit", label: "Audit code" },
  },
  {
    id: "incident_responder",
    name: "Orbis Incident Responder",
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
    name: "Orbis Threat Intelligence",
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
