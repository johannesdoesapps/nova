import "server-only";
import Stripe from "stripe";
import { serverEnv } from "../env";
import { chargeUsd, planOf, resolveBilling, type BillingInterval, type BillingSettings } from "../plans";
import { serviceSupabase } from "../supabase/admin";

/**
 * Pro subscriptions through Stripe. Checkout and the billing portal run on
 * Stripe's hosted pages, so card details never touch Orbis. The webhook is the
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
  client ??= new Stripe(key, { appInfo: { name: "Orbis" } });
  return client;
}

export type PaidPlan = "pro" | "max";

/** Identifies an Orbis price in Stripe; includes the amount, so a price change creates a new price. */
export const priceLookupKey = (plan: PaidPlan, interval: BillingInterval, cents: number) => `orbis_${plan}_${interval}_usd_${cents}`;

/** Parse a lookup key back into plan and interval. */
export function parseLookupKey(key: string | null | undefined): { plan: PaidPlan; interval: BillingInterval } | null {
  const m = key?.match(/^orbis_(pro|max)_(month|year)_usd_\d+$/);
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
    metadata: { orbis_plan: plan, orbis_interval: interval },
    product_data: { name: `Orbis ${p.label}` },
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
  const metaPlan = (price?.metadata?.orbis_plan ?? sub.metadata?.orbis_plan) as string | undefined;
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
  if (sub.metadata?.kind === "team") return syncTeamSubscription(sub);
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

/** The Orbis user for a Stripe customer, from the stored subscription (for a team, its owner). */
export async function userForCustomer(customer: string | { id: string } | null | undefined): Promise<string | null> {
  const id = typeof customer === "string" ? customer : customer?.id;
  const db = serviceSupabase();
  if (!id || !db) return null;
  const { data } = await db.from("subscriptions").select("user_id").eq("stripe_customer_id", id).maybeSingle();
  if (data?.user_id) return data.user_id as string;
  const { data: team } = await db.from("teams").select("owner_id").eq("stripe_customer_id", id).limit(1).maybeSingle();
  return (team?.owner_id as string | undefined) ?? null;
}

/**
 * Store a team subscription on its team row: the plan, seats (the subscription's quantity), status and
 * billing period. The team comes from the subscription's metadata, set at checkout. Idempotent.
 */
export async function syncTeamSubscription(sub: Stripe.Subscription): Promise<"saved" | "skipped"> {
  const db = serviceSupabase();
  if (!db) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  const teamId = sub.metadata?.team_id as string | undefined;
  if (!teamId) return "skipped";
  const base = subscriptionRow(sub, sub.metadata?.owner_id as string);
  const item = sub.items?.data?.[0];
  const { error } = await db
    .from("teams")
    .update({
      plan: base.plan,
      billing_interval: base.billing_interval,
      seats: item?.quantity ?? 0,
      status: base.status,
      price_usd: base.price_usd,
      current_period_start: base.current_period_start,
      current_period_end: base.current_period_end,
      cancel_at_period_end: base.cancel_at_period_end,
      stripe_customer_id: base.stripe_customer_id,
      stripe_subscription_id: sub.id,
    })
    .eq("id", teamId);
  if (error) throw new Error(`Could not save team subscription: ${error.message}`);
  return "saved";
}

export interface LedgerEntry {
  stripe_object_id: string;
  user_id: string | null;
  kind: "payment" | "refund" | "failed_payment";
  plan: string | null;
  amount_usd: number;
  tax_usd: number;
  occurred_at: string;
}

/** Money collected (excluding tax), refunds and failed payments from a paid/failed invoice or a refund. Null when not relevant. */
export function invoiceLedger(invoice: Stripe.Invoice, kind: "payment" | "failed_payment", userId: string | null, eventId: string): LedgerEntry | null {
  if ((invoice.currency ?? "usd").toLowerCase() !== "usd") return null;
  const tax = (invoice.total_taxes ?? []).reduce((t, x) => t + (x.amount ?? 0), 0) / 100;
  const meta = invoice.parent?.subscription_details?.metadata ?? {};
  const plan = (meta.orbis_plan as string | undefined) ?? null;
  if (kind === "payment") {
    if (!invoice.amount_paid) return null;
    return { stripe_object_id: invoice.id!, user_id: userId ?? (meta.user_id as string | undefined) ?? null, kind, plan, amount_usd: Math.round((invoice.amount_paid / 100 - tax) * 100) / 100, tax_usd: tax, occurred_at: new Date((invoice.status_transitions?.paid_at ?? invoice.created) * 1000).toISOString() };
  }
  // Every failed attempt is its own entry.
  return { stripe_object_id: `failed:${eventId}`, user_id: userId ?? (meta.user_id as string | undefined) ?? null, kind, plan, amount_usd: invoice.amount_due / 100, tax_usd: tax, occurred_at: new Date().toISOString() };
}

export function refundLedger(refund: Stripe.Refund, userId: string | null): LedgerEntry | null {
  if ((refund.currency ?? "usd").toLowerCase() !== "usd" || refund.status === "failed" || refund.status === "canceled") return null;
  return { stripe_object_id: refund.id, user_id: userId, kind: "refund", plan: null, amount_usd: refund.amount / 100, tax_usd: 0, occurred_at: new Date(refund.created * 1000).toISOString() };
}

/** Store a ledger entry once (Stripe's object id is unique). */
export async function recordLedger(entry: LedgerEntry | null): Promise<void> {
  if (!entry) return;
  const db = serviceSupabase();
  if (!db) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  const { error } = await db.from("billing_ledger").upsert(entry, { onConflict: "stripe_object_id", ignoreDuplicates: true });
  if (error) throw new Error(`Could not record billing entry: ${error.message}`);
}

/** Whether a webhook event was already handled; mark it after handling. */
export async function eventSeen(id: string): Promise<boolean> {
  const db = serviceSupabase();
  if (!db) return false;
  const { data } = await db.from("stripe_events").select("id").eq("id", id).maybeSingle();
  return !!data;
}
export async function markEvent(id: string, type: string): Promise<void> {
  const db = serviceSupabase();
  if (!db) return;
  const { error } = await db.from("stripe_events").upsert({ id, type }, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw new Error(`Could not record event: ${error.message}`);
}

/** Add bought extra usage for a paid Checkout session. Idempotent: the session id is recorded once. */
export async function addCredits(session: Stripe.Checkout.Session): Promise<void> {
  const userId = session.metadata?.user_id ?? session.client_reference_id;
  const units = Number(session.metadata?.units);
  if (!userId || !Number.isFinite(units) || units <= 0) throw new Error(`Credit purchase ${session.id} has no user or units`);
  const db = serviceSupabase();
  if (!db) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  const { error } = await db.rpc("usage_credit_add", { p_user: userId, p_units: units, p_amount_usd: (session.amount_total ?? 0) / 100, p_session: session.id });
  if (error) throw new Error(`Could not add credits: ${error.message}`);
}

/** Dispute statuses after which the customer keeps no claim on the money: Orbis won, or the inquiry closed. */
const DISPUTE_SETTLED_FOR_US = new Set(["won", "warning_closed"]);

/**
 * Record a dispute (chargeback) and pause or restore paid access: while a charge is disputed the user's
 * subscription gives no paid plan (see paidStatus), so unpaid usage can't keep running. Idempotent.
 */
export async function recordDispute(stripe: Stripe, dispute: Stripe.Dispute): Promise<{ userId: string | null; disputed: boolean }> {
  const db = serviceSupabase();
  if (!db) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  const chargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id;
  const charge = chargeId ? await stripe.charges.retrieve(chargeId) : null;
  const userId = await userForCustomer(charge?.customer as string | null);
  const disputed = !DISPUTE_SETTLED_FOR_US.has(dispute.status);
  const { error } = await db.from("billing_disputes").upsert(
    { id: dispute.id, user_id: userId, charge_id: chargeId ?? null, amount_usd: (dispute.amount ?? 0) / 100, reason: dispute.reason ?? null, status: dispute.status, updated_at: new Date().toISOString() },
    { onConflict: "id" },
  );
  if (error) throw new Error(`Could not record dispute: ${error.message}`);
  if (userId) {
    // Any other open dispute for this user keeps access paused.
    const { data: open } = await db.from("billing_disputes").select("id, status").eq("user_id", userId);
    const stillOpen = (open ?? []).some((d) => d.id !== dispute.id && !DISPUTE_SETTLED_FOR_US.has(d.status as string));
    const { error: e2 } = await db.from("subscriptions").update({ disputed: disputed || stillOpen }).eq("user_id", userId);
    if (e2) throw new Error(`Could not update subscription: ${e2.message}`);
    const customer = charge?.customer ? (typeof charge.customer === "string" ? charge.customer : charge.customer.id) : null;
    if (customer) await db.from("teams").update({ disputed: disputed || stillOpen }).eq("stripe_customer_id", customer);
  }
  return { userId, disputed };
}

/** Grace days and plan label for emails, read with the service role (the webhook has no user session). */
export async function graceInfo(userId: string): Promise<{ plan: string; graceUntil: number | null }> {
  const db = serviceSupabase();
  if (!db) return { plan: "Orbis", graceUntil: null };
  const [{ data: sub }, { data: settings }] = await Promise.all([
    db.from("subscriptions").select("plan, current_period_start").eq("user_id", userId).maybeSingle(),
    db.from("app_settings").select("settings").eq("id", 1).maybeSingle(),
  ]);
  const billing = resolveBilling((settings?.settings as { billing?: unknown } | null)?.billing);
  const plan = sub?.plan === "max" || sub?.plan === "pro" ? billing.plans[sub.plan as "pro" | "max"].label : "Orbis";
  const start = sub?.current_period_start ? Date.parse(sub.current_period_start as string) : null;
  return { plan, graceUntil: start !== null && billing.paymentGraceDays > 0 ? start + billing.paymentGraceDays * 86_400_000 : null };
}

/**
 * Apply a finished Checkout Session for its own user right away (the return page calls this), so a new plan or
 * bought extra usage shows without waiting for the webhook. Reads everything from Stripe; the webhook does the same
 * later and nothing is applied twice.
 */
export async function applyCheckoutSession(stripe: Stripe, sessionId: string, userId: string): Promise<"subscription" | "credits" | "topup" | "pending"> {
  const s = await stripe.checkout.sessions.retrieve(sessionId);
  const owner = s.client_reference_id ?? s.metadata?.user_id ?? null;
  if (owner !== userId) throw new Error("This checkout belongs to another account.");
  const subId = typeof s.subscription === "string" ? s.subscription : s.subscription?.id;
  if (s.mode === "subscription" && subId && s.status === "complete") {
    await syncSubscription(stripe, subId, userId);
    return "subscription";
  }
  if (s.mode === "payment" && s.metadata?.kind === "credits" && s.payment_status === "paid") {
    await addCredits(s);
    return "credits";
  }
  if (s.mode === "setup" && s.metadata?.kind === "topup_setup") {
    const { completeTopupSetup } = await import("./topup");
    return (await completeTopupSetup(stripe, s)) ? "topup" : "pending";
  }
  return "pending";
}
