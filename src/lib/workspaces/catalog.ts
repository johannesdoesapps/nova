/**
 * The Cybersecurity and Website Builder workspaces: their tools and templates, as data. The agents come from
 * workspaceAgents() in lib/agents. Pure (no server-only), so the sidebar, dashboards and pages all read it.
 * Icons are string keys resolved by the UI's icon map, so this file stays free of React imports.
 */

export type WorkspaceKey = "cyber" | "web";

export interface WorkspaceMeta {
  key: WorkspaceKey;
  label: string;
  /** Short line under the dashboard title. */
  tagline: string;
  icon: string;
  base: string;
}

export const WORKSPACES: Record<WorkspaceKey, WorkspaceMeta> = {
  cyber: { key: "cyber", label: "Cybersecurity", tagline: "Find weaknesses, watch for threats and prove you're secure.", icon: "shield", base: "/cyber" },
  web: { key: "web", label: "Website Builder", tagline: "Plan, build, launch and look after websites with AI.", icon: "layout", base: "/web" },
};

/**
 * A tool in a workspace. `panel` tools open a tool page inside the workspace (/cyber/tools/<id>); `link` tools open
 * an existing Orbis feature (`href`). `ai` marks tools that make a metered model call.
 */
export interface WorkspaceTool {
  id: string;
  name: string;
  description: string;
  icon: string;
  kind: "panel" | "link";
  href?: string;
  ai?: boolean;
  /** A short category used to group tools on the dashboard and Tools page. */
  group: string;
}

export interface WorkspaceTemplate {
  id: string;
  name: string;
  description: string;
  group: string;
}

export interface WorkspaceCatalog {
  tools: WorkspaceTool[];
  templates: WorkspaceTemplate[];
}

const CYBER: WorkspaceCatalog = {
  tools: [
    { id: "vuln-scan", name: "Website security test", description: "Scan a site you own for exposed headers, TLS problems and common misconfigurations.", icon: "scan", kind: "link", href: "/agents/security/scanner", group: "Scanning & assessment" },
    { id: "sentinel", name: "Vulnerability assessment", description: "Deep application and surface assessment with validated findings (Sentinel).", icon: "scale", kind: "link", href: "/agents/security/scanner", group: "Scanning & assessment" },
    { id: "threat-hunt", name: "Threat detection & monitoring", description: "Investigate logs and events for signs of compromise (Hunter).", icon: "telescope", kind: "link", href: "/agents/security/hunter", group: "Detection & response" },
    { id: "network-check", name: "Network & email security", description: "Review DNS, TLS and email authentication (SPF, DKIM, DMARC) records for a domain you own.", icon: "compass", kind: "panel", ai: true, group: "Scanning & assessment" },
    { id: "password-check", name: "Password strength analysis", description: "Measure how strong a password is and why — entirely in your browser.", icon: "scale", kind: "panel", ai: false, group: "Checks" },
    { id: "phishing-check", name: "Phishing URL & email analysis", description: "Assess a suspicious link or email for phishing signals, safely.", icon: "shield", kind: "panel", ai: true, group: "Checks" },
    { id: "malware-check", name: "Malware analysis", description: "Explain what a suspicious script or file appears to do, for defence.", icon: "brain", kind: "panel", ai: true, group: "Checks" },
    { id: "risk-assessment", name: "Risk assessment", description: "Build a risk register: assets, threats, likelihood, impact and treatment.", icon: "book", kind: "panel", ai: true, group: "Governance" },
    { id: "compliance-check", name: "Compliance check", description: "Check your posture against a framework (CIS, NIST CSF, ISO 27001, SOC 2, GDPR, PCI DSS).", icon: "briefcase", kind: "panel", ai: true, group: "Governance" },
    { id: "report", name: "Security report generator", description: "Turn findings and notes into a clear report for a client or your team.", icon: "pen", kind: "panel", ai: true, group: "Reporting" },
    { id: "team", name: "Security Team", description: "The full roster of security agents, schedules and findings.", icon: "shield", kind: "link", href: "/agents/security", group: "Detection & response" },
  ],
  templates: [
    { id: "audit-report", name: "Cybersecurity audit report", description: "Scope, method, findings and an action plan.", group: "Reports" },
    { id: "vuln-report", name: "Vulnerability assessment report", description: "Findings with severity, impact and remediation.", group: "Reports" },
    { id: "pentest-report", name: "Penetration testing report", description: "Executive summary, findings, evidence and recommendations.", group: "Reports" },
    { id: "incident-plan", name: "Incident response plan", description: "Roles, phases and contacts for handling an incident.", group: "Plans & policies" },
    { id: "security-policy", name: "Security policy", description: "An information security policy for a small organisation.", group: "Plans & policies" },
    { id: "risk-template", name: "Risk assessment", description: "A structured risk register to fill in.", group: "Assessments" },
    { id: "security-checklist", name: "Security checklist", description: "A practical hardening checklist by area.", group: "Assessments" },
    { id: "compliance-report", name: "Compliance report", description: "Requirements mapped to controls, status and gaps.", group: "Reports" },
    { id: "network-assessment", name: "Network security assessment", description: "Segmentation, exposure and hardening for a network.", group: "Assessments" },
  ],
};

