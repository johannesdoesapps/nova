import { NextResponse } from "next/server";
import { z } from "zod";
import { codeContext } from "@/lib/code/server";
import { errorResponse, parseJsonBody, requireUuid } from "@/lib/http";
import { stepReview, toView } from "@/lib/review/server";

export const maxDuration = 120;

const body = z.object({ modelId: z.string().max(120).nullable().optional() });

/** POST /api/review/[id]/step — run the next part of the AI review (one model call, metered). */
export async function POST(req: Request, ctx: RouteContext<"/api/review/[id]/step">) {
  try {
    const id = requireUuid((await ctx.params).id);
    const input = await parseJsonBody(req, body, 1_000);
    const auth = await codeContext("review-step", 30);
    return NextResponse.json({ review: toView(await stepReview(req, auth, id, input.modelId ?? null)) });
  } catch (err) {
    return errorResponse(err);
  }
}
