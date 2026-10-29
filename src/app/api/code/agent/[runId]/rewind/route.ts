import { NextResponse } from "next/server";
import { z } from "zod";
import { rewindPoints, rewindRun } from "@/lib/code/agent/sessions";
import { codeContext } from "@/lib/code/server";
import { errorResponse, parseJsonBody, requireUuid } from "@/lib/http";

/** GET /api/code/agent/[runId]/rewind — the points before each of the user's messages that the session can go back to. */
export async function GET(_req: Request, ctx: RouteContext<"/api/code/agent/[runId]/rewind">) {
  try {
    const runId = requireUuid((await ctx.params).runId);
    const auth = await codeContext("code-agent-read", 120);
    return NextResponse.json({ points: await rewindPoints(auth, runId) });
  } catch (err) {
    return errorResponse(err);
  }
}

const body = z.object({ pointId: z.string().uuid(), force: z.boolean().optional(), filesOnly: z.boolean().optional() });

/**
 * POST /api/code/agent/[runId]/rewind — go back to before one of the user's messages: the conversation is cut there
 * and the session's files restored. Files changed by someone else since come back as conflicts unless `force`.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/code/agent/[runId]/rewind">) {
  try {
    const runId = requireUuid((await ctx.params).runId);
    const input = await parseJsonBody(req, body, 2_000);
    const auth = await codeContext("code-agent", 20);
    return NextResponse.json(await rewindRun(auth, runId, input.pointId, input));
  } catch (err) {
    return errorResponse(err);
  }
}
