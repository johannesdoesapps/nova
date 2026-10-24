import { NextResponse } from "next/server";
import { z } from "zod";
import { codeContext } from "@/lib/code/server";
import { errorResponse, parseJsonBody, requireUuid } from "@/lib/http";
import { resumeResearch, toView } from "@/lib/research/server";

const body = z.object({ writeNow: z.boolean().optional() });

/** POST /api/research/[id]/resume — continue a stopped or failed run, or ({writeNow}) write the report from what's been found. */
export async function POST(req: Request, ctx: RouteContext<"/api/research/[id]/resume">) {
  try {
    const id = requireUuid((await ctx.params).id);
    const input = await parseJsonBody(req, body, 200);
    const auth = await codeContext("research-write", 60);
    return NextResponse.json({ run: toView(await resumeResearch(auth, id, !!input.writeNow)) });
  } catch (err) {
    return errorResponse(err);
  }
}
