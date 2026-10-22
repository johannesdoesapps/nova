import { NextResponse } from "next/server";
import { eventsAllowed } from "@/lib/analytics/server";
import { eventSettings } from "@/lib/analytics/schema";
import { requireUser } from "@/lib/auth";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";

/** GET — whether Orbis records product events for this user. */
export async function GET() {
  try {
    const { supabase, user } = await requireUser();
    const { data } = await supabase.from("profiles").select("preferences").eq("id", user.id).maybeSingle();
    return NextResponse.json({ productEvents: eventsAllowed(data?.preferences) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}

/** PATCH { productEvents } — turn product events on or off (existing events are kept; email to have them deleted). */
export async function PATCH(req: Request) {
  try {
    const body = await parseJsonBody(req, eventSettings, 200);
    const { supabase, user } = await requireUser();
    const { data, error: readError } = await supabase.from("profiles").select("preferences").eq("id", user.id).maybeSingle();
    if (readError) throw new ApiError("internal", "Couldn't load your settings.");
    const prefs = { ...((data?.preferences as Record<string, unknown> | null) ?? {}), productEvents: body.productEvents };
    const { error } = await supabase.from("profiles").update({ preferences: prefs }).eq("id", user.id);
    if (error) throw new ApiError("internal", "Couldn't save your choice.");
    return NextResponse.json({ productEvents: body.productEvents });
  } catch (err) {
    return errorResponse(err);
  }
}
