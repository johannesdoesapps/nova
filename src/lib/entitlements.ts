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
 * - Administrators: no allowance while ORBIS_ADMINS_UNLIMITED isn't "false".
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
  /** A payment problem the user should fix: a failed renewal (plan kept until `graceUntil`), or a disputed charge. */
  paymentIssue: { kind: "past_due"; graceUntil: number | null } | { kind: "disputed" } | null;
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
  const s = bestStatus(sub.own, sub.team, billing.paymentGraceDays);
  const base = { plan: s.plan, interval: s.interval, limits: planOf(billing, s.plan), billing, periodStart: s.periodStart, paymentIssue: s.issue };
  if (admin && serverEnv().adminsUnlimited) return { ...base, kind: "unlimited", reason: "admin", label: "admin_unlimited" };
  return { ...base, kind: "plan", label: `plan:${s.plan}` };
}

/** The user's plan: Pro or Max while that subscription is active or trialing (or in its grace period); everyone else is Free. */
export async function userPlan(auth: AuthContext & { mode: "authenticated" }): Promise<PlanId> {
  const [sub, billing] = await Promise.all([subscriptionOf(auth), getBilling()]);
  return bestStatus(sub.own, sub.team, billing.paymentGraceDays).plan;
}

export type SubscriptionStatusRow = { plan: PlanId; status: string; billing_interval?: string | null; current_period_start?: string | null; disputed?: boolean | null };

const DAY = 86_400_000;

/**
 * The plan a subscription row gives. Active or trialing: the paid plan. Past due (a renewal payment failed and
 * Stripe is retrying the card): the paid plan for `graceDays` days from the start of the unpaid period, then Free.
 * A charge under dispute: Free until the dispute is settled in Orbis's favour.
 */
export function paidStatus(
  row: SubscriptionStatusRow | null,
  graceDays: number,
  now = Date.now(),
): { plan: PlanId; interval: BillingInterval; periodStart: number | null; issue: Entitlement["paymentIssue"] } {
  const free = { plan: "free" as PlanId, interval: "month" as BillingInterval, periodStart: null };
  if (!row || (row.plan !== "pro" && row.plan !== "max")) return { ...free, issue: null };
  if (row.disputed) return { ...free, issue: { kind: "disputed" } };
  const periodStart = row.current_period_start ? Date.parse(row.current_period_start) : null;
  const paid = { plan: row.plan, interval: (row.billing_interval === "year" ? "year" : "month") as BillingInterval, periodStart };
  if (["active", "trialing"].includes(row.status)) return { ...paid, issue: null };
  if (row.status === "past_due") {
    const graceUntil = periodStart !== null && graceDays > 0 ? periodStart + graceDays * DAY : null;
    return graceUntil !== null && now < graceUntil ? { ...paid, issue: { kind: "past_due", graceUntil } } : { ...free, issue: { kind: "past_due", graceUntil } };
  }
  return { ...free, issue: null };
}

/**
 * The subscription that gives this user a plan: their own, or else their team's (each team member gets the
 * team's plan with their own allowance). Their own wins when it is paid.
 */
async function subscriptionOf(auth: AuthContext & { mode: "authenticated" }): Promise<{ own: SubscriptionStatusRow | null; team: SubscriptionStatusRow | null }> {
  const [{ data }, { data: membership }] = await Promise.all([
    auth.supabase.from("subscriptions").select("*").eq("user_id", auth.user.id).maybeSingle(),
    auth.supabase.from("team_members").select("team_id, teams(plan, status, billing_interval, current_period_start, disputed)").eq("user_id", auth.user.id).maybeSingle(),
  ]);
  const own = (data as SubscriptionStatusRow | null) ?? null;
  const t = (membership as { teams?: SubscriptionStatusRow | SubscriptionStatusRow[] | null } | null)?.teams;
  const team = (Array.isArray(t) ? t[0] : t) ?? null;
  return { own, team };
}

/** The plan from the user's own subscription if it is paid, else from their team's; own payment issues show first. */
export function bestStatus(own: SubscriptionStatusRow | null, team: SubscriptionStatusRow | null, graceDays: number, now = Date.now()): ReturnType<typeof paidStatus> {
  const mine = paidStatus(own, graceDays, now);
  if (mine.plan !== "free" || !team) return mine;
  const theirs = paidStatus(team, graceDays, now);
  return theirs.plan !== "free" ? theirs : mine.issue ? mine : theirs;
}
