import { z } from "zod";
import { AUDIT_MODES, TIME_BUDGETS } from "./audit";
import { ACTION_STATUSES, INVESTIGATION_STATES } from "./hunt/investigate";
import { CONFIDENCES, FINDING_STATUSES, SEVERITIES } from "./types";

const modelId = z.string().min(1).max(120).optional();
const parentId = z.uuid().optional();
const filePath = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((p) => !p.split(/[\\/]/).includes(".."), "File paths can't contain '..'.");

export const targetCreate = z.object({ host: z.string().trim().min(3).max(300) });

/** POST /api/security/sitescan: an SSL/TLS and web-configuration scan of a verified target. */
export const siteScanRequest = z.object({
  targetId: z.uuid(),
  scope: z.enum(["passive", "active"]).default("passive"),
  authorized: z.literal(true, { error: "Confirm you own or are authorised to test this website." }),
  /** Scan again even if a scan of the same site and scope finished in the last 15 minutes. */
  force: z.boolean().default(false),
});

export const sentinelRequest = z.object({
  targetId: z.uuid(),
  scope: z.enum(["passive", "active"]).default("passive"),
  /** The user's explicit confirmation, required for every scan. */
  authorized: z.literal(true, { error: "Confirm you own or are authorised to test this website." }),
  /** With an audit mode, Sentinel also maps the site within that mode's budget. */
  mode: z.enum(AUDIT_MODES).optional(),
  timeBudget: z.enum(TIME_BUDGETS).default("standard"),
  modelId,
  parentId,
});

export const hunterRequest = z
  .object({
    logs: z.array(z.object({ name: z.string().trim().min(1).max(200), content: z.string().max(3_000_000) })).max(10).default([]),
    indicators: z.string().max(20_000).default(""),
    asset: z.string().trim().max(120).default(""),
    modelId,
    parentId,
  })
  .refine((b) => b.logs.some((l) => l.content.trim()) || b.indicators.trim(), "Add a log file or some indicators to investigate.")
  .refine((b) => b.logs.reduce((n, l) => n + l.content.length, 0) <= 3_000_000, "Logs are limited to 3 MB per investigation.");

export const deploymentAuditRequest = z.object({
  project: z.string().trim().regex(/^[A-Za-z0-9._-]{1,100}$/, "Use the project's id or name."),
  teamId: z.string().regex(/^team_[A-Za-z0-9]{1,64}$/).nullable().optional(),
  gate: z.object({ mode: z.enum(["warn", "block"]), blockSeverities: z.array(z.enum(["critical", "high", "medium"])).min(1).max(3) }).optional(),
  siteChecks: z.boolean().default(true),
  modelId,
  parentId,
});

export const guardianRequest = z
  .object({
    source: z.discriminatedUnion("type", [
      z.object({ type: z.literal("upload"), files: z.array(z.object({ path: filePath, content: z.string().max(1_000_000) })).min(1).max(800) }),
      z.object({ type: z.literal("github"), repo: z.string().trim().min(3).max(300) }),
      z.object({ type: z.literal("github_pr"), repo: z.string().trim().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/, "Use owner/name."), number: z.number().int().min(1).max(9_999_999) }),
    ]),
    asset: z.string().trim().max(120).default(""),
    aiReview: z.boolean().default(true),
    proposeFixes: z.boolean().default(false),
    modelId,
    parentId,
  })
  .refine((b) => b.source.type !== "upload" || b.source.files.reduce((n, f) => n + f.content.length, 0) <= 3_000_000, "Uploads are limited to 3 MB of code per audit.");

/** A Sentinel audit: its mode, time budget, testing permission and (for the release gate) what blocks. */
export const auditConfig = z.object({
  mode: z.enum(AUDIT_MODES),
  timeBudget: z.enum(TIME_BUDGETS).default("standard"),
  /** Active testing (exposed files, signed-out endpoint checks, error pages) — read-only, but the user must choose it. */
  active: z.boolean().default(false),
  gate: z
    .object({ blockSeverities: z.array(z.enum(SEVERITIES)).min(1).max(5).default(["critical", "high"]), blockUnverified: z.boolean().default(false) })
    .default({ blockSeverities: ["critical", "high"], blockUnverified: false }),
});
export type AuditConfig = z.infer<typeof auditConfig>;

export const coordinateStart = z
  .object({
    plan: z
      .array(z.enum(["sentinel", "threat_hunter", "code_guardian"]))
      .min(1)
      .max(3),
    asset: z.string().trim().max(120).default(""),
    audit: auditConfig.optional(),
  })
  // A coordinated investigation links at least two agents; an audit may cover just the website or just the code.
  .refine((b) => b.audit || b.plan.length >= 2, "Choose at least two agents.");
export const coordinateReport = z.object({ modelId });

/**
 * People can't set "verified": a fix counts only when a re-check (or a newer scan) no longer detects the finding.
 * Marking it "fixed" means "awaiting verification" until then.
 */
export const PERSON_STATUSES = FINDING_STATUSES.filter((s) => s !== "verified") as unknown as readonly ["open", "investigating", "fix_proposed", "fixed", "accepted_risk", "false_positive"];
export const findingPatch = z.object({
  status: z.enum(PERSON_STATUSES, { message: "A finding is marked verified only by a re-check that no longer detects it." }).optional(),
  severity: z.enum(SEVERITIES).optional(),
  confidence: z.enum(CONFIDENCES).optional(),
  user_note: z.string().max(4000).nullable().optional(),
  duplicate_of: z.uuid().nullable().optional(),
});

export const findingsQuery = z.object({
  agent: z.string().max(30).optional(),
  severity: z.enum(SEVERITIES).optional(),
  status: z.enum(FINDING_STATUSES).optional(),
  asset: z.string().max(300).optional(),
  q: z.string().max(100).optional(),
  sort: z.enum(["severity", "recent", "oldest"]).optional(),
  includeDuplicates: z.enum(["1", "0"]).optional(),
  /** security (default): security findings only; engineering: Code Guardian defects/dependencies/maintainability; all. */
  scope: z.enum(["security", "engineering", "all"]).optional(),
});

/**
 * A person's decision on a Threat Hunter investigation: a state change (always with a reason), a note, or the
 * status of one recommended action. Recorded with the investigation and in the audit trail.
 */
export const investigationPatch = z
  .object({
    state: z.enum(INVESTIGATION_STATES).optional(),
    note: z.string().trim().max(2000).optional(),
    action: z.object({ key: z.string().regex(/^(containment|credentials|eradication):\d{1,2}$/), status: z.enum(ACTION_STATUSES), note: z.string().trim().max(1000).optional() }).optional(),
  })
  .refine((b) => b.state || b.note || b.action, "Nothing to record.")
  .refine((b) => !b.state || (b.note ?? "").length >= 3, "Say why you're changing the state (a short note is enough).");
