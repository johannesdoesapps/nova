import "server-only";
import { isAdmin } from "./admin";
import type { AuthContext } from "./auth";
import { serverEnv } from "./env";
import { getPlatformSettings } from "./ai/settings";
import { planOf, resolveBilling, type BillingInterval, type BillingSettings, type Plan, type PlanId } from "./plans";

/**
 * Who may use how much — decided in one place, on the server, from trusted
 * data only: the `admins` table (rows are added with SQL, never by sign-up)
 * and the `subscriptions` table (written by the payment webhook). Nothing the
 * browser sends can change an entitlement.
 *
 * Policy:
 * - Guests: the per-IP daily cap in usage.ts.
 * - Signed-in users: their plan's allowance and monthly AI budget (Free unless
 *   an active or trialing Pro or Max subscription exists), from the billing
 *   settings administrators edit in Admin → Plans & pricing.
 * - Administrators: no allowance while NOVA_ADMINS_UNLIMITED isn't "false".
 *   Their runs are still recorded, marked admin_unlimited, so it's auditable.
 * - Test accounts get limits like anyone else; give one Pro with a
 *   subscriptions row, or admin rights with an admins row, if a test needs more.
 */
export type Entitlement = {
  plan: PlanId;
  interval: BillingInterval;
  /** The plan's limits from the admin-configured billing settings. */
  limits: Plan;
  billing: BillingSettings;
  /** Start of the current paid billing period (epoch ms), if any. */
  periodStart: number | null;
} & ({ kind: "unlimited"; reason: "admin"; label: "admin_unlimited" } | { kind: "plan"; label: `plan:${PlanId}` });

const cache = new WeakMap<object, Promise<Entitlement | null>>();

/** The caller's entitlement; null for guests. Cached for the request. */
export function entitlementFor(auth: AuthContext): Promise<Entitlement | null> {
  if (auth.mode !== "authenticated") return Promise.resolve(null);
  let p = cache.get(auth);
  if (!p) {
    p = resolve(auth);
    cache.set(auth, p);
  }
  return p;
}

/** Billing settings: the administrator's changes over the defaults. */
export async function getBilling(): Promise<BillingSettings> {
  return resolveBilling((await getPlatformSettings()).billing);
}

async function resolve(auth: AuthContext & { mode: "authenticated" }): Promise<Entitlement> {
  const [admin, sub, billing] = await Promise.all([isAdmin(auth), subscriptionOf(auth), getBilling()]);
  const base = { plan: sub.plan, interval: sub.interval, limits: planOf(billing, sub.plan), billing, periodStart: sub.periodStart };
  if (admin && serverEnv().adminsUnlimited) return { ...base, kind: "unlimited", reason: "admin", label: "admin_unlimited" };
  return { ...base, kind: "plan", label: `plan:${sub.plan}` };
}

/** The user's plan: Pro or Max only while that subscription is active or trialing; everyone else is Free. */
export async function userPlan(auth: AuthContext & { mode: "authenticated" }): Promise<PlanId> {
  return (await subscriptionOf(auth)).plan;
}

async function subscriptionOf(auth: AuthContext & { mode: "authenticated" }): Promise<{ plan: PlanId; interval: BillingInterval; periodStart: number | null }> {
  const { data } = await auth.supabase.from("subscriptions").select("*").eq("user_id", auth.user.id).maybeSingle();
  const row = data as { plan: PlanId; status: string; billing_interval?: string; current_period_start?: string | null } | null;
  const paid = !!row && (row.plan === "pro" || row.plan === "max") && ["active", "trialing"].includes(row.status);
  if (!paid) return { plan: "free", interval: "month", periodStart: null };
  return { plan: row.plan, interval: row.billing_interval === "year" ? "year" : "month", periodStart: row.current_period_start ? Date.parse(row.current_period_start) : null };
}
