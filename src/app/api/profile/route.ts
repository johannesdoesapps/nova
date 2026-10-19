import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";

const patch = z
  .object({
    displayName: z.string().trim().min(1).max(80).optional(),
    /** The user's chosen chat model ("auto" or a model id); kept until they change it. */
    preferredModel: z.string().trim().min(1).max(120).regex(/^[\w.:-]+$/).optional(),
  })
  .refine((b) => b.displayName !== undefined || b.preferredModel !== undefined, "Nothing to update.");

/** PATCH /api/profile — update the signed-in user's display name and/or chat model choice. */
export async function PATCH(req: Request) {
  try {
    const body = await parseJsonBody(req, patch, 2_000);
    const { supabase, user } = await requireUser();
    if (body.displayName !== undefined) {
      const { error } = await supabase.from("profiles").update({ display_name: body.displayName }).eq("id", user.id);
      if (error) throw new ApiError("internal", "Could not update your profile.");
      await supabase.auth.updateUser({ data: { display_name: body.displayName } });
    }
    if (body.preferredModel !== undefined) {
      const { data } = await supabase.from("profiles").select("preferences").eq("id", user.id).maybeSingle();
      const prefs = { ...((data?.preferences as Record<string, unknown> | null) ?? {}), chatModel: body.preferredModel };
      const { error } = await supabase.from("profiles").update({ preferences: prefs }).eq("id", user.id);
      if (error) throw new ApiError("internal", "Could not save your model choice.");
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
