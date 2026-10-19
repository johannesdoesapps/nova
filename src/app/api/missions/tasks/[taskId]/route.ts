import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { deleteTask, getTask, updateTask } from "@/lib/db/missions";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { taskPatch } from "@/lib/missions/schema";
import { uuid } from "@/lib/validation";

async function taskId(ctx: RouteContext<"/api/missions/tasks/[taskId]">) {
  const { taskId } = await ctx.params;
  if (!uuid.safeParse(taskId).success) throw new ApiError("not_found", "Task not found.");
  return taskId;
}

/** PATCH — edit a task or change its status. Completion is always the user's call. */
export async function PATCH(req: Request, ctx: RouteContext<"/api/missions/tasks/[taskId]">) {
  try {
    const auth = await requireUser();
    const id = await taskId(ctx);
    const b = await parseJsonBody(req, taskPatch, 80_000);
    const current = await getTask(auth.supabase, auth.user.id, id);
    const patch: Record<string, unknown> = {};
    if (b.title !== undefined) patch.title = b.title;
    if (b.description !== undefined) patch.description = b.description;
    if (b.milestone !== undefined) patch.milestone = b.milestone;
    if (b.priority !== undefined) patch.priority = b.priority;
    if (b.aiSuitable !== undefined) patch.ai_suitable = b.aiSuitable;
    if (b.output !== undefined) patch.output = b.output;
    if (b.status !== undefined && b.status !== current.status) {
      patch.status = b.status;
      patch.completed_at = b.status === "completed" ? new Date().toISOString() : null;
    }
    return NextResponse.json({ task: await updateTask(auth.supabase, auth.user.id, id, patch) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: Request, ctx: RouteContext<"/api/missions/tasks/[taskId]">) {
  try {
    const auth = await requireUser();
    await deleteTask(auth.supabase, auth.user.id, await taskId(ctx));
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
