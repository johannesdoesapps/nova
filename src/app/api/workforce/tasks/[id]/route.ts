import { NextResponse } from "next/server";
import { ApiError, requireUuid } from "@/lib/http";
import { requireOperator, wfError } from "@/lib/workforce/server";

/** GET /api/workforce/tasks/[id]?after=<eventId> — task, steps, approvals and new events. */
export async function GET(req: Request, ctx: RouteContext<"/api/workforce/tasks/[id]">) {
  try {
    const { store } = await requireOperator();
    const id = requireUuid((await ctx.params).id);
    const task = await store.getTask(id);
    if (!task) throw new ApiError("not_found", "Task not found.");
    const after = Number(new URL(req.url).searchParams.get("after") ?? 0) || 0;
    const [steps, approvals, events, project] = await Promise.all([store.listSteps(id), store.listApprovals({ taskId: id }), store.listEvents(id, after, 500), store.getProject(task.project_id)]);
    return NextResponse.json({ task, steps, approvals, events, project });
  } catch (err) {
    return wfError(err);
  }
}
