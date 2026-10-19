import { NextResponse } from "next/server";
import { billingConfigured, proPriceId, stripeClient } from "@/lib/billing/stripe";
import { requireUser } from "@/lib/auth";
import { publicEnv } from "@/lib/env";
import { ApiError, errorResponse } from "@/lib/http";

/** POST /api/billing/checkout — start a Stripe Checkout for Pro; returns the hosted page's URL. */
export async function POST() {
  try {
    const { supabase, user } = await requireUser();
    const stripe = stripeClient();
    if (!stripe || !billingConfigured()) throw new ApiError("not_configured", "Payments aren't set up on this site yet.");
    const { data: sub } = await supabase.from("subscriptions").select("*").eq("user_id", user.id).maybeSingle();
    if (sub && sub.plan === "pro" && ["active", "trialing", "past_due"].includes(sub.status as string)) {
      throw new ApiError("conflict", "You already have Pro. Use “Manage subscription” to change or cancel it.");
    }
    const site = publicEnv.siteUrl.replace(/\/$/, "");
    const customer = (sub?.stripe_customer_id as string | null) ?? undefined;
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: await proPriceId(stripe), quantity: 1 }],
      ...(customer ? { customer } : { customer_email: user.email ?? undefined }),
      client_reference_id: user.id,
      metadata: { user_id: user.id },
      subscription_data: { metadata: { user_id: user.id, nova_plan: "pro" } },
      allow_promotion_codes: true,
      success_url: `${site}/chat?upgraded=1`,
      cancel_url: `${site}/pricing`,
    });
    if (!session.url) throw new ApiError("upstream_error", "Stripe didn't return a checkout page.");
    return NextResponse.json({ url: session.url });
  } catch (err) {
    return errorResponse(err);
  }
}
