import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { deleteProject, getProject, updateProject } from "@/lib/db";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { projectPatch, uuid } from "@/lib/validation";

async function projectId(ctx: RouteContext<"/api/projects/[id]">) {
  const { id } = await ctx.params;
  if (!uuid.safeParse(id).success) throw new ApiError("not_found", "Project not found.");
  return id;
}

/** GET /api/projects/[id] — project with its conversations, searches, comparisons and notes. */
export async function GET(_req: Request, ctx: RouteContext<"/api/projects/[id]">) {
  try {
    const id = await projectId(ctx);
    const { supabase, user } = await requireUser();
    return NextResponse.json(await getProject(supabase, user.id, id));
  } catch (err) {
    return errorResponse(err);
  }
}

/** PATCH /api/projects/[id] — rename / edit description. */
export async function PATCH(req: Request, ctx: RouteContext<"/api/projects/[id]">) {
  try {
    const id = await projectId(ctx);
    const body = await parseJsonBody(req, projectPatch, 8_000);
    const { supabase, user } = await requireUser();
    return NextResponse.json({ project: await updateProject(supabase, user.id, id, body) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE /api/projects/[id] — delete; linked conversations/searches are kept but unlinked. */
export async function DELETE(_req: Request, ctx: RouteContext<"/api/projects/[id]">) {
  try {
    const id = await projectId(ctx);
    const { supabase, user } = await requireUser();
    await deleteProject(supabase, user.id, id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
