import { NextResponse } from "next/server";
import { eventSeen, invoiceLedger, markEvent, recordLedger, refundLedger, stripeClient, syncSubscription, userForCustomer } from "@/lib/billing/stripe";
import { serverEnv } from "@/lib/env";
import { reportError } from "@/lib/observability";

/**
 * POST /api/stripe/webhook — Stripe's notifications about subscriptions and
 * payments. The signature is verified with STRIPE_WEBHOOK_SECRET; anything
 * else is refused. Each event is handled once (stripe_events); subscription
 * events re-read the subscription from Stripe, so out-of-order delivery is
 * harmless. Paid and failed invoices and refunds go to billing_ledger. A 5xx
 * makes Stripe retry. Paid access comes only from here, never from the
 * checkout success page.
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
    if (await eventSeen(event.id)) return NextResponse.json({ received: true, duplicate: true });
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
      case "invoice.paid":
      case "invoice.payment_failed": {
        const inv = event.data.object;
        const user = await userForCustomer(inv.customer as string | null);
        await recordLedger(invoiceLedger(inv, event.type === "invoice.paid" ? "payment" : "failed_payment", user, event.id));
        // Status changes (active ↔ past_due) arrive as customer.subscription.updated.
        break;
      }
      case "refund.created":
      case "refund.updated": {
        const refund = event.data.object;
        const chargeId = typeof refund.charge === "string" ? refund.charge : refund.charge?.id;
        const charge = chargeId ? await stripe.charges.retrieve(chargeId) : null;
        await recordLedger(refundLedger(refund, await userForCustomer(charge?.customer as string | null)));
        break;
      }
      default:
        break;
    }
    await markEvent(event.id, event.type);
  } catch (err) {
    reportError(err, { where: "stripe.webhook", type: event.type });
    return NextResponse.json({ error: "Could not process the event." }, { status: 500 });
  }
  return NextResponse.json({ received: true });
}
