import { callJson, ConnectorError } from "../connectors/http";
import type { ToolContext } from "../connectors/types";
import { evaluateGate, type GateResult } from "./audit";
import type { FindingLike } from "./details";
import { fingerprint, type Confidence, type FindingDraft, type Severity } from "./types";

/**
 * Vercel deployment audit (Application Protection, Sentinel action "deployment"). Reads a project's settings,
 * environment-variable metadata, domains and recent deployments through the person's own Vercel connection — read
 * only. Environment-variable values are never requested, and any value Vercel includes anyway (plain variables) is
 * dropped as soon as the response is parsed: only names, types and targets are kept. Findings about variable names
 * are leads ("needs verification"), because the name alone doesn't prove what the value is.
 */

const API = "https://api.vercel.com";
export const VERCEL_CHECKED = ["vercel."];

export interface EnvMeta {
  key: string;
  /** encrypted | plain | secret | sensitive | system */
  type: string;
  targets: string[];
  gitBranch: string | null;
}

export interface ProjectInfo {
  id: string;
  name: string;
  teamId: string | null;
  framework: string | null;
  nodeVersion: string | null;
  /** Vercel Authentication on deployments: null when off; otherwise which deployments it covers. */
  ssoProtection: string | null | undefined;
  passwordProtection: string | null | undefined;
  gitForkProtection: boolean | undefined;
  publicSource: boolean | null | undefined;
  directoryListing: boolean | undefined;
  /** How many automation-bypass secrets exist (the secrets themselves are never kept). */
  bypassSecrets: number;
  link: { type: string; repo: string } | null;
  firewallEnabled: boolean | undefined;
}

export interface DomainInfo {
  name: string;
  verified: boolean;
  redirect: string | null;
  gitBranch: string | null;
}

export interface DeploymentInfo {
  id: string;
  url: string | null;
  target: string;
  state: string;
  created: number;
  commit: string | null;
  branch: string | null;
}

export interface VercelSnapshot {
  project: ProjectInfo;
  envs: EnvMeta[];
  domains: DomainInfo[];
  deployments: DeploymentInfo[];
  /** Parts Vercel refused or didn't return (missing permission, error) — reported as not checked. */
  missing: string[];
}

/** Keep only metadata. Called on every variable Vercel returns, so a value can't leak further. */
export function envMeta(raw: Record<string, unknown>): EnvMeta | null {
  if (typeof raw.key !== "string") return null;
  const target = Array.isArray(raw.target) ? raw.target : typeof raw.target === "string" ? [raw.target] : [];
  return { key: raw.key.slice(0, 200), type: typeof raw.type === "string" ? raw.type : "unknown", targets: target.filter((t): t is string => typeof t === "string"), gitBranch: typeof raw.gitBranch === "string" && raw.gitBranch ? raw.gitBranch.slice(0, 120) : null };
}

const protectionType = (v: unknown): string | null | undefined => (v === undefined ? undefined : v === null ? null : typeof v === "object" ? String((v as { deploymentType?: unknown }).deploymentType ?? "on") : undefined);

export function projectInfo(raw: Record<string, unknown>, teamId: string | null): ProjectInfo {
  const link = raw.link as { type?: string; org?: string; repo?: string; projectNamespace?: string; projectName?: string } | undefined;
  const repo = link?.type === "github" && link.org && link.repo ? `${link.org}/${link.repo}` : link?.projectNamespace && link.projectName ? `${link.projectNamespace}/${link.projectName}` : null;
  const security = raw.security as { firewallEnabled?: boolean } | undefined;
  return {
    id: String(raw.id ?? ""),
    name: String(raw.name ?? ""),
    teamId,
    framework: typeof raw.framework === "string" ? raw.framework : null,
    nodeVersion: typeof raw.nodeVersion === "string" ? raw.nodeVersion : null,
    ssoProtection: protectionType(raw.ssoProtection),
    passwordProtection: protectionType(raw.passwordProtection),
    gitForkProtection: typeof raw.gitForkProtection === "boolean" ? raw.gitForkProtection : undefined,
    publicSource: raw.publicSource === null ? null : typeof raw.publicSource === "boolean" ? raw.publicSource : undefined,
    directoryListing: typeof raw.directoryListing === "boolean" ? raw.directoryListing : undefined,
    bypassSecrets: raw.protectionBypass && typeof raw.protectionBypass === "object" ? Object.keys(raw.protectionBypass).length : 0,
    link: link?.type && repo ? { type: link.type, repo } : null,
    firewallEnabled: typeof security?.firewallEnabled === "boolean" ? security.firewallEnabled : undefined,
  };
}

