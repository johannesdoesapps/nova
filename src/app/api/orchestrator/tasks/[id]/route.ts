import { NextResponse } from "next/server";
import { getTask, requireOrchestrator } from "@/lib/orchestrator/server";
import { errorResponse, requireUuid } from "@/lib/http";

type Ctx = RouteContext<"/api/orchestrator/tasks/[id]">;

/** GET /api/orchestrator/tasks/[id] — a task with its attempts, sub-tasks and status history. */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const id = requireUuid((await ctx.params).id);
    const auth = await requireOrchestrator();
    return NextResponse.json(await getTask(auth, id));
  } catch (err) {
    return errorResponse(err);
  }
}
