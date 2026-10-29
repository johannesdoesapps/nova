import { after, NextResponse } from "next/server";
import { z } from "zod";
import { kickWorker } from "@/lib/code/agent/background";
import { sessionOptions } from "@/lib/code/agent/session-schema";
import { sendMessage } from "@/lib/code/agent/sessions";
import { WORKING_STATUSES } from "@/lib/code/agent/types";
import { codeContext } from "@/lib/code/server";
import { errorResponse, parseJsonBody, requireUuid } from "@/lib/http";

const body = z.object({ text: z.string().trim().min(1).max(4_000), options: sessionOptions.optional() });

/**
 * POST /api/code/agent/[runId]/message — a message to a session. While it's open the message waits for the agent's
 * next step; a finished session carries on with it (the conversation is kept).
 */
export async function POST(req: Request, ctx: RouteContext<"/api/code/agent/[runId]/message">) {
  try {
    const runId = requireUuid((await ctx.params).runId);
    const { text, options } = await parseJsonBody(req, body, 12_000);
    const auth = await codeContext("code-agent", 30);
    const out = await sendMessage(auth, runId, text, options);
    if (out.delivered === "reopened" && out.run.options.background && WORKING_STATUSES.includes(out.run.status)) after(() => kickWorker(runId, new URL(req.url).origin));
    return NextResponse.json(out);
  } catch (err) {
    return errorResponse(err);
  }
}
