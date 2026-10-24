import { NextResponse } from "next/server";
import { codeContext } from "@/lib/code/server";
import { errorResponse, requireUuid } from "@/lib/http";
import { cancelReview, toView } from "@/lib/review/server";

/** POST /api/review/[id]/cancel — stop the review; findings so far are kept. */
export async function POST(_req: Request, ctx: RouteContext<"/api/review/[id]/cancel">) {
  try {
    const id = requireUuid((await ctx.params).id);
    const auth = await codeContext("review-write", 60);
    return NextResponse.json({ review: toView(await cancelReview(auth, id)) });
  } catch (err) {
    return errorResponse(err);
  }
}
