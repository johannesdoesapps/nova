import { NextResponse } from "next/server";
import { z } from "zod";
import { stepRun } from "@/lib/code/agent/engine";
import { codeContext } from "@/lib/code/server";
import { errorResponse, parseJsonBody, requireUuid } from "@/lib/http";

// A step is one model call plus at most one command (up to 2 minutes); a request takes more steps while it's young.
export const maxDuration = 300;

const body = z.object({ expectStep: z.number().int().min(0).max(1_000).optional() });

/**
 * POST /api/code/agent/[runId]/step — let the agent take its next step(s).
 * `expectStep` is the step count the page last saw; if the run has moved on
 * since (the request was retried), nothing runs again.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/code/agent/[runId]/step">) {
  try {
    const runId = requireUuid((await ctx.params).runId);
    const input = req.headers.get("content-length") === "0" ? {} : await parseJsonBody(req, body, 1_000).catch(() => ({}));
    const auth = await codeContext("code-agent-step", 30);
    return NextResponse.json(await stepRun(req, auth, runId, input));
  } catch (err) {
    return errorResponse(err);
  }
}
