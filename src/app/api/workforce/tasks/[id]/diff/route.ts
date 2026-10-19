import { ApiError } from "@/lib/http";
import { requireOperator, wfError } from "@/lib/workforce/server";

/** GET /api/workforce/tasks/[id]/diff — download the change as a patch (apply with `git apply`). */
export async function GET(_req: Request, ctx: RouteContext<"/api/workforce/tasks/[id]/diff">) {
  try {
    const { store } = await requireOperator();
    const { id } = await ctx.params;
    const task = await store.getTask(id);
    if (!task) throw new ApiError("not_found", "Task not found.");
    if (!task.diff) throw new ApiError("not_found", "This task has no changes.");
    await store.addEvent({ task_id: id, level: "audit", type: "diff.downloaded", message: "Patch downloaded by the operator." });
    return new Response(task.diff, { headers: { "content-type": "text/x-diff; charset=utf-8", "content-disposition": `attachment; filename="nova-task-${id.slice(0, 8)}.patch"`, "cache-control": "no-store" } });
  } catch (err) {
    return wfError(err);
  }
}
