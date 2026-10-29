import { after, NextResponse } from "next/server";
import { z } from "zod";
import { kickWorker } from "@/lib/code/agent/background";
import { sessionOptions } from "@/lib/code/agent/session-schema";
import { forkRun } from "@/lib/code/agent/sessions";
import { WORKING_STATUSES } from "@/lib/code/agent/types";
import { codeContext } from "@/lib/code/server";
import { assertAgentAccess } from "@/lib/agent-platform/server";
import { errorResponse, parseJsonBody, requireUuid } from "@/lib/http";

const body = z.object({ text: z.string().trim().min(1).max(8_000), pointId: z.string().uuid().optional(), options: sessionOptions.optional() });

/** POST /api/code/agent/[runId]/fork — a new session with a copy of this one's conversation (up to a message), carrying on with `text`. */
export async function POST(req: Request, ctx: RouteContext<"/api/code/agent/[runId]/fork">) {
  try {
    const runId = requireUuid((await ctx.params).runId);
    const { text, pointId, options } = await parseJsonBody(req, body, 20_000);
    const auth = await codeContext("code-agent", 20);
    // Like starting a session: the engineer agent must be available on this plan and not paused.
    await assertAgentAccess(auth, "engineer");
    const run = await forkRun(auth, runId, text, { pointId, options });
    if (run.options.background && WORKING_STATUSES.includes(run.status)) after(() => kickWorker(run.id, new URL(req.url).origin));
    return NextResponse.json({ run }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
