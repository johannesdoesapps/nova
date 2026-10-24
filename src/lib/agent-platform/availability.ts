import type { PlanId } from "../plans";
import type { AgentDef, Requirement } from "./registry";

/**
 * Whether an agent can run here, for this user, worked out from the server's
 * configuration and the user's plan. The marketplace shows it; the start-task
 * API enforces the same answer, so the page can't offer what the server would
 * refuse.
 */

export interface PlatformFlags {
  /** Any AI provider key is set. */
  ai: boolean;
  anthropic: boolean;
  /** Isolated computers (Vercel Sandbox) can start here. */
  sandbox: boolean;
  /** Accounts (Supabase) are configured. */
  accounts: boolean;
}

export type Availability =
  | { state: "available" }
  | { state: "sign_in"; message: string }
  | { state: "setup"; message: string; missing: Requirement[] }
  | { state: "upgrade"; message: string; plans: PlanId[] };

const SETUP_MESSAGE: Record<Requirement, string> = {
  ai: "No AI provider is configured on this Orbis deployment.",
  anthropic: "Needs Claude (an Anthropic API key) on this Orbis deployment.",
  sandbox: "Isolated computers aren't available on this deployment (Vercel Sandbox).",
  accounts: "Accounts aren't configured on this deployment.",
};

const PLAN_LABEL: Record<PlanId, string> = { free: "Free", pro: "Pro", max: "Max" };

/** `plan` is null for a signed-out visitor; `admin` users have every plan's access. */
export function availability(def: Pick<AgentDef, "requires" | "plans">, flags: PlatformFlags, plan: PlanId | null, admin = false): Availability {
  const missing = def.requires.filter((r) => !flags[r]);
  if (missing.length) return { state: "setup", message: missing.map((r) => SETUP_MESSAGE[r]).join(" "), missing };
  if (def.requires.includes("accounts") && plan === null) return { state: "sign_in", message: "Sign in to use this agent." };
  if (!admin && plan !== null && !def.plans.includes(plan)) {
    const names = def.plans.map((p) => PLAN_LABEL[p]);
    return { state: "upgrade", message: `Included in ${names.join(" and ")}.`, plans: def.plans };
  }
  return { state: "available" };
}

/** Plain words for a plan list ("Every plan", "Pro and Max"). */
export function plansLabel(plans: PlanId[]): string {
  if (plans.length === 3) return "Every plan";
  return plans.map((p) => PLAN_LABEL[p]).join(" and ");
}
