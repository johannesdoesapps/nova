import "server-only";
import type Stripe from "stripe";
import { safeMessage } from "../alerts";
import { sendCustomerEmail } from "../email";
import { reportError } from "../observability";
import { resolveBilling, type BillingSettings } from "../plans";
import { serviceSupabase } from "../supabase/admin";
import { stripeClient } from "./stripe";

/**
 * Automatic top-ups of extra usage — opt-in. When a customer's extra-usage balance falls below the level they chose,
 * Orbis charges the card they saved for this, at the pack price, and adds the units; never more in a calendar month
 * than the limit they set. Stripe requires the customer's agreement to these charges (timing, amount, how to stop),
 * so the exact wording they agreed to is stored with the time. Any failure turns automatic top-ups off and tells them.
 *
 * Safety: one pending attempt per person at a time (database index), a Stripe idempotency key per attempt, and
 * credits granted once per PaymentIntent (usage_credit_add records its id), so retries can't charge or grant twice.
 * A top-up only buys prepaid units: plan limits, the per-message cost limit and the site-wide cap still apply.
 */

export interface TopupSettings {
  user_id: string;
  enabled: boolean;
  packs: number;
  below_units: number;
  monthly_cap_usd: number;
  stripe_customer_id: string | null;
  payment_method_id: string | null;
  consent_text: string | null;
  consent_at: string | null;
  disabled_reason: string | null;
}

/** The words a customer agrees to before turning automatic top-ups on (stored with their consent). */
export function topupConsentText(t: { units: number; priceUsd: number; belowUnits: number; monthlyCapUsd: number }): string {
  const usd = (n: number) => `$${n.toFixed(2)}`;
  return `I authorise Orbis to charge my saved card ${usd(t.priceUsd)} (plus any tax) for ${Math.round(t.units).toLocaleString("en-US")} units of extra usage each time my extra-usage balance falls below ${Math.round(t.belowUnits).toLocaleString("en-US")} units, up to ${usd(t.monthlyCapUsd)} per calendar month. I'll get a receipt for every charge, and I can turn this off at any time on the Usage page.`;
}

/** Whether another top-up of `amount` fits under the monthly limit, given what was already charged this month. */
export function fitsMonthlyCap(spentThisMonthUsd: number, amountUsd: number, capUsd: number): boolean {
  return capUsd > 0 && spentThisMonthUsd + amountUsd <= capUsd + 1e-9;
}

async function billingSettings(db: NonNullable<ReturnType<typeof serviceSupabase>>): Promise<BillingSettings> {
  const { data } = await db.from("app_settings").select("settings").eq("id", 1).maybeSingle();
  return resolveBilling((data?.settings as { billing?: unknown } | null)?.billing);
}

/** A paid plan, own or through a team, read with the service role (no user session here). */
async function hasPaidPlan(db: NonNullable<ReturnType<typeof serviceSupabase>>, userId: string): Promise<boolean> {
  const [{ data: own }, { data: m }] = await Promise.all([
    db.from("subscriptions").select("plan, status, disputed").eq("user_id", userId).maybeSingle(),
    db.from("team_members").select("teams(status, disputed)").eq("user_id", userId).maybeSingle(),
  ]);
  if (own && own.plan !== "free" && ["active", "trialing"].includes(own.status as string) && !own.disputed) return true;
  const t = (m as { teams?: { status: string; disputed: boolean } | { status: string; disputed: boolean }[] } | null)?.teams;
  const team = Array.isArray(t) ? t[0] : t;
  return !!team && ["active", "trialing"].includes(team.status) && !team.disputed;
}

/** Turn automatic top-ups off for a reason and tell the customer (once per reason and day). */
async function disable(db: NonNullable<ReturnType<typeof serviceSupabase>>, userId: string, reason: string, emailKey: string): Promise<void> {
  await db
    .from("credit_topup_settings")
    .update({ enabled: false, disabled_reason: reason.slice(0, 300), updated_at: new Date().toISOString() })
    .eq("user_id", userId);
  await sendCustomerEmail(userId, "topup_failed", emailKey, {});
}

/** Add the units for a paid top-up, once (keyed on the PaymentIntent), and mark the attempt succeeded. */
export async function grantTopup(pi: Stripe.PaymentIntent): Promise<boolean> {
  const db = serviceSupabase();
  if (!db) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  const userId = pi.metadata?.user_id;
  const units = Number(pi.metadata?.units);
  if (!userId || !Number.isFinite(units) || units <= 0 || pi.status !== "succeeded") return false;
  const { data: added, error } = await db.rpc("usage_credit_add", { p_user: userId, p_units: units, p_amount_usd: pi.amount / 100, p_session: pi.id });
  if (error) throw new Error(`Could not add top-up credits: ${error.message}`);
  await db
    .from("credit_topups")
    .update({ status: "succeeded", payment_intent_id: pi.id, updated_at: new Date().toISOString() })
    .eq("id", pi.metadata?.topup_id ?? "00000000-0000-0000-0000-000000000000");
  if (added) await sendCustomerEmail(userId, "topup_charged", pi.id, { amountUsd: pi.amount / 100, units });
  return !!added;
}

