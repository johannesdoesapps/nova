import { NextResponse } from "next/server";
import { stripeClient, syncSubscription } from "@/lib/billing/stripe";
import { serverEnv } from "@/lib/env";
import { reportError } from "@/lib/observability";

/**
 * POST /api/stripe/webhook — Stripe's notifications about subscriptions. The
 * signature is verified with STRIPE_WEBHOOK_SECRET; anything else is refused.
 * Each event re-reads the subscription from Stripe, so retries and
 * out-of-order delivery are harmless. A 5xx makes Stripe retry.
 */
export async function POST(req: Request) {
  const stripe = stripeClient();
  const secret = serverEnv().stripeWebhookSecret;
  if (!stripe || !secret) return NextResponse.json({ error: "Payments aren't set up." }, { status: 503 });

  const signature = req.headers.get("stripe-signature");
  const body = await req.text();
  let event;
  try {
    if (!signature) throw new Error("missing signature");
    event = stripe.webhooks.constructEvent(body, signature, secret);
  } catch {
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object;
        const subId = typeof s.subscription === "string" ? s.subscription : s.subscription?.id;
        if (s.mode === "subscription" && subId) await syncSubscription(stripe, subId, s.client_reference_id);
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
      case "customer.subscription.paused":
      case "customer.subscription.resumed":
        await syncSubscription(stripe, event.data.object.id);
        break;
      default:
        break;
    }
  } catch (err) {
    reportError(err, { where: "stripe.webhook", type: event.type });
    return NextResponse.json({ error: "Could not process the event." }, { status: 500 });
  }
  return NextResponse.json({ received: true });
}
