import { NextResponse } from "next/server";
import { z } from "zod";
import { recoverWorkflow, toWorkflowView } from "@/lib/agent-platform/workflow-server";
import { codeContext } from "@/lib/code/server";
import { errorResponse, parseJsonBody, requireUuid } from "@/lib/http";

const body = z.object({ action: z.enum(["retry", "skip"]) });

/** POST /api/workflows/[id]/recover — after a step failed: try it again (up to three attempts), or skip it if it's optional. */
export async function POST(req: Request, ctx: RouteContext<"/api/workflows/[id]/recover">) {
  try {
    const id = requireUuid((await ctx.params).id);
    const { action } = await parseJsonBody(req, body, 200);
    const auth = await codeContext("workflows", 20);
    return NextResponse.json({ workflow: toWorkflowView(await recoverWorkflow(auth, id, action)) });
  } catch (err) {
    return errorResponse(err);
  }
}
