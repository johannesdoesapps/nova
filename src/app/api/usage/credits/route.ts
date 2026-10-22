import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { billingConfigured, stripeClient } from "@/lib/billing/stripe";
import { entitlementFor } from "@/lib/entitlements";
import { publicEnv } from "@/lib/env";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { creditsForSale } from "@/lib/usage";

/**
 * Extra usage (credits) on paid plans, like Claude's usage credits:
 * GET — the pack on sale (if any) and whether this account can buy it.
 * POST — start a Stripe Checkout for 1–10 packs; credits are added only by the
 *        payment webhook, never by this request or the success page.
 * PATCH — turn "use extra usage automatically" on or off.
 */

async function offer() {
  const auth = await requireUser();
  const entitlement = await entitlementFor(auth);
  const billing = entitlement?.billing;
  const paid = entitlement?.kind === "plan" && entitlement.plan !== "free";
  const forSale = !!billing && creditsForSale(billing, billingConfigured());
  return { auth, paid, forSale, pack: forSale ? { units: billing!.creditPackUnits, priceUsd: billing!.creditPackPriceUsd } : null };
}

export async function GET() {
  try {
    const { paid, forSale, pack } = await offer();
    return NextResponse.json({ available: paid && forSale, paidPlan: paid, pack }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}

const buy = z.object({ packs: z.number().int().min(1).max(10).default(1) });

export async function POST(req: Request) {
  try {
    const { packs } = await parseJsonBody(req, buy, 1_000);
    const { auth, paid, pack } = await offer();
    if (!paid) throw new ApiError("forbidden", "Extra usage is for Pro and Max plans.");
    const stripe = stripeClient();
    if (!pack || !stripe) throw new ApiError("not_configured", "Extra usage isn't on sale yet.");
    const units = pack.units * packs;
    const site = publicEnv.siteUrl.replace(/\/$/, "");
    const { data: sub } = await auth.supabase.from("subscriptions").select("stripe_customer_id").eq("user_id", auth.user.id).maybeSingle();
    const customer = (sub?.stripe_customer_id as string | null) ?? undefined;
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        { quantity: packs, price_data: { currency: "usd", unit_amount: Math.round(pack.priceUsd * 100), product_data: { name: `Orbis extra usage: ${pack.units.toLocaleString("en-US")} units` } } },
      ],
      ...(customer ? { customer } : { customer_email: auth.user.email ?? undefined }),
      client_reference_id: auth.user.id,
      metadata: { kind: "credits", user_id: auth.user.id, units: String(units) },
      payment_intent_data: { metadata: { kind: "credits", user_id: auth.user.id, units: String(units) } },
      success_url: `${site}/usage?credits=bought`,
      cancel_url: `${site}/usage`,
    });
    if (!session.url) throw new ApiError("upstream_error", "Stripe didn't return a checkout page.");
    return NextResponse.json({ url: session.url });
  } catch (err) {
    return errorResponse(err);
  }
}

const auto = z.object({ auto: z.boolean() });

export async function PATCH(req: Request) {
  try {
    const { auto: on } = await parseJsonBody(req, auto, 200);
    const auth = await requireUser();
    const { error } = await auth.supabase.rpc("usage_credits_set_auto", { p_on: on });
    if (error) throw new ApiError("internal", "That setting couldn't be saved. Please try again.");
    return NextResponse.json({ auto: on });
  } catch (err) {
    return errorResponse(err);
  }
}
