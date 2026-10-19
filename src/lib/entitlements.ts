import "server-only";
import { isAdmin } from "./admin";
import type { AuthContext } from "./auth";
import { serverEnv } from "./env";
import { PLANS, type Plan, type PlanId } from "./plans";

/**
 * Who may use how much — decided in one place, on the server, from trusted
 * data only: the `admins` table (rows are added with SQL, never by sign-up)
 * and the `subscriptions` table (written by the payment webhook). Nothing the
 * browser sends can change an entitlement.
 *
 * Policy:
 * - Guests: the per-IP daily cap in usage.ts.
 * - Signed-in users: their plan's 5-hour and weekly allowance (Free unless an
 *   active or trialing Pro subscription exists).
 * - Administrators: no allowance while NOVA_ADMINS_UNLIMITED isn't "false".
 *   Their runs are still recorded, marked admin_unlimited, so it's auditable.
 * - Test accounts get limits like anyone else; give one Pro with a
 *   subscriptions row, or admin rights with an admins row, if a test needs more.
 */
export type Entitlement =
  | { kind: "unlimited"; reason: "admin"; label: "admin_unlimited"; plan: PlanId }
  | { kind: "plan"; plan: PlanId; limits: Plan; label: `plan:${PlanId}` };

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

async function resolve(auth: AuthContext & { mode: "authenticated" }): Promise<Entitlement> {
  const [admin, plan] = await Promise.all([isAdmin(auth), userPlan(auth)]);
  if (admin && serverEnv().adminsUnlimited) return { kind: "unlimited", reason: "admin", label: "admin_unlimited", plan };
  return { kind: "plan", plan, limits: PLANS[plan], label: `plan:${plan}` };
}

/** The user's plan: Pro only while a subscription is active or trialing; everyone else is Free. */
export async function userPlan(auth: AuthContext & { mode: "authenticated" }): Promise<PlanId> {
  const { data } = await auth.supabase.from("subscriptions").select("plan, status").eq("user_id", auth.user.id).maybeSingle();
  const row = data as { plan: PlanId; status: string } | null;
  return row && row.plan === "pro" && ["active", "trialing"].includes(row.status) ? "pro" : "free";
}
