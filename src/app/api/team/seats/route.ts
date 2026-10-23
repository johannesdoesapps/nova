import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { billingConfigured, stripeClient, syncTeamSubscription } from "@/lib/billing/stripe";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { myTeam, TEAM_MAX_SEATS, TEAM_MIN_SEATS } from "@/lib/team";

const body = z.object({ seats: z.number().int().min(TEAM_MIN_SEATS).max(TEAM_MAX_SEATS) });

/**
 * PATCH /api/team/seats — change the number of seats (owner). Stripe prorates: added seats are charged for the rest
 * of the period, removed seats credited. Seats can't go below the members plus open invitations.
 */
export async function PATCH(req: Request) {
  try {
    const { seats } = await parseJsonBody(req, body, 1_000);
    const { supabase, user } = await requireUser();
    const stripe = stripeClient();
    if (!stripe || !billingConfigured()) throw new ApiError("not_configured", "Payments aren't set up on this site yet.");
    const team = await myTeam(supabase, user.id);
    if (!team || team.owner_id !== user.id) throw new ApiError("forbidden", "Only the team owner can change seats.");
    if (!team.stripe_subscription_id || !["active", "trialing", "past_due"].includes(team.status)) throw new ApiError("conflict", "The team has no active subscription.");
    const [{ count: members }, { count: invites }] = await Promise.all([
      supabase.from("team_members").select("user_id", { count: "exact", head: true }).eq("team_id", team.id),
      supabase.from("team_invites").select("id", { count: "exact", head: true }).eq("team_id", team.id).is("accepted_at", null).is("revoked_at", null).gt("expires_at", new Date().toISOString()),
    ]);
    const inUse = (members ?? 0) + (invites ?? 0);
    if (seats < inUse) throw new ApiError("conflict", `${inUse} seats are in use (members and open invitations). Remove someone or withdraw an invitation first.`);
    const sub = await stripe.subscriptions.retrieve(team.stripe_subscription_id);
    const item = sub.items.data[0];
    if (!item) throw new ApiError("upstream_error", "The subscription has no seats item.");
    const updated = await stripe.subscriptions.update(sub.id, { items: [{ id: item.id, quantity: seats }], proration_behavior: "create_prorations" });
    await syncTeamSubscription(updated);
    return NextResponse.json({ seats });
  } catch (err) {
    return errorResponse(err);
  }
}
