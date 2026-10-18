import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { deleteConversation, getConversation, updateConversation } from "@/lib/db";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { conversationPatch, uuid } from "@/lib/validation";

async function idFrom(ctx: RouteContext<"/api/conversations/[id]">) {
  const { id } = await ctx.params;
  if (!uuid.safeParse(id).success) throw new ApiError("not_found", "Conversation not found.");
  return id;
}

export async function GET(_req: Request, ctx: RouteContext<"/api/conversations/[id]">) {
  try {
    const id = await idFrom(ctx);
    const { supabase, user } = await requireUser();
    return NextResponse.json(await getConversation(supabase, user.id, id));
  } catch (err) {
    return errorResponse(err);
  }
}

/** PATCH — rename, change mode, or move to a project. */
export async function PATCH(req: Request, ctx: RouteContext<"/api/conversations/[id]">) {
  try {
    const id = await idFrom(ctx);
    const body = await parseJsonBody(req, conversationPatch, 4_000);
    const { supabase, user } = await requireUser();
    const conversation = await updateConversation(supabase, user.id, id, {
      ...(body.title !== undefined && { title: body.title }),
      ...(body.mode !== undefined && { mode: body.mode }),
      ...(body.projectId !== undefined && { project_id: body.projectId }),
    });
    return NextResponse.json({ conversation });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: Request, ctx: RouteContext<"/api/conversations/[id]">) {
  try {
    const id = await idFrom(ctx);
    const { supabase, user } = await requireUser();
    await deleteConversation(supabase, user.id, id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
