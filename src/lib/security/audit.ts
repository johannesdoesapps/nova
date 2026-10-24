import { classify, type Classification, type FindingLike } from "./details";
import { SEVERITY_ORDER, type Severity } from "./types";

/**
 * Sentinel's audit modes, their budgets, the pre-release gate and the coverage model. Pure: the runners
 * and the report use these to decide how much to fetch and to describe — honestly — what was and wasn't
 * assessed.
 */

export const AUDIT_MODES = ["quick", "deep", "attack_path", "release_gate"] as const;
export type AuditMode = (typeof AUDIT_MODES)[number];
export const TIME_BUDGETS = ["short", "standard", "extended"] as const;
export type TimeBudget = (typeof TIME_BUDGETS)[number];

export interface ModeInfo {
  label: string;
  summary: string;
  /** Same-site pages fetched by the crawler, at the standard time budget. */
  pages: number;
  /** First-party scripts fetched for secrets, endpoints and source maps. */
  scripts: number;
  /** Read-only GET checks of discovered API endpoints (active testing only). */
  endpointChecks: number;
  aiReview: boolean;
}

export const MODE_INFO: Record<AuditMode, ModeInfo> = {
  quick: {
    label: "Quick scan",
    summary: "Home page, headers, cookies, a few scripts and the code rules: common high-impact issues in about a minute.",
    pages: 1,
    scripts: 3,
    endpointChecks: 0,
    aiReview: false,
  },
  deep: {
    label: "Deep audit",
    summary: "Maps the site and the code (pages, forms, scripts, API routes, trust boundaries), runs every check, links findings into attack paths and lists what wasn't assessed.",
    pages: 25,
    scripts: 12,
    endpointChecks: 15,
    aiReview: true,
  },
  attack_path: {
    label: "Attack-path audit",
    summary: "Focuses on how findings combine: maps routes and endpoints, checks which code routes answer signed-out on the live site, and explains each chain and what breaks it.",
    pages: 15,
    scripts: 8,
    endpointChecks: 20,
    aiReview: true,
  },
  release_gate: {
    label: "Pre-release security gate",
    summary: "Repeatable checks with no AI judgement in the decision: fails when any blocking finding is open, or when a check couldn't run.",
    pages: 10,
    scripts: 8,
    endpointChecks: 10,
    aiReview: false,
  },
};

export const BUDGET_INFO: Record<TimeBudget, { label: string; factor: number; crawlSeconds: number }> = {
  short: { label: "Short", factor: 0.5, crawlSeconds: 20 },
  standard: { label: "Standard", factor: 1, crawlSeconds: 35 },
  extended: { label: "Extended", factor: 1.6, crawlSeconds: 45 },
};

export interface CrawlBudget {
  pages: number;
  scripts: number;
  endpointChecks: number;
  seconds: number;
}

/** What one Sentinel request may fetch for a mode and time budget (each request must finish within the function limit). */
export function crawlBudget(mode: AuditMode, budget: TimeBudget, active: boolean): CrawlBudget {
  const m = MODE_INFO[mode];
  const b = BUDGET_INFO[budget];
  return {
    pages: Math.max(1, Math.min(40, Math.round(m.pages * b.factor))),
    scripts: Math.max(1, Math.min(20, Math.round(m.scripts * b.factor))),
    endpointChecks: active ? Math.min(30, Math.round(m.endpointChecks * b.factor)) : 0,
    seconds: b.crawlSeconds,
  };
}

/* --------------------------------------------------------------- the gate */

export interface GateConfig {
  /** Severities that block a release. */
  blockSeverities: Severity[];
  /** Also block on findings that still need verification (stricter). */
  blockUnverified: boolean;
}
export const DEFAULT_GATE: GateConfig = { blockSeverities: ["critical", "high"], blockUnverified: false };

export interface GateResult {
  outcome: "passed" | "failed" | "incomplete";
  blocking: { id: string; title: string; severity: string; classification: Classification }[];
  reasons: string[];
}

