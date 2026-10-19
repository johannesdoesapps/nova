import "server-only";
import Stripe from "stripe";
import { serverEnv } from "../env";
import { chargeUsd, planOf, type BillingInterval, type BillingSettings } from "../plans";
import { serviceSupabase } from "../supabase/admin";

/**
 * Pro subscriptions through Stripe. Checkout and the billing portal run on
 * Stripe's hosted pages, so card details never touch NOVA. The webhook is the
 * only thing that changes a user's plan: it re-reads the subscription from
 * Stripe and writes it with the service role.
 */

let client: Stripe | null = null;

export function billingConfigured(): boolean {
  const env = serverEnv();
  return Boolean(env.stripeSecretKey && env.stripeWebhookSecret && env.supabaseServiceRoleKey);
}

export function stripeClient(): Stripe | null {
  const key = serverEnv().stripeSecretKey;
  if (!key) return null;
  client ??= new Stripe(key, { appInfo: { name: "NOVA" } });
  return client;
}

export type PaidPlan = "pro" | "max";

/** Identifies a NOVA price in Stripe; includes the amount, so a price change creates a new price. */
export const priceLookupKey = (plan: PaidPlan, interval: BillingInterval, cents: number) => `nova_${plan}_${interval}_usd_${cents}`;

/** Parse a lookup key back into plan and interval. */
export function parseLookupKey(key: string | null | undefined): { plan: PaidPlan; interval: BillingInterval } | null {
  const m = key?.match(/^nova_(pro|max)_(month|year)_usd_\d+$/);
  return m ? { plan: m[1] as PaidPlan, interval: m[2] as BillingInterval } : null;
}

/** The Stripe price for a plan and interval at its current USD amount, created on first use. */
export async function planPriceId(stripe: Stripe, billing: BillingSettings, plan: PaidPlan, interval: BillingInterval): Promise<string> {
  const p = planOf(billing, plan);
  const cents = Math.round(chargeUsd(p, interval) * 100);
  if (cents <= 0) throw new Error(`${p.label} has no price set.`);
  const key = priceLookupKey(plan, interval, cents);
  const found = await stripe.prices.list({ lookup_keys: [key], active: true, limit: 1 });
  if (found.data[0]) return found.data[0].id;
  const price = await stripe.prices.create({
    currency: "usd",
    unit_amount: cents,
    recurring: { interval },
    lookup_key: key,
    metadata: { nova_plan: plan, nova_interval: interval },
    product_data: { name: `NOVA ${p.label}` },
  });
  return price.id;
}

type DbStatus = "active" | "trialing" | "past_due" | "canceled" | "incomplete" | "inactive";

/** Stripe's subscription status in the vocabulary of the subscriptions table. */
export function dbStatus(status: string): DbStatus {
  switch (status) {
    case "active":
    case "trialing":
    case "past_due":
    case "canceled":
    case "incomplete":
      return status;
    case "incomplete_expired":
      return "canceled";
    default:
      return "inactive"; // unpaid, paused, anything new
  }
}

export interface SubscriptionRow {
  user_id: string;
  plan: PaidPlan;
  billing_interval: BillingInterval;
  price_usd: number | null;
  status: DbStatus;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  stripe_customer_id: string | null;
  stripe_subscription_id: string;
}

const iso = (s: number | null | undefined) => (s ? new Date(s * 1000).toISOString() : null);

/** The row to store for a Stripe subscription (billing periods live on the subscription item). */
export function subscriptionRow(sub: Stripe.Subscription, userId: string): SubscriptionRow {
  const item = sub.items?.data?.[0];
  const price = item?.price;
  const parsed = parseLookupKey(price?.lookup_key);
  const metaPlan = (price?.metadata?.nova_plan ?? sub.metadata?.nova_plan) as string | undefined;
  const plan: PaidPlan = parsed?.plan ?? (metaPlan === "max" ? "max" : "pro");
  const interval: BillingInterval = parsed?.interval ?? (price?.recurring?.interval === "year" ? "year" : "month");
  return {
    user_id: userId,
    plan,
    billing_interval: interval,
    price_usd: typeof price?.unit_amount === "number" ? price.unit_amount / 100 : null,
    status: dbStatus(sub.status),
    current_period_start: iso(item?.current_period_start),
    current_period_end: iso(item?.current_period_end),
    cancel_at_period_end: !!sub.cancel_at_period_end,
    stripe_customer_id: typeof sub.customer === "string" ? sub.customer : (sub.customer?.id ?? null),
    stripe_subscription_id: sub.id,
  };
}

/**
 * Re-read a subscription from Stripe and store it. The user comes from the
 * subscription's metadata (set at checkout), else from the stored customer.
 * A late event for an old subscription never overrides a newer active one.
 */
export async function syncSubscription(stripe: Stripe, subscriptionId: string, userHint?: string | null): Promise<"saved" | "skipped"> {
  const db = serviceSupabase();
  if (!db) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
  let userId = (sub.metadata?.user_id as string | undefined) || userHint || null;
  if (!userId && customerId) {
    const { data } = await db.from("subscriptions").select("user_id").eq("stripe_customer_id", customerId).maybeSingle();
    userId = (data?.user_id as string | undefined) ?? null;
  }
  if (!userId) return "skipped";
  const row = subscriptionRow(sub, userId);
  const { data: current } = await db.from("subscriptions").select("stripe_subscription_id, status").eq("user_id", userId).maybeSingle();
  if (current && current.stripe_subscription_id && current.stripe_subscription_id !== sub.id && ["active", "trialing"].includes(current.status as string) && !["active", "trialing"].includes(row.status)) {
    return "skipped";
  }
  const { error } = await db.from("subscriptions").upsert(row, { onConflict: "user_id" });
  if (error) throw new Error(`Could not save subscription: ${error.message}`);
  return "saved";
}
