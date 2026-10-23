import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { hashInviteToken, teamErrorMessage } from "@/lib/team";

const body = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{20,64}$/) });

/** POST /api/team/join — accept an invitation with the code from its link (signed in with the invited email). */
export async function POST(req: Request) {
  try {
    const { token } = await parseJsonBody(req, body, 1_000);
    const { supabase } = await requireUser();
    const { data, error } = await supabase.rpc("team_accept_invite", { p_token_hash: hashInviteToken(token) });
    if (error || !data) throw new ApiError("conflict", teamErrorMessage(error, "The invitation couldn't be accepted."));
    return NextResponse.json({ teamId: data });
  } catch (err) {
    return errorResponse(err);
  }
}
