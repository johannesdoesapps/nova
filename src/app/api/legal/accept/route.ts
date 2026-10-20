import { NextResponse } from "next/server";
import { z } from "zod";
import { LEGAL } from "@/content/legal-meta";
import { requireUser } from "@/lib/auth";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { ACCEPTED_COOKIE, acceptedCookieOptions, hasAccepted, recordAcceptance } from "@/lib/legal";

const body = z.object({ version: z.string().max(40), terms: z.literal(true), privacy: z.literal(true) });

/**
 * POST /api/legal/accept — the signed-in user accepts the current Terms of
 * Service and Privacy Policy (both boxes ticked on the "Before you continue" page).
 */
export async function POST(req: Request) {
  try {
    const input = await parseJsonBody(req, body, 1_000);
    if (input.version !== LEGAL.version) throw new ApiError("conflict", "These documents have just been updated. Reload the page to see the latest version.");
    const { supabase } = await requireUser();
    if ((await hasAccepted(supabase)) !== true && !(await recordAcceptance(supabase, "prompt"))) {
      throw new ApiError("upstream_error", "Your acceptance couldn't be saved. Please try again.");
    }
    const res = NextResponse.json({ ok: true });
    res.cookies.set(ACCEPTED_COOKIE, LEGAL.version, acceptedCookieOptions);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
