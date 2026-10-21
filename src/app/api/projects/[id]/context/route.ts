import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getProjectContext, setProjectContext } from "@/lib/db/project-context";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { projectContextBlock } from "@/lib/projects/context";
import { projectContextPatch, uuid } from "@/lib/validation";

async function projectId(ctx: RouteContext<"/api/projects/[id]/context">) {
  const { id } = await ctx.params;
  if (!uuid.safeParse(id).success) throw new ApiError("not_found", "Project not found.");
  return id;
}

/** GET — what this project shares with its chats, and what a reply would see now. */
export async function GET(_req: Request, ctx: RouteContext<"/api/projects/[id]/context">) {
  try {
    const id = await projectId(ctx);
    const { supabase, user } = await requireUser();
    const pc = await getProjectContext(supabase, user.id, id);
    if (!pc) throw new ApiError("not_found", "Project not found.");
    return NextResponse.json({ name: pc.name, settings: pc.settings, instructions: pc.instructions ?? "", used: projectContextBlock(pc).used }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}

/** PATCH — choose whether the project's instructions and notes are shared with its chats. */
export async function PATCH(req: Request, ctx: RouteContext<"/api/projects/[id]/context">) {
  try {
    const id = await projectId(ctx);
    const body = await parseJsonBody(req, projectContextPatch, 1_000);
    const { supabase, user } = await requireUser();
    return NextResponse.json({ settings: await setProjectContext(supabase, user.id, id, body) });
  } catch (err) {
    return errorResponse(err);
  }
}
