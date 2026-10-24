import { NextResponse } from "next/server";
import { codeContext } from "@/lib/code/server";
import { errorResponse, requireUuid } from "@/lib/http";
import { retryReview, toView } from "@/lib/review/server";

/** POST /api/review/[id]/retry — continue a failed or stopped review from the part where it stopped. */
export async function POST(_req: Request, ctx: RouteContext<"/api/review/[id]/retry">) {
  try {
    const id = requireUuid((await ctx.params).id);
    const auth = await codeContext("review-write", 60);
    return NextResponse.json({ review: toView(await retryReview(auth, id)) });
  } catch (err) {
    return errorResponse(err);
  }
}
