import { NextResponse } from "next/server";
import { z } from "zod";
import { decideWorkflow, toWorkflowView } from "@/lib/agent-platform/workflow-server";
import { codeContext } from "@/lib/code/server";
import { errorResponse, parseJsonBody, requireUuid } from "@/lib/http";

const body = z.object({ action: z.enum(["approve", "reject"]), note: z.string().trim().max(1000).optional() });

/**
 * POST /api/workflows/[id]/decide — the user's decision at the end. Approve records it (pushing to
 * GitHub stays a separate, confirmed action); reject undoes the changes the workflow's tasks made.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/workflows/[id]/decide">) {
  try {
    const id = requireUuid((await ctx.params).id);
    const { action, note } = await parseJsonBody(req, body, 2_000);
    const auth = await codeContext("workflows", 20);
    return NextResponse.json({ workflow: toWorkflowView(await decideWorkflow(auth, id, action, note)) });
  } catch (err) {
    return errorResponse(err);
  }
}
