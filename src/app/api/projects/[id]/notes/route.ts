import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { addNote } from "@/lib/db";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { noteCreate, uuid } from "@/lib/validation";

/** POST /api/projects/[id]/notes — add a note or a saved AI answer to a project. */
export async function POST(req: Request, ctx: RouteContext<"/api/projects/[id]/notes">) {
  try {
    const { id } = await ctx.params;
    if (!uuid.safeParse(id).success) throw new ApiError("not_found", "Project not found.");
    const body = await parseJsonBody(req, noteCreate, 120_000);
    const { supabase, user } = await requireUser();
    const note = await addNote(supabase, user.id, id, body);
    return NextResponse.json({ note }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