const WEB: WorkspaceCatalog = {
  tools: [
    { id: "generate", name: "AI website generation", description: "Describe a site and the coding agent builds it, with a live preview.", icon: "sparkles", kind: "panel", ai: true, group: "Build" },
    { id: "builder", name: "Drag-and-drop builder", description: "Assemble a page from blocks, preview it and export it to a project.", icon: "layout", kind: "panel", ai: false, group: "Build" },
    { id: "landing", name: "Landing page", description: "A focused page for one product, offer or campaign.", icon: "rocket", kind: "panel", ai: true, group: "Build" },
    { id: "store", name: "E-commerce store", description: "A storefront with a catalogue, product pages and a cart.", icon: "briefcase", kind: "panel", ai: true, group: "Build" },
    { id: "blog", name: "Blog", description: "A blog or articles section with a clean reading layout.", icon: "pen", kind: "panel", ai: true, group: "Build" },
    { id: "redesign", name: "Website redesign", description: "Paste a page or describe your current site and get a modern rebuild.", icon: "palette", kind: "panel", ai: true, group: "Build" },
    { id: "code", name: "Custom code editor", description: "Edit HTML, CSS and JavaScript directly, with previews (Orbis Code).", icon: "code", kind: "link", href: "/code", group: "Build" },
    { id: "seo", name: "SEO optimisation", description: "Audit a page for titles, meta, headings, structure and alt text.", icon: "telescope", kind: "panel", ai: true, group: "Optimise" },
    { id: "performance", name: "Performance test", description: "Check a page's load, image and JavaScript weight, with fixes.", icon: "scale", kind: "panel", ai: true, group: "Optimise" },
    { id: "audit", name: "Website audit", description: "Review design, content, SEO and accessibility in one pass.", icon: "scan", kind: "panel", ai: true, group: "Optimise" },
    { id: "publish", name: "Domain, hosting & publishing", description: "Publish a project to the web and connect a domain.", icon: "rocket", kind: "link", href: "/code", group: "Launch" },
  ],
  templates: [
    { id: "business", name: "Business website", description: "A credible multi-section site for a company.", group: "Sites" },
    { id: "saas", name: "SaaS website", description: "A product landing page with features, pricing and sign-up.", group: "Sites" },
    { id: "agency", name: "Agency website", description: "Services, work and contact for a studio or agency.", group: "Sites" },
    { id: "portfolio", name: "Portfolio website", description: "Show work, about and contact for a creative.", group: "Sites" },
    { id: "ecommerce", name: "E-commerce store", description: "A storefront with products and a cart.", group: "Sites" },
    { id: "landing", name: "Landing page", description: "One page for a product, offer or campaign.", group: "Pages" },
    { id: "personal", name: "Personal website", description: "A simple site for a person or freelancer.", group: "Sites" },
    { id: "blog", name: "Blog website", description: "Articles with a clean reading layout.", group: "Sites" },
    { id: "restaurant", name: "Restaurant website", description: "Menu, hours, location and booking.", group: "Sites" },
    { id: "realestate", name: "Real estate website", description: "Listings, search and enquiry.", group: "Sites" },
    { id: "dashboard", name: "Dashboard design", description: "A data dashboard layout built in HTML and CSS.", group: "Pages" },
    { id: "auth", name: "Login & registration", description: "Accessible sign-in and sign-up pages.", group: "Pages" },
  ],
};

export const CATALOGS: Record<WorkspaceKey, WorkspaceCatalog> = { cyber: CYBER, web: WEB };

export function isWorkspaceKey(v: string): v is WorkspaceKey {
  return v === "cyber" || v === "web";
}

export function findTool(workspace: WorkspaceKey, id: string): WorkspaceTool | undefined {
  return CATALOGS[workspace].tools.find((t) => t.id === id);
}

export function findWorkspaceTemplate(workspace: WorkspaceKey, id: string): WorkspaceTemplate | undefined {
  return CATALOGS[workspace].templates.find((t) => t.id === id);
}
