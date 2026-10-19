import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { deleteProject } from "@/lib/db";
import { getMission, updateMission } from "@/lib/db/missions";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { missionPatch } from "@/lib/missions/schema";
import { uuid } from "@/lib/validation";

async function missionId(ctx: RouteContext<"/api/missions/[id]">) {
  const { id } = await ctx.params;
  if (!uuid.safeParse(id).success) throw new ApiError("not_found", "Mission not found.");
  return id;
}

export async function GET(_req: Request, ctx: RouteContext<"/api/missions/[id]">) {
  try {
    const auth = await requireUser();
    return NextResponse.json(await getMission(auth.supabase, auth.user.id, await missionId(ctx)));
  } catch (err) {
    return errorResponse(err);
  }
}

/** PATCH — rename, edit the goal, or pause / resume / complete / archive. */
export async function PATCH(req: Request, ctx: RouteContext<"/api/missions/[id]">) {
  try {
    const auth = await requireUser();
    const body = await parseJsonBody(req, missionPatch);
    return NextResponse.json({ mission: await updateMission(auth.supabase, auth.user.id, await missionId(ctx), body) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: Request, ctx: RouteContext<"/api/missions/[id]">) {
  try {
    const auth = await requireUser();
    await deleteProject(auth.supabase, auth.user.id, await missionId(ctx));
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
