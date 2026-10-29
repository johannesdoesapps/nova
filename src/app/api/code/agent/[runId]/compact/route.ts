import { NextResponse } from "next/server";
import { z } from "zod";
import { compactRun } from "@/lib/code/agent/sessions";
import { codeContext } from "@/lib/code/server";
import { errorResponse, parseJsonBody, requireUuid } from "@/lib/http";

export const maxDuration = 180;

const body = z.object({ focus: z.string().trim().max(500).optional() });

/** POST /api/code/agent/[runId]/compact — summarise the session's conversation to make room (one metered model call). */
export async function POST(req: Request, ctx: RouteContext<"/api/code/agent/[runId]/compact">) {
  try {
    const runId = requireUuid((await ctx.params).runId);
    const { focus } = await parseJsonBody(req, body, 2_000);
    const auth = await codeContext("code-agent", 10);
    return NextResponse.json({ run: await compactRun(req, auth, runId, focus || null) });
  } catch (err) {
    return errorResponse(err);
  }
}