/* ------------------------------------------------------------------ rules */

const PUBLIC_PREFIX = /^(NEXT_PUBLIC_|VITE_|REACT_APP_|PUBLIC_|NUXT_PUBLIC_|EXPO_PUBLIC_|GATSBY_|VUE_APP_)/;
/** Names that are meant to be public even though they say "key" or "token". */
const MEANT_PUBLIC = /(PUBLISHABLE|ANON_KEY|ANON$|PUBLIC_KEY|SITE_KEY|_DSN$|MEASUREMENT_ID|POSTHOG|ANALYTICS|MAPBOX|RECAPTCHA_SITE|VAPID_PUBLIC|CLIENT_ID$|APP_ID$|PROJECT_ID$)/;
const STRONG_SECRET = /(SERVICE_ROLE|SECRET|PRIVATE|PASSWORD|PASSWD|DATABASE_URL|DB_URL|POSTGRES_URL|MONGODB_URI|CONNECTION_STRING|SIGNING_KEY|ENCRYPTION_KEY|WEBHOOK_SECRET)/;
const WEAK_SECRET = /(API_KEY|_KEY$|TOKEN|CREDENTIAL|AUTH)/;

export const secretLike = (key: string) => !MEANT_PUBLIC.test(key) && (STRONG_SECRET.test(key) || WEAK_SECRET.test(key));
const strongSecret = (key: string) => !MEANT_PUBLIC.test(key) && STRONG_SECRET.test(key);

/** Node.js major versions past end of life as of 2026-10 (Node 20 ended 2026-04-30). */
const NODE_EOL = new Set(["8", "10", "12", "14", "16", "18", "20"]);

const REF = {
  env: "https://vercel.com/docs/environment-variables/sensitive-environment-variables",
  framework: "https://nextjs.org/docs/app/building-your-application/configuring/environment-variables#bundling-environment-variables-for-the-browser",
  protection: "https://vercel.com/docs/deployment-protection",
  fork: "https://vercel.com/docs/git#git-fork-protection",
  node: "https://nodejs.org/en/about/previous-releases",
};

type Draft = Omit<FindingDraft, "agent" | "fingerprint" | "asset" | "evidenceSource"> & { key: string };

export function vercelAsset(p: Pick<ProjectInfo, "name" | "teamId">) {
  return `vercel:${p.teamId ?? "personal"}/${p.name}`;
}

