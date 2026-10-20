import { NextResponse } from "next/server";
import { stepRun } from "@/lib/code/agent/engine";
import { codeContext } from "@/lib/code/server";
import { errorResponse, requireUuid } from "@/lib/http";

// A step is one model call plus at most one command (up to 2 minutes).
export const maxDuration = 300;

/** POST /api/code/agent/[runId]/step — let the agent take its next step. */
export async function POST(req: Request, ctx: RouteContext<"/api/code/agent/[runId]/step">) {
  try {
    const runId = requireUuid((await ctx.params).runId);
    const auth = await codeContext("code-agent-step", 30);
    return NextResponse.json(await stepRun(req, auth, runId));
  } catch (err) {
    return errorResponse(err);
  }
}
