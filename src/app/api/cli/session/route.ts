import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { newCliSession } from "@/lib/cli-auth";
import { ApiError, errorResponse } from "@/lib/http";
import { limiter } from "@/lib/rate-limit";

/**
 * POST /api/cli/session — called by the /cli/login page (same site, signed in with the browser's cookies) when the
 * user allows the terminal app. It opens a new session just for the terminal app, so the app refreshing its own
 * tokens never uses up the browser's. 503 when the site can't (no service role key): the page then hands over the
 * browser's own session instead. The proxy refuses cross-site POSTs to /api/*.
 */
export async function POST() {
  try {
    const auth = await requireUser();
    if (!limiter("cli-session", 5, 60_000).check(`u:${auth.user.id}`, 1).ok) throw new ApiError("rate_limited", "Too many sign-ins. Please wait a moment.");
    const session = await newCliSession(auth.user.id);
    if (!session) throw new ApiError("not_configured", "This site can't open a separate session for the terminal app.");
    return NextResponse.json(session, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, { "Cache-Control": "no-store" });
  }
}
