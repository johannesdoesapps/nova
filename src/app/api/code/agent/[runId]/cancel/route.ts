import { NextResponse } from "next/server";
import { cancelRun } from "@/lib/code/agent/engine";
import { codeContext } from "@/lib/code/server";
import { errorResponse, requireUuid } from "@/lib/http";

/** POST /api/code/agent/[runId]/cancel — stop the run (and a command it's running). Its changes stay until reverted. */
export async function POST(_req: Request, ctx: RouteContext<"/api/code/agent/[runId]/cancel">) {
  try {
    const runId = requireUuid((await ctx.params).runId);
    const auth = await codeContext("code-agent", 60);
    return NextResponse.json({ run: await cancelRun(auth, runId) });
  } catch (err) {
    return errorResponse(err);
  }
}