/** Findings from the project's own settings and variable metadata. Nothing here makes a request. */
export function configFindings(s: VercelSnapshot): FindingDraft[] {
  const { project: p, envs } = s;
  const out: Draft[] = [];
  const where = `Vercel project ${p.name}`;
  const ev = (detail: string) => ({ source: "Vercel API (project settings, read-only)", detail });
  const previewsProtected = p.ssoProtection != null || p.passwordProtection != null;

  for (const e of envs) {
    if (PUBLIC_PREFIX.test(e.key) && secretLike(e.key)) {
      const strong = strongSecret(e.key);
      out.push({
        key: e.key,
        ruleId: "vercel.env-public-secret",
        title: `${e.key} looks like a secret but is exposed to the browser`,
        description: `Variables starting with ${PUBLIC_PREFIX.exec(e.key)![1]} are copied into the JavaScript sent to every visitor. The name ${e.key} suggests a credential. If it is one, anyone can read it from the site's code.`,
        severity: strong ? "high" : "medium",
        confidence: "tentative",
        rationale: "Based on the variable's name only: Orbis never reads values, so a person must check whether it really is a secret.",
        location: `${where} → environment variable ${e.key}`,
        evidence: [ev(`${e.key} · type ${e.type} · targets ${e.targets.join(", ") || "none"}`)],
        remediation: `If ${e.key} is a credential, rotate it now (it has already been published), rename it without the public prefix and read it only in server code. If it is meant to be public (a publishable or anonymous key), mark this finding as a false positive.`,
        references: [REF.framework],
      });
    }
    if (e.type === "plain" && secretLike(e.key) && !PUBLIC_PREFIX.test(e.key)) {
      out.push({
        key: e.key,
        ruleId: "vercel.env-plain-secret",
        title: `${e.key} is stored as a plain (readable) variable`,
        description: `Plain variables can be read in the Vercel dashboard and API by everyone with access to the project. ${e.key} looks like a credential, which should be stored as Sensitive so nobody can read it back.`,
        severity: strongSecret(e.key) ? "medium" : "low",
        confidence: "firm",
        rationale: "The storage type is a fact from Vercel; whether the value is secret is inferred from the name.",
        location: `${where} → environment variable ${e.key}`,
        evidence: [ev(`${e.key} · type plain · targets ${e.targets.join(", ")}`)],
        remediation: `Re-create ${e.key} as a Sensitive variable (Settings → Environment Variables), then rotate the credential, since its value was readable.`,
        references: [REF.env],
      });
    }
    if (strongSecret(e.key) && !PUBLIC_PREFIX.test(e.key) && e.targets.includes("production") && e.targets.includes("preview") && !e.gitBranch) {
      const forks = p.gitForkProtection === false;
      out.push({
        key: e.key,
        ruleId: "vercel.env-prod-secret-in-preview",
        title: `Production credential ${e.key} is also given to preview deployments`,
        description: `${e.key} is one variable shared by Production and Preview, so every preview build — from any branch${forks ? ", including pull requests from forks (fork protection is off)" : ""} — runs with the production value.${previewsProtected ? "" : " Preview deployments are also publicly reachable."}`,
        severity: forks ? "high" : "medium",
        confidence: "firm",
        rationale: "Branch code is less reviewed than production code; a preview build that can read production credentials turns any merged-to-branch mistake into production access.",
        location: `${where} → environment variable ${e.key}`,
        evidence: [ev(`${e.key} targets: ${e.targets.join(", ")} (one variable, so the same value)`)],
        remediation: `Give Preview its own value for ${e.key} (a staging database or test key) and limit the production value to the Production environment.`,
        references: [REF.env],
      });
    }
  }

  if (p.ssoProtection === null && p.passwordProtection === null) {
    out.push({
      key: "preview",
      ruleId: "vercel.preview-unprotected",
      title: "Preview deployments are public",
      description: "Neither Vercel Authentication nor password protection is on, so anyone with a preview URL can open unreleased versions of the site (and use any preview-only data or credentials behind them). Preview URLs are guessable from the project and branch name.",
      severity: "medium",
      confidence: "confirmed",
      rationale: "A project setting reported by Vercel.",
      location: `${where} → Deployment Protection`,
      evidence: [ev("ssoProtection: off · passwordProtection: off")],
      remediation: "Turn on Vercel Authentication for preview deployments (Settings → Deployment Protection → Standard Protection).",
      references: [REF.protection],
    });
  }
  if (p.gitForkProtection === false && p.link) {
    out.push({
      key: "fork",
      ruleId: "vercel.fork-protection-off",
      title: "Pull requests from forks deploy without approval",
      description: `Git fork protection is off for ${p.link.repo}. Anyone can open a pull request from a fork and get it built and deployed with this project's preview environment variables.`,
      severity: envs.some((e) => e.targets.includes("preview") && secretLike(e.key)) ? "high" : "medium",
      confidence: "confirmed",
      rationale: "A project setting reported by Vercel; impact depends on which variables previews can read.",
      location: `${where} → Git`,
      evidence: [ev(`gitForkProtection: false · repository ${p.link.repo}`)],
      remediation: "Turn Git Fork Protection back on (Settings → Git) so fork pull requests need an authorised member's approval before they deploy.",
      references: [REF.fork],
    });
  }
  if (p.publicSource === true) {
    out.push({
      key: "source",
      ruleId: "vercel.public-source",
      title: "Source code and build logs are public",
      description: "Public source is on, so anyone can read this project's source code and logs at /_src and /_logs on its deployments.",
      severity: "high",
      confidence: "confirmed",
      rationale: "A project setting reported by Vercel.",
      location: `${where} → Build and Deployment`,
      evidence: [ev("publicSource: true")],
      remediation: "Turn off public source (Settings → General → Build Logs and Source Protection), unless the project is intentionally open source.",
      references: [REF.protection],
    });
  }
  if (p.directoryListing === true) {
    out.push({
      key: "listing",
      ruleId: "vercel.directory-listing",
      title: "Directory listing is on",
      description: "Folders without an index file show a list of their files, which can reveal files that weren't meant to be linked.",
      severity: "low",
      confidence: "confirmed",
      rationale: "A project setting reported by Vercel.",
      location: `${where} → Build and Deployment`,
      evidence: [ev("directoryListing: true")],
      remediation: "Turn off Directory Listing (Settings → Advanced) unless it's needed.",
      references: [REF.protection],
    });
  }
  const nodeMajor = p.nodeVersion?.match(/^(\d+)/)?.[1];
  if (nodeMajor && NODE_EOL.has(nodeMajor)) {
    out.push({
      key: "node",
      ruleId: "vercel.node-eol",
      title: `Functions run on Node.js ${p.nodeVersion}, which no longer gets security fixes`,
      description: `Node.js ${nodeMajor} has reached end of life, so security issues found in it are no longer patched.`,
      severity: "medium",
      confidence: "confirmed",
      rationale: "The runtime version is reported by Vercel; end-of-life dates are published by the Node.js project.",
      location: `${where} → Build and Deployment → Node.js Version`,
      evidence: [ev(`nodeVersion: ${p.nodeVersion}`)],
      remediation: "Choose a supported Node.js version (22.x or later) in Settings → Build and Deployment, then redeploy and run the tests.",
      references: [REF.node],
    });
  }
  for (const d of s.domains.filter((x) => !x.verified)) {
    out.push({
      key: `domain:${d.name}`,
      ruleId: "vercel.domain-unverified",
      title: `Domain ${d.name} isn't verified`,
      description: `${d.name} is added to the project but not verified, so Vercel won't serve it. If its DNS still points at Vercel, someone else could try to claim it.`,
      severity: "low",
      confidence: "confirmed",
      rationale: "Verification status reported by Vercel.",
      location: `${where} → Domains → ${d.name}`,
      evidence: [ev(`${d.name}: verified false`)],
      remediation: `Finish verification for ${d.name}, or remove it from the project and its DNS records.`,
      references: [REF.protection],
    });
  }
  if (p.bypassSecrets > 0) {
    out.push({
      key: "bypass",
      ruleId: "vercel.protection-bypass",
      title: `${p.bypassSecrets} protection-bypass secret${p.bypassSecrets === 1 ? "" : "s"} exist`,
      description: "Protection bypass secrets let automated tools open protected deployments. Anyone holding one skips Deployment Protection. Orbis didn't read the secrets; it only counted them.",
      severity: "info",
      confidence: "confirmed",
      rationale: "Normal for CI and testing tools; worth knowing where they are stored and rotating ones that are no longer used.",
      location: `${where} → Deployment Protection → Protection Bypass for Automation`,
      evidence: [ev(`${p.bypassSecrets} bypass secret(s)`)],
      remediation: "Check which tools use each bypass secret and revoke unused ones.",
      references: [REF.protection],
    });
  }

  const asset = vercelAsset(p);
  return out.map<FindingDraft>(({ key, ...d }) => ({ ...d, agent: "sentinel", asset, evidenceSource: "vercel:api", fingerprint: fingerprint("sentinel", d.ruleId, asset, key) }));
}

