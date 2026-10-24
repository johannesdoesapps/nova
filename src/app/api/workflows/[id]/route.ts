import { NextResponse } from "next/server";
import { getWorkflow, toWorkflowView } from "@/lib/agent-platform/workflow-server";
import { codeContext, getProjectRow } from "@/lib/code/server";
import { errorResponse, requireUuid } from "@/lib/http";

/** GET /api/workflows/[id] — one of the user's workflows with its steps and log. */
export async function GET(_req: Request, ctx: RouteContext<"/api/workflows/[id]">) {
  try {
    const id = requireUuid((await ctx.params).id);
    const auth = await codeContext("workflows-read", 240);
    const row = await getWorkflow(auth, id);
    const project = await getProjectRow(auth, row.project_id).catch(() => null);
    return NextResponse.json({ workflow: toWorkflowView(row, project?.name ?? null) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
