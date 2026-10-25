import { z } from "zod";

/**
 * Which Bastion Customer Security features each plan includes. Plans map to tiers through Bastion's controls
 * (administrators can change the mapping), so packaging can change without code changes. Checked on the server;
 * the page only explains what a tier includes. Bastion Core protections apply on every plan and aren't listed here.
 */

export const TIERS = ["basic", "advanced", "business"] as const;
export type Tier = (typeof TIERS)[number];
export const TIER_LABEL: Record<Tier, string> = { basic: "Basic", advanced: "Advanced", business: "Business" };

export const planTiersSchema = z.object({ free: z.enum(TIERS), pro: z.enum(TIERS), max: z.enum(TIERS) }).strict();
export type PlanTiers = z.infer<typeof planTiersSchema>;
export const DEFAULT_PLAN_TIERS: PlanTiers = { free: "basic", pro: "advanced", max: "business" };

export const FEATURES = {
  overview: { tier: "basic", label: "Security overview" },
  workspace_checks: { tier: "basic", label: "Essential workspace checks" },
  agent_inventory: { tier: "basic", label: "Agent inventory and permissions" },
  pause_agents: { tier: "basic", label: "Pausing agents" },
  quick_check: { tier: "basic", label: "Quick check of a project" },
  all_findings: { tier: "advanced", label: "Findings of every severity (Basic shows critical and high)" },
  finding_workflow: { tier: "advanced", label: "Assigning, investigating and suppressing findings" },
  deep_assessment: { tier: "advanced", label: "Deep assessment" },
  deploy_gate: { tier: "advanced", label: "Pre-deployment gate" },
  recheck: { tier: "advanced", label: "Targeted recheck" },
  policies: { tier: "advanced", label: "Workspace policies" },
  roles: { tier: "business", label: "Team roles on this workspace" },
  retention: { tier: "business", label: "Custom history retention" },
  export: { tier: "business", label: "Audit and findings export" },
} as const satisfies Record<string, { tier: Tier; label: string }>;
export type Feature = keyof typeof FEATURES;

const RANK: Record<Tier, number> = { basic: 0, advanced: 1, business: 2 };
export const hasFeature = (tier: Tier, f: Feature) => RANK[tier] >= RANK[FEATURES[f].tier];

/** How many days of history and audit each tier shows by default. */
export const HISTORY_DAYS: Record<Tier, number> = { basic: 7, advanced: 90, business: 365 };

export function tierFor(plan: string, opts: { unlimited?: boolean; mapping?: PlanTiers | null } = {}): Tier {
  if (opts.unlimited) return "business";
  const m = opts.mapping ?? DEFAULT_PLAN_TIERS;
  return m[plan as keyof PlanTiers] ?? "basic";
}

/** Days of history to show: the workspace's retention setting (Business), else the tier's default. */
export const historyDays = (tier: Tier, retention: number | null) => (retention && hasFeature(tier, "retention") ? retention : HISTORY_DAYS[tier]);
