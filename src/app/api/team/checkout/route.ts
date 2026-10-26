import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { billingConfigured, planPriceId, stripeClient, checkoutIdempotencyKey } from "@/lib/billing/stripe";
import { getBilling } from "@/lib/entitlements";
import { publicEnv } from "@/lib/env";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { myTeam, TEAM_MAX_SEATS, TEAM_MIN_SEATS, teamErrorMessage } from "@/lib/team";

const body = z.object({
  name: z.string().trim().min(1).max(80),
  plan: z.enum(["pro", "max"]).default("pro"),
  interval: z.enum(["month", "year"]).default("month"),
  seats: z.number().int().min(TEAM_MIN_SEATS).max(TEAM_MAX_SEATS),
});

/**
 * POST /api/team/checkout — start a team: create it (the caller is the owner and takes a seat), then open Stripe
 * Checkout for that many seats of Pro or Max. The team only gives anyone a plan once Stripe confirms payment.
 */
export async function POST(req: Request) {
  try {
    const { name, plan, interval, seats } = await parseJsonBody(req, body, 1_000);
    const { supabase, user } = await requireUser();
    const stripe = stripeClient();
    if (!stripe || !billingConfigured()) throw new ApiError("not_configured", "Payments aren't set up on this site yet.");
    const { data: own } = await supabase.from("subscriptions").select("plan, status").eq("user_id", user.id).maybeSingle();
    if (own && ["active", "trialing", "past_due"].includes(own.status as string) && own.plan !== "free") {
      throw new ApiError("conflict", "You have a personal paid plan. Cancel it first (Usage → Manage subscription) so you don't pay twice; your team seat gives you the same plan.");
    }
    const existing = await myTeam(supabase, user.id);
    if (existing && ["active", "trialing", "past_due"].includes(existing.status)) throw new ApiError("conflict", "You're already in a team with an active plan.");
    const { data: teamId, error } = await supabase.rpc("team_create", { p_name: name, p_plan: plan, p_interval: interval });
    if (error || !teamId) throw new ApiError("conflict", teamErrorMessage(error, "The team couldn't be created."));
    const site = publicEnv.siteUrl.replace(/\/$/, "");
    const meta = { kind: "team", team_id: teamId as string, owner_id: user.id, orbis_plan: plan };
    const price = await planPriceId(stripe, await getBilling(), plan, interval);
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price, quantity: seats }],
      ...(existing?.stripe_customer_id ? { customer: existing.stripe_customer_id } : { customer_email: user.email ?? undefined }),
      client_reference_id: user.id,
      metadata: meta,
      subscription_data: { metadata: meta },
      allow_promotion_codes: true,
      success_url: `${site}/team?created=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${site}/team`,
    }, { idempotencyKey: checkoutIdempotencyKey([user.id, teamId as string, plan, interval, seats, price]) });
    if (!session.url) throw new ApiError("upstream_error", "Stripe didn't return a checkout page.");
    return NextResponse.json({ url: session.url });
  } catch (err) {
    return errorResponse(err);
  }
}
