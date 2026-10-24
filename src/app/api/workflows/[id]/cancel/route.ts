import { NextResponse } from "next/server";
import { cancelWorkflow, toWorkflowView } from "@/lib/agent-platform/workflow-server";
import { codeContext } from "@/lib/code/server";
import { errorResponse, requireUuid } from "@/lib/http";

/** POST /api/workflows/[id]/cancel — stop the workflow and the task it's running; changes so far are kept until undone. */
export async function POST(_req: Request, ctx: RouteContext<"/api/workflows/[id]/cancel">) {
  try {
    const id = requireUuid((await ctx.params).id);
    const auth = await codeContext("workflows", 20);
    return NextResponse.json({ workflow: toWorkflowView(await cancelWorkflow(auth, id)) });
  } catch (err) {
    return errorResponse(err);
  }
}
