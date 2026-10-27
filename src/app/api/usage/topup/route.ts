import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { billingConfigured, createCheckoutSession, stripeClient } from "@/lib/billing/stripe";
import { topupConsentText } from "@/lib/billing/topup";
import { entitlementFor } from "@/lib/entitlements";
import { publicEnv } from "@/lib/env";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { serviceSupabase } from "@/lib/supabase/admin";
import { creditsForSale } from "@/lib/usage";

/**
 * Automatic top-ups of extra usage (opt-in, paid plans):
 * GET — current settings, this month's top-ups and the pack on sale.
 * POST — agree to the stated charges and turn top-ups on; if no card is saved for them yet, returns a Stripe page
 *        to save one (they switch on once Stripe confirms the card).
 * DELETE — turn them off.
 */

async function context() {
  const auth = await requireUser();
  const entitlement = await entitlementFor(auth);
  const billing = entitlement?.billing;
  const paid = entitlement?.kind === "plan" && entitlement.plan !== "free";
  const pack = billing && creditsForSale(billing, billingConfigured()) ? { units: billing.creditPackUnits, priceUsd: billing.creditPackPriceUsd } : null;
  return { auth, paid, pack };
}

export async function GET() {
  try {
    const { auth, paid, pack } = await context();
    const month = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
    const [{ data: s }, { data: rows }] = await Promise.all([
      auth.supabase.from("credit_topup_settings").select("enabled, packs, below_units, monthly_cap_usd, payment_method_id, disabled_reason").eq("user_id", auth.user.id).maybeSingle(),
      auth.supabase.from("credit_topups").select("amount_usd, status, created_at").eq("user_id", auth.user.id).gte("created_at", month).order("created_at", { ascending: false }).limit(20),
    ]);
    const spentUsd = (rows ?? []).filter((r) => r.status === "succeeded").reduce((n, r) => n + Number(r.amount_usd), 0);
    return NextResponse.json(
      {
        available: paid && !!pack,
        pack,
        settings: s
          ? { enabled: !!s.enabled, packs: s.packs, belowUnits: Number(s.below_units), monthlyCapUsd: Number(s.monthly_cap_usd), cardSaved: !!s.payment_method_id, disabledReason: s.disabled_reason }
          : null,
        thisMonth: { spentUsd: Math.round(spentUsd * 100) / 100, count: (rows ?? []).filter((r) => r.status === "succeeded").length },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err);
  }
}

const turnOn = z.object({ packs: z.number().int().min(1).max(10), belowUnits: z.number().min(0).max(1_000_000), monthlyCapUsd: z.number().min(1).max(5_000), consent: z.literal(true) });

export async function POST(req: Request) {
  try {
    const body = await parseJsonBody(req, turnOn, 1_000);
    const { auth, paid, pack } = await context();
    if (!paid) throw new ApiError("forbidden", "Automatic top-ups are for paid plans.");
    const stripe = stripeClient();
    const db = serviceSupabase();
    if (!pack || !stripe || !db) throw new ApiError("not_configured", "Extra usage isn't on sale yet.");
    const priceUsd = Math.round(pack.priceUsd * body.packs * 100) / 100;
    if (body.monthlyCapUsd < priceUsd) throw new ApiError("bad_request", `The monthly limit must be at least one top-up ($${priceUsd.toFixed(2)}).`);
    const consent = topupConsentText({ units: pack.units * body.packs, priceUsd, belowUnits: body.belowUnits, monthlyCapUsd: body.monthlyCapUsd });
    const { data: existing } = await db.from("credit_topup_settings").select("payment_method_id, stripe_customer_id").eq("user_id", auth.user.id).maybeSingle();
    const cardSaved = !!existing?.payment_method_id;
    const { error } = await db
      .from("credit_topup_settings")
      .upsert(
        {
          user_id: auth.user.id,
          enabled: cardSaved,
          packs: body.packs,
          below_units: body.belowUnits,
          monthly_cap_usd: body.monthlyCapUsd,
          consent_text: consent,
          consent_at: new Date().toISOString(),
          disabled_reason: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      );
    if (error) throw new ApiError("internal", "Your settings couldn't be saved. Try again.");
    if (cardSaved) return NextResponse.json({ enabled: true });

    // Save a card for these charges on Stripe's page. The Stripe customer is the one from the subscription, if any.
    const { data: sub } = await auth.supabase.from("subscriptions").select("stripe_customer_id").eq("user_id", auth.user.id).maybeSingle();
    let customer = (existing?.stripe_customer_id as string | null) ?? (sub?.stripe_customer_id as string | null) ?? null;
    if (!customer) customer = (await stripe.customers.create({ email: auth.user.email ?? undefined, metadata: { user_id: auth.user.id } })).id;
    const site = publicEnv.siteUrl.replace(/\/$/, "");
    const session = await createCheckoutSession(stripe, {
      mode: "setup",
      currency: "usd",
      customer,
      client_reference_id: auth.user.id,
      metadata: { kind: "topup_setup", user_id: auth.user.id },
      setup_intent_data: { metadata: { kind: "topup_setup", user_id: auth.user.id }, description: consent.slice(0, 500) },
      success_url: `${site}/usage?topup=on&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${site}/usage`,
    });
    if (!session.url) throw new ApiError("upstream_error", "Stripe didn't return a page to save your card.");
    return NextResponse.json({ url: session.url });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE() {
  try {
    const { auth } = await context();
    const db = serviceSupabase();
    if (!db) throw new ApiError("not_configured", "Automatic top-ups aren't available on this site yet.");
    const { error } = await db.from("credit_topup_settings").update({ enabled: false, disabled_reason: "Turned off by you.", updated_at: new Date().toISOString() }).eq("user_id", auth.user.id);
    if (error) throw new ApiError("internal", "Automatic top-ups couldn't be turned off. Try again.");
    return NextResponse.json({ enabled: false });
  } catch (err) {
    return errorResponse(err);
  }
}
