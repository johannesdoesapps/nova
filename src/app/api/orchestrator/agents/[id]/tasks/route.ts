import { NextResponse } from "next/server";
import { agentTasks, requireOrchestrator } from "@/lib/orchestrator/server";
import { errorResponse, requireUuid } from "@/lib/http";

type Ctx = RouteContext<"/api/orchestrator/agents/[id]/tasks">;

/** GET /api/orchestrator/agents/[id]/tasks — the most recent tasks assigned to or run by this agent. */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const id = requireUuid((await ctx.params).id);
    const auth = await requireOrchestrator();
    return NextResponse.json({ tasks: await agentTasks(auth, id) });
  } catch (err) {
    return errorResponse(err);
  }
}