/** Record a failed top-up (from Stripe's failure event) and turn automatic top-ups off. */
export async function failTopup(pi: Stripe.PaymentIntent): Promise<void> {
  const db = serviceSupabase();
  if (!db) return;
  const userId = pi.metadata?.user_id;
  if (!userId) return;
  const why = pi.last_payment_error?.message ?? "The card was declined.";
  await db
    .from("credit_topups")
    .update({ status: "failed", payment_intent_id: pi.id, error: why.slice(0, 300), updated_at: new Date().toISOString() })
    .eq("id", pi.metadata?.topup_id ?? "00000000-0000-0000-0000-000000000000");
  await disable(db, userId, why, pi.id);
}

/**
 * After extra usage was spent: if this person has automatic top-ups on and their balance is below their level,
 * charge one top-up. Never throws; failures are recorded, turned off and reported.
 */
export async function maybeTopUp(userId: string, now = new Date()): Promise<"charged" | "skipped" | "failed"> {
  const db = serviceSupabase();
  const stripe = stripeClient();
  if (!db || !stripe) return "skipped";
  try {
    const { data: s } = await db.from("credit_topup_settings").select("*").eq("user_id", userId).maybeSingle();
    const settings = s as TopupSettings | null;
    if (!settings?.enabled || !settings.payment_method_id || !settings.stripe_customer_id) return "skipped";
    const { data: c } = await db.from("usage_credits").select("balance").eq("user_id", userId).maybeSingle();
    if (Number(c?.balance ?? 0) >= Number(settings.below_units)) return "skipped";
    const billing = await billingSettings(db);
    if (!(billing.creditPackUnits > 0 && billing.creditPackPriceUsd > 0)) return "skipped";
    if (!(await hasPaidPlan(db, userId))) {
      await disable(db, userId, "Automatic top-ups need a paid plan.", `noplan:${now.toISOString().slice(0, 10)}`);
      return "skipped";
    }
    const units = billing.creditPackUnits * settings.packs;
    const amountUsd = Math.round(billing.creditPackPriceUsd * settings.packs * 100) / 100;
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const { data: spent } = await db.from("credit_topups").select("amount_usd").eq("user_id", userId).eq("status", "succeeded").gte("created_at", month);
    const spentUsd = (spent ?? []).reduce((n, r) => n + Number(r.amount_usd), 0);
    if (!fitsMonthlyCap(spentUsd, amountUsd, Number(settings.monthly_cap_usd))) {
      await sendCustomerEmail(userId, "topup_cap_reached", `cap:${month.slice(0, 7)}`, { amountUsd: Number(settings.monthly_cap_usd) });
      return "skipped";
    }
    // Claim the attempt: the partial unique index allows one pending top-up per person, so a concurrent call stops here.
    const { data: row, error: claimErr } = await db.from("credit_topups").insert({ user_id: userId, units, amount_usd: amountUsd }).select("id").single();
    if (claimErr || !row) return "skipped";
    let pi: Stripe.PaymentIntent;
    try {
      pi = await stripe.paymentIntents.create(
        {
          amount: Math.round(amountUsd * 100),
          currency: "usd",
          customer: settings.stripe_customer_id,
          payment_method: settings.payment_method_id,
          off_session: true,
          confirm: true,
          description: `Orbis extra usage: ${units.toLocaleString("en-US")} units (automatic top-up)`,
          metadata: { kind: "topup", user_id: userId, units: String(units), topup_id: row.id as string },
        },
        { idempotencyKey: `orbis-topup-${row.id}` },
      );
    } catch (err) {
      const why = safeMessage(err);
      await db
        .from("credit_topups")
        .update({ status: "failed", error: why.slice(0, 300), updated_at: new Date().toISOString() })
        .eq("id", row.id);
      await disable(db, userId, why, `fail:${row.id}`);
      return "failed";
    }
    await db.from("credit_topups").update({ payment_intent_id: pi.id, updated_at: new Date().toISOString() }).eq("id", row.id);
    if (pi.status === "succeeded") {
      await grantTopup(pi);
      return "charged";
    }
    // Anything else (e.g. the bank wants the customer to confirm) can't be completed while they're away.
    await db
      .from("credit_topups")
      .update({ status: "failed", error: `Payment ${pi.status}`, updated_at: new Date().toISOString() })
      .eq("id", row.id);
    await disable(db, userId, `The payment needs your confirmation (${pi.status}).`, `fail:${row.id}`);
    return "failed";
  } catch (err) {
    reportError(err, { where: "topup.maybe" });
    return "failed";
  }
}

/** A finished setup Checkout (card saved for top-ups): store the card and turn automatic top-ups on. Idempotent. */
export async function completeTopupSetup(stripe: Stripe, session: Stripe.Checkout.Session): Promise<boolean> {
  if (session.mode !== "setup" || session.metadata?.kind !== "topup_setup" || session.status !== "complete") return false;
  const db = serviceSupabase();
  if (!db) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  const userId = session.metadata.user_id ?? session.client_reference_id;
  const siId = typeof session.setup_intent === "string" ? session.setup_intent : session.setup_intent?.id;
  if (!userId || !siId) return false;
  const si = await stripe.setupIntents.retrieve(siId);
  const pm = typeof si.payment_method === "string" ? si.payment_method : si.payment_method?.id;
  const customer = typeof session.customer === "string" ? session.customer : session.customer?.id;
  if (!pm || !customer) return false;
  const { error } = await db
    .from("credit_topup_settings")
    .update({ enabled: true, payment_method_id: pm, stripe_customer_id: customer, disabled_reason: null, updated_at: new Date().toISOString() })
    .eq("user_id", userId);
  if (error) throw new Error(`Could not turn on automatic top-ups: ${error.message}`);
  return true;
}
