import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { billingConfigured, stripeClient } from "@/lib/billing/stripe";
import { publicEnv } from "@/lib/env";
import { ApiError, errorResponse } from "@/lib/http";
import { myTeam } from "@/lib/team";

/** POST /api/team/portal — Stripe's billing portal for the team's subscription (owner): card, invoices, cancel. */
export async function POST() {
  try {
    const { supabase, user } = await requireUser();
    const stripe = stripeClient();
    if (!stripe || !billingConfigured()) throw new ApiError("not_configured", "Payments aren't set up on this site yet.");
    const team = await myTeam(supabase, user.id);
    if (!team || team.owner_id !== user.id || !team.stripe_customer_id) throw new ApiError("forbidden", "Only the team owner can manage the team's billing.");
    const session = await stripe.billingPortal.sessions.create({ customer: team.stripe_customer_id, return_url: `${publicEnv.siteUrl.replace(/\/$/, "")}/team` });
    return NextResponse.json({ url: session.url });
  } catch (err) {
    return errorResponse(err);
  }
}
