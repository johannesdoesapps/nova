import { NextResponse } from "next/server";
import { z } from "zod";
import { billingConfigured, planPriceId, stripeClient } from "@/lib/billing/stripe";
import { requireUser } from "@/lib/auth";
import { getBilling } from "@/lib/entitlements";
import { publicEnv } from "@/lib/env";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";

const body = z.object({ plan: z.enum(["pro", "max"]).default("pro"), interval: z.enum(["month", "year"]).default("month") });

/** POST /api/billing/checkout — start a Stripe Checkout for Pro or Max, monthly or yearly (USD); returns the hosted page's URL. */
export async function POST(req: Request) {
  try {
    const { plan, interval } = await parseJsonBody(req, body, 1_000);
    const { supabase, user } = await requireUser();
    const stripe = stripeClient();
    if (!stripe || !billingConfigured()) throw new ApiError("not_configured", "Payments aren't set up on this site yet.");
    const { data: sub } = await supabase.from("subscriptions").select("*").eq("user_id", user.id).maybeSingle();
    if (sub && (sub.plan === "pro" || sub.plan === "max") && ["active", "trialing", "past_due"].includes(sub.status as string)) {
      throw new ApiError("conflict", "You already have a subscription. Change your plan from Settings → Plan, or use “Manage subscription”.", { currentPlan: sub.plan });
    }
    const site = publicEnv.siteUrl.replace(/\/$/, "");
    const customer = (sub?.stripe_customer_id as string | null) ?? undefined;
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: await planPriceId(stripe, await getBilling(), plan, interval), quantity: 1 }],
      ...(customer ? { customer } : { customer_email: user.email ?? undefined }),
      client_reference_id: user.id,
      metadata: { user_id: user.id },
      subscription_data: { metadata: { user_id: user.id, orbis_plan: plan } },
      allow_promotion_codes: true,
      success_url: `${site}/chat?upgraded=${plan}`,
      cancel_url: `${site}/pricing`,
    });
    if (!session.url) throw new ApiError("upstream_error", "Stripe didn't return a checkout page.");
    return NextResponse.json({ url: session.url });
  } catch (err) {
    return errorResponse(err);
  }
}
