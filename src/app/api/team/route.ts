import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { billingConfigured } from "@/lib/billing/stripe";
import { getBilling } from "@/lib/entitlements";
import { errorResponse } from "@/lib/http";
import { chargeUsd, planOf } from "@/lib/plans";
import { myTeam, TEAM_MAX_SEATS, TEAM_MIN_SEATS } from "@/lib/team";

/**
 * GET /api/team — the caller's team (if any): plan, seats, status, members (email and role only) and, for the
 * owner, open invitations; plus per-seat prices for starting a team.
 */
export async function GET() {
  try {
    const { supabase, user } = await requireUser();
    const [team, billing] = await Promise.all([myTeam(supabase, user.id), getBilling()]);
    const price = (id: "pro" | "max") => {
      const p = planOf(billing, id);
      return { label: p.label, month: chargeUsd(p, "month"), year: chargeUsd(p, "year") };
    };
    const offer = { pro: price("pro"), max: price("max"), minSeats: TEAM_MIN_SEATS, maxSeats: TEAM_MAX_SEATS, paymentsReady: billingConfigured() };
    if (!team) return NextResponse.json({ team: null, offer }, { headers: { "Cache-Control": "no-store" } });
    const owner = team.owner_id === user.id;
    const [{ data: members }, invites] = await Promise.all([
      supabase.rpc("team_roster"),
      owner
        ? supabase
            .from("team_invites")
            .select("id, email, created_at, expires_at")
            .eq("team_id", team.id)
            .is("accepted_at", null)
            .is("revoked_at", null)
            .gt("expires_at", new Date().toISOString())
            .order("created_at", { ascending: false })
        : Promise.resolve({ data: [] }),
    ]);
    return NextResponse.json(
      {
        team: {
          id: team.id,
          name: team.name,
          plan: team.plan,
          planLabel: planOf(billing, team.plan).label,
          interval: team.billing_interval,
          seats: team.seats,
          status: team.status,
          seatPriceUsd: team.price_usd,
          periodEnd: team.current_period_end,
          cancelAtPeriodEnd: team.cancel_at_period_end,
          disputed: team.disputed,
          role: owner ? "owner" : "member",
        },
        members: members ?? [],
        invites: invites.data ?? [],
        offer,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
