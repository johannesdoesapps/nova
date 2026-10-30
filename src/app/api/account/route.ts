import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { deleteAccount, deletionBlockers, type StripeSubscriptions } from "@/lib/account-deletion";
import { requireUser } from "@/lib/auth";
import { stripeClient } from "@/lib/billing/stripe";
import { discardWorkspace } from "@/lib/code/server";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { siteHost } from "@/lib/publish/sites";
import { publishConfig, VercelHost } from "@/lib/publish/vercel";
import { limiter } from "@/lib/rate-limit";
import { cookiesToClear } from "@/lib/sign-out";
import { serviceSupabase } from "@/lib/supabase/admin";

export const maxDuration = 120;

/** The customer's subscriptions at Stripe, where billing is set up. */
function stripeSubscriptions(): StripeSubscriptions | null {
  const stripe = stripeClient();
  if (!stripe) return null;
  return async (customer) => (await stripe.subscriptions.list({ customer, status: "all", limit: 20 })).data.map((s) => ({ id: s.id, status: s.status, cancel_at_period_end: s.cancel_at_period_end }));
}

/** GET /api/account — whether the account can be deleted now, and if not, why. */
export async function GET() {
  try {
    const auth = await requireUser();
    const blockers = await deletionBlockers(auth.supabase, auth.user.id, stripeSubscriptions());
    return NextResponse.json({ canDelete: blockers.length === 0, blockers });
  } catch (err) {
    return errorResponse(err);
  }
}

const deleteBody = z.object({ confirmEmail: z.string().max(320) });

/**
 * DELETE /api/account {confirmEmail} — delete the signed-in account and everything in it, for good. The email typed
 * must be the account's own. Signs this browser out afterwards.
 */
export async function DELETE(req: Request) {
  try {
    const auth = await requireUser();
    if (!limiter("account-delete", 3, 10 * 60_000).check(`u:${auth.user.id}`, 1).ok) throw new ApiError("rate_limited", "Too many tries. Please wait a few minutes.");
    const { confirmEmail } = await parseJsonBody(req, deleteBody, 2_000);
    const email = auth.user.email?.trim().toLowerCase();
    if (!email || confirmEmail.trim().toLowerCase() !== email) throw new ApiError("bad_request", "Type your account's email address exactly to confirm.");
    const admin = serviceSupabase();
    if (!admin) throw new ApiError("not_configured", "Deleting accounts isn't set up on this Orbis yet. Email support to have your account deleted.");

    const cfg = publishConfig();
    const result = await deleteAccount({
      db: auth.supabase,
      admin,
      userId: auth.user.id,
      stopComputer: (id) => discardWorkspace(auth, id),
      takeDownSite: cfg ? (id) => siteHost(new VercelHost(cfg), cfg, id).remove() : null,
      stripeSubs: stripeSubscriptions(),
    });

    // The account no longer exists; clear this browser's session cookies too.
    const res = NextResponse.json({ ok: true, ...result });
    const store = await cookies();
    const expired = { path: "/", expires: new Date(0) };
    for (const name of cookiesToClear(store.getAll().map((c) => c.name))) {
      store.set(name, "", expired);
      res.cookies.set(name, "", expired);
    }
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
