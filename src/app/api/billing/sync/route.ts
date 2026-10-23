import { NextResponse } from "next/server";
import { z } from "zod";
import { applyCheckoutSession, billingConfigured, stripeClient } from "@/lib/billing/stripe";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { reportError } from "@/lib/observability";
import { requireUser } from "@/lib/auth";

const body = z.object({ sessionId: z.string().regex(/^cs_[A-Za-z0-9_]{8,200}$/) });

/**
 * POST /api/billing/sync — after Stripe Checkout returns, apply that session for the signed-in user at once
 * (a new plan, or bought extra usage) instead of waiting for the webhook. Everything is re-read from Stripe and
 * the session must belong to the caller; applying it twice changes nothing.
 */
export async function POST(req: Request) {
  try {
    const { sessionId } = await parseJsonBody(req, body, 1_000);
    const { user } = await requireUser();
    const stripe = stripeClient();
    if (!stripe || !billingConfigured()) throw new ApiError("not_configured", "Payments aren't set up on this site yet.");
    let applied: Awaited<ReturnType<typeof applyCheckoutSession>>;
    try {
      applied = await applyCheckoutSession(stripe, sessionId, user.id);
    } catch (err) {
      reportError(err, { where: "billing.sync" });
      throw new ApiError("not_found", "That checkout couldn't be confirmed for this account. If you were charged, your plan will appear within a few minutes.");
    }
    return NextResponse.json({ applied });
  } catch (err) {
    return errorResponse(err);
  }
}
