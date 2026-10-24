import { NextResponse } from "next/server";
import { codeContext } from "@/lib/code/server";
import { errorResponse, requireUuid } from "@/lib/http";
import { cancelResearch, toView } from "@/lib/research/server";

/** POST /api/research/[id]/cancel — stop; what was found so far is kept. */
export async function POST(_req: Request, ctx: RouteContext<"/api/research/[id]/cancel">) {
  try {
    const id = requireUuid((await ctx.params).id);
    const auth = await codeContext("research-write", 60);
    return NextResponse.json({ run: toView(await cancelResearch(auth, id)) });
  } catch (err) {
    return errorResponse(err);
  }
}