/**
 * What a passive request to a preview deployment showed: 401/403 means protection is on; a page means it's public.
 * Adds evidence to the "preview unprotected" finding, or records the check when it disagrees with the setting.
 */
export function previewProbe(findings: FindingDraft[], url: string, status: number | null): string {
  const f = findings.find((x) => x.ruleId === "vercel.preview-unprotected");
  const seen = status == null ? "no response" : `HTTP ${status}`;
  if (f) f.evidence.push({ source: `Passive request to ${url}`, detail: status != null && status < 400 ? `${seen}: the preview opened without signing in.` : `${seen}.` });
  if (status === 401 || status === 403) return `Preview ${url} answered ${seen}: protected.`;
  if (status != null && status < 400) return `Preview ${url} answered ${seen}: reachable without signing in.`;
  return `Preview ${url}: ${seen}.`;
}

/* -------------------------------------------------------------- the gate */

export interface DeployGateConfig {
  /** "warn" never blocks; "block" fails the gate on blocking findings. Advisory either way: Orbis doesn't stop Vercel builds. */
  mode: "warn" | "block";
  blockSeverities: Severity[];
}
export const DEFAULT_DEPLOY_GATE: DeployGateConfig = { mode: "warn", blockSeverities: ["critical", "high"] };

export interface DeployGateResult {
  decision: "allow" | "warn" | "block" | "incomplete";
  gate: GateResult;
  reasons: string[];
  considered: { deployment: number; repository: number };
}

