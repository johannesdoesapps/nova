import { NextResponse } from "next/server";
import { getAllModels } from "@/lib/ai";
import { RETIRED_MODELS } from "@/lib/ai/registry";
import { requireUser } from "@/lib/auth";
import { deleteConversation, getConversation, setPinned, updateConversation } from "@/lib/db";
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
    const [data, models] = await Promise.all([getConversation(supabase, user.id, id), getAllModels().catch(() => [])]);
    // Saved replies store the model id; show the same name the live reply showed.
    const names = new Map([...Object.entries(RETIRED_MODELS).map(([id, r]) => [id, r.displayName] as const), ...models.map((m) => [m.id, m.displayName] as const)]);
    const messages = data.messages.map((m) => ({ ...m, model_name: m.model_id ? (names.get(m.model_id) ?? null) : null }));
    return NextResponse.json({ ...data, messages });
  } catch (err) {
    return errorResponse(err);
  }
}

/** PATCH — rename, change mode, move to a project, archive / unarchive, or pin / unpin. */
export async function PATCH(req: Request, ctx: RouteContext<"/api/conversations/[id]">) {
  try {
    const id = await idFrom(ctx);
    const { pinned, ...body } = await parseJsonBody(req, conversationPatch, 4_000);
    const { supabase, user } = await requireUser();
    const patch = {
      ...(body.title !== undefined && { title: body.title }),
      ...(body.mode !== undefined && { mode: body.mode }),
      ...(body.projectId !== undefined && { project_id: body.projectId }),
      ...(body.archived !== undefined && { archived_at: body.archived ? new Date().toISOString() : null }),
    };
    // Pins are checked against the user's own chats before they are saved.
    const pins = pinned !== undefined ? await setPinned(supabase, user.id, id, pinned) : null;
    const conversation = Object.keys(patch).length ? await updateConversation(supabase, user.id, id, patch) : null;
    return NextResponse.json({ conversation, ...(pins && { pinned: pins.includes(id) }) });
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
