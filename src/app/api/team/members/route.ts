import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { myTeam, teamErrorMessage } from "@/lib/team";

const body = z.object({ userId: z.uuid() });

/** DELETE /api/team/members — remove a member (owner), or leave the team (yourself). Their seat becomes free. */
export async function DELETE(req: Request) {
  try {
    const { userId } = await parseJsonBody(req, body, 1_000);
    const { supabase, user } = await requireUser();
    const team = await myTeam(supabase, user.id);
    if (!team) throw new ApiError("not_found", "You're not in a team.");
    const { error } = await supabase.rpc("team_remove_member", { p_team: team.id, p_user: userId });
    if (error) throw new ApiError("conflict", teamErrorMessage(error, "That member couldn't be removed."));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