/**
 * The pre-deploy decision. Only confirmed or likely findings can block — never ones that still need verification,
 * whatever the configuration — and a check that didn't run makes the result incomplete, not a pass.
 */
export function deployGate(input: { deployment: (FindingLike & { id: string })[]; repository: (FindingLike & { id: string })[]; steps: { label: string; status: string }[]; repoAudited: boolean }, cfg: DeployGateConfig): DeployGateResult {
  const gate = evaluateGate([...input.deployment, ...input.repository], { blockSeverities: cfg.blockSeverities, blockUnverified: false }, input.steps);
  const reasons = [...gate.reasons];
  if (!input.repoAudited) reasons.push("The linked repository hasn't been audited by Code Guardian, so code findings aren't part of this decision.");
  const decision = gate.outcome === "incomplete" ? "incomplete" : gate.outcome === "failed" ? (cfg.mode === "block" ? "block" : "warn") : "allow";
  return { decision, gate, reasons, considered: { deployment: input.deployment.length, repository: input.repository.length } };
}

/** Drafts as stored-finding shapes, for the gate (they're open by definition: just found). */
export function asOpenFindings(fs: FindingDraft[]): (FindingLike & { id: string })[] {
  return fs.map((f) => ({
    id: f.fingerprint,
    agent: f.agent,
    rule_id: f.ruleId,
    title: f.title,
    description: f.description,
    severity: f.severity,
    confidence: f.confidence as Confidence,
    asset: f.asset,
    location: f.location,
    evidence: f.evidence,
    evidence_source: f.evidenceSource,
    remediation: f.remediation,
    status: "open",
    verification: "not_verified",
  }));
}

/* ------------------------------------------------------------------ reads */

