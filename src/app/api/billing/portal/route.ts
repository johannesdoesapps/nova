import { NextResponse } from "next/server";
import { billingConfigured, stripeClient } from "@/lib/billing/stripe";
import { requireUser } from "@/lib/auth";
import { publicEnv } from "@/lib/env";
import { ApiError, errorResponse } from "@/lib/http";

/** POST /api/billing/portal — open Stripe's billing portal (change card, see invoices, cancel). */
export async function POST() {
  try {
    const { supabase, user } = await requireUser();
    const stripe = stripeClient();
    if (!stripe || !billingConfigured()) throw new ApiError("not_configured", "Payments aren't set up on this site yet.");
    const { data: sub } = await supabase.from("subscriptions").select("stripe_customer_id").eq("user_id", user.id).maybeSingle();
    const customer = sub?.stripe_customer_id as string | null | undefined;
    if (!customer) throw new ApiError("not_found", "There's no subscription to manage yet.");
    const session = await stripe.billingPortal.sessions.create({ customer, return_url: `${publicEnv.siteUrl.replace(/\/$/, "")}/chat` });
    return NextResponse.json({ url: session.url });
  } catch (err) {
    return errorResponse(err);
  }
}
