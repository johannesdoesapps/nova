import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";

const patch = z.object({ displayName: z.string().trim().min(1).max(80) });

/** PATCH /api/profile — update the signed-in user's display name. */
export async function PATCH(req: Request) {
  try {
    const body = await parseJsonBody(req, patch, 2_000);
    const { supabase, user } = await requireUser();
    const { error } = await supabase.from("profiles").update({ display_name: body.displayName }).eq("id", user.id);
    if (error) throw new ApiError("internal", "Could not update your profile.");
    await supabase.auth.updateUser({ data: { display_name: body.displayName } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
