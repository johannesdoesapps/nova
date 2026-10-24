import { NextResponse } from "next/server";
import { codeContext } from "@/lib/code/server";
import { errorResponse, requireUuid } from "@/lib/http";
import { projectForFix } from "@/lib/review/server";

export const maxDuration = 60;

/**
 * POST /api/review/[id]/project — the Code project to fix a finding in: the one the review came from, or a
 * new project made from the reviewed files (within the plan's project limits). The page then starts a
 * coding-agent task there, with plan approval and edit review on.
 */
export async function POST(_req: Request, ctx: RouteContext<"/api/review/[id]/project">) {
  try {
    const id = requireUuid((await ctx.params).id);
    const auth = await codeContext("review-write", 20);
    return NextResponse.json(await projectForFix(auth, id));
  } catch (err) {
    return errorResponse(err);
  }
}
