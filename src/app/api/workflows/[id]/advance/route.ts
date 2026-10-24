import { NextResponse } from "next/server";
import { advanceWorkflow, toWorkflowView } from "@/lib/agent-platform/workflow-server";
import { codeContext } from "@/lib/code/server";
import { errorResponse, requireUuid } from "@/lib/http";

// One advance may run one coding-agent step (a model call and a command, up to 270 s).
export const maxDuration = 300;

/** POST /api/workflows/[id]/advance — move the current step on, and start the next when it has ended. */
export async function POST(req: Request, ctx: RouteContext<"/api/workflows/[id]/advance">) {
  try {
    const id = requireUuid((await ctx.params).id);
    const auth = await codeContext("workflows-advance", 30);
    return NextResponse.json({ workflow: toWorkflowView(await advanceWorkflow(req, auth, id)) });
  } catch (err) {
    return errorResponse(err);
  }
}