const OPEN = new Set(["open", "investigating", "fix_proposed"]);

/**
 * Pass only if every planned check ran and no open finding in scope is blocking. Accepted risks and false
 * positives (recorded decisions by the user) don't block; a check that failed or was skipped makes the
 * gate incomplete, which must be treated as not passed.
 */
export function evaluateGate(findings: (FindingLike & { id: string })[], cfg: GateConfig, steps: { label: string; status: string }[]): GateResult {
  const reasons: string[] = [];
  const broken = steps.filter((s) => s.status !== "completed");
  for (const s of broken) reasons.push(`${s.label} ${s.status === "missing" ? "didn't run" : s.status}.`);
  const blocking = findings
    .filter((f) => OPEN.has(f.status) && cfg.blockSeverities.includes(f.severity as Severity))
    .map((f) => ({ id: f.id, title: f.title, severity: f.severity, classification: classify(f, findings) }))
    .filter((f) => f.classification === "confirmed" || f.classification === "likely" || (cfg.blockUnverified && f.classification === "needs_verification"))
    .sort((a, b) => SEVERITY_ORDER[a.severity as Severity] - SEVERITY_ORDER[b.severity as Severity]);
  if (blocking.length) reasons.push(`${blocking.length} open ${cfg.blockSeverities.join("/")} finding${blocking.length === 1 ? "" : "s"}${cfg.blockUnverified ? "" : " (confirmed or likely)"}.`);
  return { outcome: broken.length ? "incomplete" : blocking.length ? "failed" : "passed", blocking: blocking.slice(0, 50), reasons };
}

/* ------------------------------------------------------------ the coverage */

export interface CoverageInput {
  website: boolean;
  active: boolean;
  /** Pages actually fetched by the crawler. */
  pagesFetched: number;
  pagesNotFetched: number;
  endpointsChecked: number;
  code: boolean;
  /** Routes the code mapper found, and file kinds it couldn't map. */
  routesMapped: number;
  unmapped: string[];
  deps: "ok" | "skipped" | "failed" | "not_run";
  aiReview: boolean;
  logs: boolean;
}

export interface CoverageArea {
  id: string;
  label: string;
  state: "assessed" | "partial" | "not_assessed";
  checked: string[];
  notChecked: string[];
}

