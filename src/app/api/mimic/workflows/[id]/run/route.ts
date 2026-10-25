import { NextResponse } from "next/server";
import { z } from "zod";
import { codeContext } from "@/lib/code/server";
import { ApiError, errorResponse, parseJsonBody, requireUuid } from "@/lib/http";
import { limiter } from "@/lib/rate-limit";
import { startRun } from "@/lib/mimic/server";

export const maxDuration = 60;

type Ctx = RouteContext<"/api/mimic/workflows/[id]/run">;

/** POST /api/mimic/workflows/[id]/run — run an automation on one invoice: a test (dryRun, nothing saved) or for real. */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const id = requireUuid((await ctx.params).id);
    const body = await parseJsonBody(req, z.object({ documentId: z.string().min(1).max(64), dryRun: z.boolean() }), 2_000);
    const auth = await codeContext("mimic-write", 60);
    if (!limiter("mimic-run", 40, 60_000).check(`u:${auth.user.id}`, 1).ok) throw new ApiError("rate_limited", "Too many runs at once. Please wait a moment.");
    return NextResponse.json({ run: await startRun(req, auth, id, body.documentId, body.dryRun) });
  } catch (err) {
    return errorResponse(err);
  }
}
