import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";

/** GET — whether the user gets an email when a task that kept working in the background finishes or needs them. */
export async function GET() {
  try {
    const { supabase, user } = await requireUser();
    const { data } = await supabase.from("profiles").select("preferences").eq("id", user.id).maybeSingle();
    const email = (data?.preferences as { notifyEmail?: unknown } | null)?.notifyEmail !== false;
    return NextResponse.json({ email }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}

const body = z.object({ email: z.boolean() }).strict();

/** PATCH { email } — turn task emails on or off (saved with the account). */
export async function PATCH(req: Request) {
  try {
    const { email } = await parseJsonBody(req, body, 200);
    const { supabase, user } = await requireUser();
    const { data, error: readError } = await supabase.from("profiles").select("preferences").eq("id", user.id).maybeSingle();
    if (readError) throw new ApiError("internal", "Couldn't load your settings.");
    const prefs = { ...((data?.preferences as Record<string, unknown> | null) ?? {}), notifyEmail: email };
    const { error } = await supabase.from("profiles").update({ preferences: prefs }).eq("id", user.id);
    if (error) throw new ApiError("internal", "Couldn't save your choice.");
    return NextResponse.json({ email });
  } catch (err) {
    return errorResponse(err);
  }
}