const TEAM_RE = /^team_[A-Za-z0-9]{1,64}$/;
export const PROJECT_RE = /^[A-Za-z0-9._-]{1,100}$/;

/** Everything the audit needs, read with the person's Vercel token. A part Vercel refuses is listed in `missing`. */
export async function readVercelProject(ctx: ToolContext, project: string, teamId: string | null): Promise<VercelSnapshot> {
  if (!PROJECT_RE.test(project)) throw new ConnectorError("bad_request", "Use the project's id or name.");
  if (teamId && !TEAM_RE.test(teamId)) throw new ConnectorError("bad_request", "That team id doesn't look right.");
  const team = teamId ? `teamId=${encodeURIComponent(teamId)}` : "";
  const get = <T>(path: string) => callJson<T>(`${API}${path}${path.includes("?") ? (team ? `&${team}` : "") : team ? `?${team}` : ""}`, { token: ctx.token, service: "Vercel", signal: ctx.signal }, ctx.fetch);
  const missing: string[] = [];
  const raw = await get<Record<string, unknown>>(`/v9/projects/${encodeURIComponent(project)}`).catch((err) => {
    if (err instanceof ConnectorError && (err.kind === "permission" || err.kind === "not_found"))
      throw new ConnectorError(err.kind, `Vercel didn't let Orbis read ${project}. Check that Orbis's Vercel app is installed on that ${teamId ? "team" : "account"} with access to projects.`, err.status);
    throw err;
  });
  const info = projectInfo(raw, teamId);
  const pid = encodeURIComponent(info.id || project);
  const part = async <T>(label: string, fn: () => Promise<T>, empty: T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      missing.push(`${label} (${err instanceof ConnectorError ? err.message.slice(0, 120) : "failed"})`);
      return empty;
    }
  };
  const [envs, domains, deployments] = await Promise.all([
    // decrypt is never requested; values that arrive anyway are dropped by envMeta.
    part("environment variables", async () => ((await get<{ envs?: Record<string, unknown>[] }>(`/v10/projects/${pid}/env`)).envs ?? []).map(envMeta).filter((e): e is EnvMeta => !!e).slice(0, 300), [] as EnvMeta[]),
    part(
      "domains",
      async () =>
        ((await get<{ domains?: { name: string; verified?: boolean; redirect?: string | null; gitBranch?: string | null }[] }>(`/v9/projects/${pid}/domains?limit=50`)).domains ?? []).map((d) => ({ name: d.name, verified: d.verified !== false, redirect: d.redirect ?? null, gitBranch: d.gitBranch ?? null })),
      [] as DomainInfo[],
    ),
    part(
      "deployments",
      async () =>
        ((await get<{ deployments?: { uid: string; url?: string | null; target?: string | null; state?: string; readyState?: string; created: number; meta?: { githubCommitSha?: string; githubCommitRef?: string } }[] }>(`/v6/deployments?projectId=${pid}&limit=10`)).deployments ?? []).map((d) => ({
          id: d.uid,
          url: d.url ?? null,
          target: d.target ?? "preview",
          state: d.readyState ?? d.state ?? "UNKNOWN",
          created: d.created,
          commit: d.meta?.githubCommitSha?.slice(0, 40) ?? null,
          branch: d.meta?.githubCommitRef?.slice(0, 120) ?? null,
        })),
      [] as DeploymentInfo[],
    ),
  ]);
  return { project: info, envs, domains, deployments, missing };
}

/** The production hostname to check: the first verified custom domain that serves (doesn't redirect), else the vercel.app alias. */
export function productionHost(s: VercelSnapshot): string | null {
  const custom = s.domains.find((d) => d.verified && !d.redirect && !d.gitBranch && !d.name.endsWith(".vercel.app"));
  if (custom) return custom.name;
  const app = s.domains.find((d) => d.verified && !d.redirect && !d.gitBranch);
  return app?.name ?? null;
}
