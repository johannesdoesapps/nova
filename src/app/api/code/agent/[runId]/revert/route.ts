import { NextResponse } from "next/server";
import { z } from "zod";
import { revertRun } from "@/lib/code/agent/engine";
import { projectPath } from "@/lib/code/projects";
import { codeContext } from "@/lib/code/server";
import { errorResponse, parseJsonBody, requireUuid } from "@/lib/http";

const body = z.object({ path: projectPath.optional(), force: z.boolean().optional() });

/**
 * POST /api/code/agent/[runId]/revert — put the run's files back as they were
 * before it (all, or one path). Files changed since are reported as
 * conflicts and left alone unless `force` is set.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/code/agent/[runId]/revert">) {
  try {
    const runId = requireUuid((await ctx.params).runId);
    const input = await parseJsonBody(req, body, 2_000);
    const auth = await codeContext("code-agent", 30);
    return NextResponse.json(await revertRun(auth, runId, input));
  } catch (err) {
    return errorResponse(err);
  }
}
