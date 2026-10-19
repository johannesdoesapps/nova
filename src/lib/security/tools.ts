import "server-only";
import { isAdmin } from "../admin";
import type { AuthContext } from "../auth";

/**
 * Tool registry. Built-in tools run inside Nova (plain HTTP and text analysis,
 * no shell commands). External scanners need their own isolated runner and
 * are listed as not connected until one is configured — never simulated.
 */
export interface SecurityTool {
  id: string;
  name: string;
  kind: "builtin" | "service" | "external";
  description: string;
  envVars: string[];
  available: boolean;
  reason?: string;
}

const env = (k: string) => (process.env[k] ?? "").trim();

export async function securityTools(auth?: AuthContext): Promise<SecurityTool[]> {
  const admin = auth ? await isAdmin(auth) : false;
  const externalReason = "Not connected. Needs a separate scanner runner (it can't run inside the website's serverless functions).";
  return [
    { id: "nova-headers", name: "Header & config checks", kind: "builtin", description: "HTTPS, HSTS, CSP, framing, cookie flags, CORS and version disclosure from live HTTP responses.", envVars: [], available: true },
    { id: "nova-exposure", name: "Exposed file checks", kind: "builtin", description: "Requests a short list of sensitive paths (.env, .git, server-status) and confirms by content. Active scope only.", envVars: [], available: true },
    { id: "nova-code-rules", name: "Code & secret rules", kind: "builtin", description: "Pattern rules for secrets, injection, XSS, unsafe eval, weak crypto and TLS bypasses.", envVars: [], available: true },
    { id: "osv", name: "OSV.dev vulnerability database", kind: "service", description: "Known vulnerabilities for npm and PyPI packages from lockfiles and manifests.", envVars: [], available: true },
    { id: "ai-review", name: "AI code review", kind: "builtin", description: "Uses your chosen AI model; only findings whose quoted code exists in your files are kept, marked tentative.", envVars: [], available: true },
    { id: "nova-logs", name: "Log analyzer", kind: "builtin", description: "Parses web access, SSH auth and JSON logs; detects brute force, spraying, scanners and payloads.", envVars: [], available: true },
    {
      id: "github",
      name: "GitHub repositories",
      kind: "service",
      description: "Downloads a repository snapshot for read-only review. Public repos for everyone; private repos via GITHUB_TOKEN for administrators.",
      envVars: ["GITHUB_TOKEN (optional, admin-only)"],
      available: true,
      reason: env("GITHUB_TOKEN") && admin ? undefined : "Public repositories only.",
    },
    {
      id: "abuseipdb",
      name: "AbuseIPDB reputation",
      kind: "service",
      description: "IP address abuse reports and confidence score.",
      envVars: ["ABUSEIPDB_API_KEY"],
      available: Boolean(env("ABUSEIPDB_API_KEY")),
      reason: env("ABUSEIPDB_API_KEY") ? undefined : "Add ABUSEIPDB_API_KEY to enable IP reputation.",
    },
    { id: "zap", name: "OWASP ZAP", kind: "external", description: "Full dynamic application scanning.", envVars: ["ZAP runner (planned)"], available: false, reason: externalReason },
    { id: "semgrep", name: "Semgrep", kind: "external", description: "Deep static analysis with community rules.", envVars: ["Semgrep runner (planned)"], available: false, reason: externalReason },
    { id: "trivy", name: "Trivy", kind: "external", description: "Container, IaC and filesystem scanning.", envVars: ["Trivy runner (planned)"], available: false, reason: externalReason },
    { id: "wazuh", name: "Wazuh", kind: "external", description: "Continuous monitoring and alert feeds.", envVars: ["Wazuh manager (planned)"], available: false, reason: "Not connected. Nova does not monitor systems continuously; it analyses logs you upload." },
  ];
}
