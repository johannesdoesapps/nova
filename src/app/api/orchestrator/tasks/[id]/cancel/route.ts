import { NextResponse } from "next/server";
import { cancelTask, requireOrchestrator } from "@/lib/orchestrator/server";
import { errorResponse, requireUuid } from "@/lib/http";

type Ctx = RouteContext<"/api/orchestrator/tasks/[id]/cancel">;

/**
 * POST /api/orchestrator/tasks/[id]/cancel — cancel a task and its unfinished sub-tasks. A running attempt stops
 * before its next model call; its slot is released when the worker records it (or when its lease expires).
 */
export async function POST(_req: Request, ctx: Ctx) {
  try {
    const id = requireUuid((await ctx.params).id);
    const auth = await requireOrchestrator(30);
    return NextResponse.json(await cancelTask(auth, id));
  } catch (err) {
    return errorResponse(err);
  }
}
