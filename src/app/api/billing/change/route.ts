import { NextResponse } from "next/server";
import { z } from "zod";
import { billingConfigured, planPriceId, stripeClient, syncSubscription } from "@/lib/billing/stripe";
import { requireUser } from "@/lib/auth";
import { getBilling } from "@/lib/entitlements";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { reportError } from "@/lib/observability";
import { chargeUsd, planOf } from "@/lib/plans";

const body = z.object({ plan: z.enum(["free", "pro", "max"]), interval: z.enum(["month", "year"]).default("month") });

/**
 * POST /api/billing/change — switch an existing subscription between Pro and
 * Max, monthly and yearly, or back to Free. Upgrades are charged now (pro-rated);
 * downgrades are credited pro-rata; Free takes effect at the end of the paid
 * period. Stripe confirms the change through the webhook, which updates the
 * allowance; it's also applied right away here.
 */
export async function POST(req: Request) {
  try {
    const { plan, interval } = await parseJsonBody(req, body, 1_000);
    const { supabase, user } = await requireUser();
    const stripe = stripeClient();
    if (!stripe || !billingConfigured()) throw new ApiError("not_configured", "Payments aren't set up on this site yet.");
    const { data: sub } = await supabase.from("subscriptions").select("*").eq("user_id", user.id).maybeSingle();
    const subId = sub?.stripe_subscription_id as string | undefined;
    if (!subId || !["active", "trialing", "past_due"].includes(sub?.status as string)) {
      if (plan === "free") throw new ApiError("conflict", "You're already on the Free plan.");
      throw new ApiError("not_found", "There's no subscription to change. Choose a plan on the pricing page to subscribe.");
    }

    if (plan === "free") {
      await stripe.subscriptions.update(subId, { cancel_at_period_end: true });
      await syncSubscription(stripe, subId, user.id).catch((e) => reportError(e, { where: "billing.change.sync" }));
      return NextResponse.json({ ok: true, message: "Your subscription ends at the end of this billing period; you'll then be on Free." });
    }

    const billing = await getBilling();
    const current = await stripe.subscriptions.retrieve(subId);
    const item = current.items.data[0];
    if (!item) throw new ApiError("internal", "The subscription has no billable item.");
    const price = await planPriceId(stripe, billing, plan, interval);
    if (item.price.id === price && !current.cancel_at_period_end) throw new ApiError("conflict", "You're already on that plan.");

    const monthlyNow = (Number(sub?.price_usd ?? 0) || 0) / (sub?.billing_interval === "year" ? 12 : 1);
    const monthlyNew = chargeUsd(planOf(billing, plan), interval) / (interval === "year" ? 12 : 1);
    const upgrade = monthlyNew > monthlyNow;
    const label = planOf(billing, plan).label;
    if (upgrade) {
      // The upgrade takes effect only once its pro-rated invoice is paid (Stripe keeps it pending otherwise).
      const updated = await stripe.subscriptions.update(subId, {
        items: [{ id: item.id, price }],
        proration_behavior: "always_invoice",
        payment_behavior: "pending_if_incomplete",
      });
      if (updated.pending_update) {
        await syncSubscription(stripe, subId, user.id).catch((e) => reportError(e, { where: "billing.change.sync" }));
        throw new ApiError("payment_required", `The payment for ${label} didn't go through, so your plan hasn't changed. Update your card under "Manage subscription" and try again.`);
      }
      await stripe.subscriptions.update(subId, { cancel_at_period_end: false, metadata: { ...current.metadata, user_id: user.id, orbis_plan: plan } });
    } else {
      await stripe.subscriptions.update(subId, {
        items: [{ id: item.id, price }],
        proration_behavior: "create_prorations",
        cancel_at_period_end: false,
        metadata: { ...current.metadata, user_id: user.id, orbis_plan: plan },
      });
    }
    await syncSubscription(stripe, subId, user.id).catch((e) => reportError(e, { where: "billing.change.sync" }));
    return NextResponse.json({ ok: true, message: upgrade ? `You're now on ${label}. The difference was charged pro-rata.` : `You're now on ${label}. The unused part of your previous plan is credited to your next invoice.` });
  } catch (err) {
    return errorResponse(err);
  }
}
