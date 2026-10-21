import { NextResponse } from "next/server";
import { getAuth, requireUser } from "@/lib/auth";
import { applyPrefs, EMPTY_PREFS, homePrefsPatch, readPrefs, type HomeData } from "@/lib/home";
import { loadHome } from "@/lib/home-data";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";

const GUEST: HomeData & { errors: string[] } = { signedIn: false, conversations: [], projects: [], tasks: [], prefs: EMPTY_PREFS, calendar: "unavailable", errors: [] };

/** GET /api/home — the signed-in home: recent conversations, projects, tasks, preferences and calendar state. Guests get an empty home. */
export async function GET() {
  try {
    const auth = await getAuth();
    if (auth.mode !== "authenticated") return NextResponse.json(GUEST);
    return NextResponse.json(await loadHome(auth), { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}

/** PATCH /api/home — change the home's preferences (hidden sections, dismissed suggestions, today's priorities). */
export async function PATCH(req: Request) {
  try {
    const body = await parseJsonBody(req, homePrefsPatch, 8_000);
    const { supabase, user } = await requireUser();
    const { data, error: readError } = await supabase.from("profiles").select("preferences").eq("id", user.id).maybeSingle();
    if (readError) throw new ApiError("internal", "Could not load your preferences.");
    const all = (data?.preferences as Record<string, unknown> | null) ?? {};
    const home = applyPrefs(readPrefs(all.home), body);
    const { error } = await supabase
      .from("profiles")
      .update({ preferences: { ...all, home } })
      .eq("id", user.id);
    if (error) throw new ApiError("internal", "Could not save your home settings.");
    return NextResponse.json({ prefs: home });
  } catch (err) {
    return errorResponse(err);
  }
}
