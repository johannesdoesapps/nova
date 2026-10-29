import { NextResponse } from "next/server";
import { z } from "zod";
import { mergeCopy } from "@/lib/code/copies";
import { codeContext } from "@/lib/code/server";
import { errorResponse, parseJsonBody, requireUuid } from "@/lib/http";

export const maxDuration = 60;

const body = z.object({ force: z.boolean().optional() });

/**
 * POST /api/code/projects/[id]/merge — merge this parallel copy back into the project it was copied from. Files
 * changed in both since come back as conflicts (nothing is written) unless `force` picks the copy's versions.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/code/projects/[id]/merge">) {
  try {
    const id = requireUuid((await ctx.params).id);
    const { force } = await parseJsonBody(req, body, 500);
    const auth = await codeContext("code-ws", 10);
    return NextResponse.json(await mergeCopy(auth, id, { force }));
  } catch (err) {
    return errorResponse(err);
  }
}
