import { NextResponse } from "next/server";
import { alertOwner } from "@/lib/alerts";
import { addCredits, eventSeen, graceInfo, invoiceLedger, markEvent, recordDispute, recordLedger, refundLedger, stripeClient, syncSubscription, userForCustomer } from "@/lib/billing/stripe";
import { sendCustomerEmail } from "@/lib/email";
import { serverEnv } from "@/lib/env";
import { reportError } from "@/lib/observability";

/**
 * POST /api/stripe/webhook — Stripe's notifications about subscriptions and
 * payments. The signature is verified with STRIPE_WEBHOOK_SECRET; anything
 * else is refused. Each event is handled once (stripe_events); subscription
 * events re-read the subscription from Stripe, so out-of-order delivery is
 * harmless. Paid and failed invoices and refunds go to billing_ledger. A 5xx
 * makes Stripe retry. Paid access comes from here, or from the checkout return
 * page re-reading the same session from Stripe (applyCheckoutSession).
 * Disputes pause paid access until settled. Customer emails (welcome, payment
 * failed, bank confirmation needed) are sent once each (notifications table).
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
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const s = event.data.object;
        const subId = typeof s.subscription === "string" ? s.subscription : s.subscription?.id;
        if (s.mode === "subscription" && subId) {
          await syncSubscription(stripe, subId, s.client_reference_id);
          const user = s.client_reference_id ?? (s.metadata?.user_id as string | undefined);
          if (user) await sendCustomerEmail(user, "welcome", subId, { plan: (await graceInfo(user)).plan });
        }
        // Extra usage: added once the payment has gone through (each session counts once).
        if (s.mode === "payment" && s.metadata?.kind === "credits" && s.payment_status === "paid") await addCredits(s);
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
        if (event.type === "invoice.payment_failed" && user && inv.id) await sendCustomerEmail(user, "payment_failed", inv.id, await graceInfo(user));
        break;
      }
      case "invoice.payment_action_required": {
        const inv = event.data.object;
        const user = await userForCustomer(inv.customer as string | null);
        if (user && inv.id) await sendCustomerEmail(user, "payment_action_required", inv.id, { plan: (await graceInfo(user)).plan, url: inv.hosted_invoice_url ?? null });
        break;
      }
      case "charge.dispute.created":
      case "charge.dispute.updated":
      case "charge.dispute.closed": {
        const d = event.data.object;
        const { userId, disputed } = await recordDispute(stripe, d);
        if (event.type === "charge.dispute.created") {
          alertOwner(
            `dispute:${d.id}`,
            `Orbis: a customer disputed a $${(d.amount / 100).toFixed(2)} charge`,
            `A charge was disputed (reason: ${d.reason ?? "not given"}). ${userId ? "That customer's paid access is paused until the dispute is settled." : "No Orbis account was found for it."}\n\nRespond in Stripe → Payments → Disputes before the deadline Stripe shows.`,
          );
        }
        if (event.type === "charge.dispute.closed")
          alertOwner(
            `dispute-closed:${d.id}`,
            `Orbis: dispute ${d.status}`,
            `A dispute closed as "${d.status}". ${disputed ? "The customer's paid access stays paused." : "The customer's paid access is restored."}`,
          );
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
