import { NextResponse } from "next/server";
import { z } from "zod";
import { codeContext } from "@/lib/code/server";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { limiter } from "@/lib/rate-limit";
import { createReview, listReviews } from "@/lib/review/server";
import { sourceInput } from "@/lib/review/sources";

export const maxDuration = 90;

/** GET /api/review — the user's code reviews, newest first. */
export async function GET() {
  try {
    const auth = await codeContext("review-read", 120);
    return NextResponse.json({ reviews: await listReviews(auth) });
  } catch (err) {
    return errorResponse(err);
  }
}

const body = z.object({ source: sourceInput, focus: z.string().trim().max(2000).nullable().optional() });

/**
 * POST /api/review — start a review: loads the code (paste, diff, ZIP, GitHub, or a Code project), runs the
 * deterministic security and dependency checks, and plans the AI review. The AI parts run in steps
 * (POST /api/review/[id]/step) so no request runs long.
 */
export async function POST(req: Request) {
  try {
    const input = await parseJsonBody(req, body, 4_400_000);
    const auth = await codeContext("review-create", 20);
    if (!limiter("review-new", 12, 10 * 60_000).check(`u:${auth.user.id}`, 1).ok) throw new ApiError("rate_limited", "Too many new reviews. Please wait a few minutes.");
    return NextResponse.json({ review: await createReview(req, auth, input) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
