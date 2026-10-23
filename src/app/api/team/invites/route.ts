import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { emailConfigured, sendEmailTo } from "@/lib/email";
import { publicEnv } from "@/lib/env";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { reportError } from "@/lib/observability";
import { myTeam, newInviteToken, teamErrorMessage } from "@/lib/team";

const invite = z.object({ email: z.email().max(320) });

/**
 * POST /api/team/invites — invite someone by email (team owner). Returns the invite link; it's also emailed when
 * email is set up. Only the invited address can accept, and only while a seat is free.
 */
export async function POST(req: Request) {
  try {
    const { email } = await parseJsonBody(req, invite, 1_000);
    const { supabase, user } = await requireUser();
    const team = await myTeam(supabase, user.id);
    if (!team || team.owner_id !== user.id) throw new ApiError("forbidden", "Only the team owner can invite people.");
    const { token, hash } = newInviteToken();
    const { error } = await supabase.rpc("team_invite_create", { p_team: team.id, p_email: email, p_token_hash: hash });
    if (error) throw new ApiError("conflict", teamErrorMessage(error, "The invitation couldn't be created."));
    const link = `${publicEnv.siteUrl.replace(/\/$/, "")}/team/join?token=${token}`;
    let emailed = false;
    if (emailConfigured()) {
      try {
        await sendEmailTo(
          email,
          `You're invited to ${team.name} on Orbis`,
          `${user.email ?? "Someone"} invited you to join ${team.name} on Orbis, which gives you its plan.\n\nAccept the invitation (sign in or create an account with this email address): ${link}\n\nThe link works for 14 days.\n\n— Orbis`,
        );
        emailed = true;
      } catch (err) {
        reportError(err, { where: "team.invite.email" });
      }
    }
    return NextResponse.json({ link, emailed });
  } catch (err) {
    return errorResponse(err);
  }
}

const revoke = z.object({ id: z.uuid() });

/** DELETE /api/team/invites — withdraw an open invitation (team owner). */
export async function DELETE(req: Request) {
  try {
    const { id } = await parseJsonBody(req, revoke, 1_000);
    const { supabase } = await requireUser();
    const { error } = await supabase.rpc("team_revoke_invite", { p_invite: id });
    if (error) throw new ApiError("internal", "The invitation couldn't be withdrawn.");
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
