import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { deleteNote } from "@/lib/db";
import { ApiError, errorResponse } from "@/lib/http";
import { uuid } from "@/lib/validation";

/** DELETE /api/notes/[id] */
export async function DELETE(_req: Request, ctx: RouteContext<"/api/notes/[id]">) {
  try {
    const { id } = await ctx.params;
    if (!uuid.safeParse(id).success) throw new ApiError("not_found", "Note not found.");
    const { supabase, user } = await requireUser();
    await deleteNote(supabase, user.id, id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
