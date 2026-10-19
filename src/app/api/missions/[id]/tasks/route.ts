import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { assertProject } from "@/lib/db";
import { addTask } from "@/lib/db/missions";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { taskCreate } from "@/lib/missions/schema";
import { uuid } from "@/lib/validation";

/** POST /api/missions/[id]/tasks — add a task to a mission. */
export async function POST(req: Request, ctx: RouteContext<"/api/missions/[id]/tasks">) {
  try {
    const { id } = await ctx.params;
    if (!uuid.safeParse(id).success) throw new ApiError("not_found", "Mission not found.");
    const auth = await requireUser();
    const body = await parseJsonBody(req, taskCreate);
    await assertProject(auth.supabase, auth.user.id, id);
    return NextResponse.json({ task: await addTask(auth.supabase, auth.user.id, id, body) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
