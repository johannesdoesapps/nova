import { NextResponse } from "next/server";
import { trackEvent } from "@/lib/analytics/server";
import { clientEvent } from "@/lib/analytics/schema";
import { getAuth } from "@/lib/auth";
import { errorResponse, parseJsonBody } from "@/lib/http";
import { limiter } from "@/lib/rate-limit";

/**
 * POST /api/events — the two events only the browser knows about (a result
 * was copied or saved; a palette command was used). Signed-in users only;
 * guests and anyone who turned events off are ignored. Never any text.
 */
export async function POST(req: Request) {
  try {
    const body = await parseJsonBody(req, clientEvent, 1_000);
    const auth = await getAuth();
    if (auth.mode !== "authenticated") return new NextResponse(null, { status: 204 });
    if (!limiter("events-minute", 60, 60_000).check(`u:${auth.user.id}`, 1).ok) return new NextResponse(null, { status: 204 });
    trackEvent(auth, body.event, body.props);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
