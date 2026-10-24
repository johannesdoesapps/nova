import { NextResponse } from "next/server";
import { codeContext } from "@/lib/code/server";
import { errorResponse, requireUuid } from "@/lib/http";
import { stepResearch, toView } from "@/lib/research/server";

// A research question can take a few minutes: Claude runs several searches and reads the results.
export const maxDuration = 300;

/** POST /api/research/[id]/step — run the next step (plan, one research question, or the report). */
export async function POST(req: Request, ctx: RouteContext<"/api/research/[id]/step">) {
  try {
    const id = requireUuid((await ctx.params).id);
    const auth = await codeContext("research-step", 30);
    return NextResponse.json({ run: toView(await stepResearch(req, auth, id)) });
  } catch (err) {
    return errorResponse(err);
  }
}
