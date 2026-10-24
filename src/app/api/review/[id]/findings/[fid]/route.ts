import { NextResponse } from "next/server";
import { z } from "zod";
import { codeContext } from "@/lib/code/server";
import { errorResponse, parseJsonBody, requireUuid } from "@/lib/http";
import { setFindingStatus, toView } from "@/lib/review/server";

const body = z.object({ status: z.enum(["open", "dismissed", "resolved"]) });

/** PATCH /api/review/[id]/findings/[fid] — dismiss a finding, mark it resolved, or reopen it. */
export async function PATCH(req: Request, ctx: RouteContext<"/api/review/[id]/findings/[fid]">) {
  try {
    const { id, fid } = await ctx.params;
    const input = await parseJsonBody(req, body, 200);
    const auth = await codeContext("review-write", 120);
    return NextResponse.json({ review: toView(await setFindingStatus(auth, requireUuid(id), fid.slice(0, 40), input.status)) });
  } catch (err) {
    return errorResponse(err);
  }
}
