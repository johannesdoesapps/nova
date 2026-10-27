import { after, NextResponse } from "next/server";
import { kickWorker } from "@/lib/code/agent/background";
import { z } from "zod";
import { respondToRun } from "@/lib/code/agent/engine";
import { DECISIONS, WORKING_STATUSES } from "@/lib/code/agent/types";
import { codeContext } from "@/lib/code/server";
import { errorResponse, parseJsonBody, requireUuid } from "@/lib/http";

// Approving a command runs it (up to 2 minutes).
export const maxDuration = 300;

const body = z.object({ decision: z.enum(DECISIONS), text: z.string().max(4_000).optional() });

/** POST /api/code/agent/[runId]/respond — answer what the run is waiting for. */
export async function POST(req: Request, ctx: RouteContext<"/api/code/agent/[runId]/respond">) {
  try {
    const runId = requireUuid((await ctx.params).runId);
    const input = await parseJsonBody(req, body, 8_000);
    const auth = await codeContext("code-agent", 30);
    const run = await respondToRun(auth, runId, input);
    // Answered and back to work: if this page closes now, the worker carries on (runs started with "keep working").
    if (run.options.background && WORKING_STATUSES.includes(run.status) && !run.pending) after(() => kickWorker(runId, new URL(req.url).origin));
    return NextResponse.json({ run });
  } catch (err) {
    return errorResponse(err);
  }
}
