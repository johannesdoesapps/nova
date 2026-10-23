import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { onboardingPatch, type OnboardingState } from "@/lib/onboarding";

/**
 * PATCH /api/onboarding — save the starting point chosen in first-run onboarding (or that it was skipped), so the
 * guided start isn't shown again on any device. Only the choice and the time are kept; never what was typed.
 */
export async function PATCH(req: Request) {
  try {
    const body = await parseJsonBody(req, onboardingPatch, 500);
    const { supabase, user } = await requireUser();
    const { data, error: readError } = await supabase.from("profiles").select("preferences").eq("id", user.id).maybeSingle();
    if (readError) throw new ApiError("internal", "Could not load your preferences.");
    const onboarding: OnboardingState = { status: body.status, path: body.status === "chosen" ? (body.path ?? null) : null, at: new Date().toISOString() };
    const prefs = { ...((data?.preferences as Record<string, unknown> | null) ?? {}), onboarding };
    const { error } = await supabase.from("profiles").update({ preferences: prefs }).eq("id", user.id);
    if (error) throw new ApiError("internal", "Could not save your choice.");
    return NextResponse.json({ onboarding });
  } catch (err) {
    return errorResponse(err);
  }
}
