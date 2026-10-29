import { NextResponse } from "next/server";
import { z } from "zod";
import { sessionOptions } from "@/lib/code/agent/session-schema";
import { setSessionOptions } from "@/lib/code/agent/sessions";
import { codeContext } from "@/lib/code/server";
import { errorResponse, parseJsonBody, requireUuid } from "@/lib/http";

const body = z.object({ options: sessionOptions });

/** POST /api/code/agent/[runId]/mode — change how the agent may work (or its model) from its next step on. */
export async function POST(req: Request, ctx: RouteContext<"/api/code/agent/[runId]/mode">) {
  try {
    const runId = requireUuid((await ctx.params).runId);
    const { options } = await parseJsonBody(req, body, 2_000);
    const auth = await codeContext("code-agent", 30);
    return NextResponse.json({ run: await setSessionOptions(auth, runId, options) });
  } catch (err) {
    return errorResponse(err);
  }
}