/** Areas of the brief's security model, with exactly which checks ran and which didn't (and why). */
export function coverage(c: CoverageInput): CoverageArea[] {
  const area = (id: string, label: string, checks: [boolean, string][], never: string[]): CoverageArea => {
    const checked = checks.filter(([on]) => on).map(([, t]) => t);
    const notChecked = [...checks.filter(([on]) => !on).map(([, t]) => t), ...never];
    return { id, label, state: !checked.length ? "not_assessed" : notChecked.length ? "partial" : "assessed", checked, notChecked };
  };
  const site = c.website;
  const code = c.code;
  const noAccounts = "Sign-in, reset, session and MFA behaviour with test accounts (Sentinel doesn't sign in or submit forms)";
  return (
    [
      area(
        "authn",
        "Authentication & identity",
        [
          [site, "Session cookie flags (Secure, HttpOnly, SameSite)"],
          [site && c.pagesFetched > 0, "Password forms served and submitted over HTTPS"],
          [code, "Rate limits on sign-in, reset and verification routes (code)"],
        ],
        [noAccounts],
      ),
      area(
        "authz",
        "Authorization & access control",
        [
          [code && c.routesMapped > 0, "Sign-in checks on state-changing routes (code)"],
          [code && c.routesMapped > 0, "Owner checks on routes that load records by id (code)"],
          [code, "Database row rules (Supabase RLS / Firebase rules in the files given)"],
          [site && c.active && c.endpointsChecked > 0, `Signed-out responses of ${c.endpointsChecked} discovered API endpoints (live, read-only)`],
        ],
        ["Cross-account and role tests with synthetic users (not available: needs test accounts in a staging environment)"],
      ),
      area(
        "injection",
        "Input handling & injection",
        [
          [code, "SQL/NoSQL, command, path, eval, unsafe deserialisation and HTML sinks (code rules)"],
          [code && c.routesMapped > 0, "Server-side fetches of request-supplied URLs (code)"],
          [code && c.aiReview, "AI review of selected files (findings kept only when the quoted code exists)"],
          [site && c.pagesFetched > 0, "Redirect-style parameters in the site's links"],
        ],
        ["Runtime injection testing (Sentinel doesn't send attack payloads)"],
      ),
      area(
        "api",
        "API & backend",
        [
          [site && c.pagesFetched > 0, "Endpoints referenced by pages and scripts (inventory)"],
          [site && c.active, "Error pages for internal details (live, read-only)"],
          [code && c.routesMapped > 0, "Mass assignment, webhook signature checks and input validation signals (code)"],
        ],
        ["Abuse and rate-limit behaviour under load (no load or denial-of-service testing)"],
      ),
      area(
        "frontend",
        "Frontend & browser",
        [
          [site, "Security headers and Content Security Policy"],
          [site && c.pagesFetched > 0, "Secrets and source maps in served JavaScript"],
          [site && c.pagesFetched > 0, "Third-party scripts without integrity pinning"],
          [site && c.pagesFetched > 0, "Anti-forgery fields on POST forms"],
        ],
        [],
      ),
      area(
        "config",
        "Dependencies, secrets & configuration",
        [
          [code, "Secrets in code"],
          [code && c.deps === "ok", "Known-vulnerable dependencies (OSV)"],
          [site, "TLS, HTTPS redirects and CORS"],
          [site && c.active, "Exposed sensitive files (.env, .git, backups)"],
          [code, "CI workflows, containers, storage and database policies in the files given"],
        ],
        ["Cloud account permissions and live infrastructure settings (only files you supply are read)"],
      ),
      area(
        "logic",
        "Business logic & complex paths",
        [
          [code && c.routesMapped > 0, "Leads: unsigned webhooks, mass assignment on account records"],
          [true, "Attack paths linking the findings above"],
        ],
        ["Discount, credit, quota and race-condition abuse (needs a staging environment and test accounts)"],
      ),
      area("monitoring", "Attack activity", [[c.logs, "Uploaded logs analysed (Threat Hunter)"]], []),
    ]
      .filter((a) => a.id !== "monitoring" || c.logs)
      .map((a) => ({
        ...a,
        notChecked: [
          ...a.notChecked,
          ...(a.id === "frontend" && site && c.pagesNotFetched ? [`${c.pagesNotFetched} same-site page(s) found but not fetched within the budget`] : []),
          ...(a.id === "authz" && code && c.unmapped.length ? c.unmapped : []),
          ...(!site && ["frontend", "authn"].includes(a.id) ? ["No website was in scope"] : []),
          ...(!code && ["authz", "injection", "logic"].includes(a.id) ? ["No code was in scope"] : []),
        ],
      }))
      // The state reflects every gap, including the ones added above.
      .map((a) => ({ ...a, state: !a.checked.length ? "not_assessed" : a.notChecked.length ? "partial" : "assessed" }))
  );
}

/* --------------------------------------------------------------- posture */

export interface Posture {
  open: Record<Severity, number>;
  byClass: Record<Classification, number>;
  confirmedOrLikely: number;
  unverified: number;
}

/** Plain counts — never a score: a short list of findings doesn't prove an application is secure. */
export function posture(findings: FindingLike[]): Posture {
  const open = { critical: 0, high: 0, medium: 0, low: 0, info: 0 } as Record<Severity, number>;
  const byClass = { confirmed: 0, likely: 0, needs_verification: 0, informational: 0, false_positive: 0 } as Record<Classification, number>;
  for (const f of findings) {
    const c = classify(f, findings);
    byClass[c]++;
    if (OPEN.has(f.status)) open[f.severity as Severity]++;
  }
  return { open, byClass, confirmedOrLikely: byClass.confirmed + byClass.likely, unverified: byClass.needs_verification };
}
