import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import type { Arena } from "@/lib/claims/hypothesis";
import { deleteArena, saveArena } from "@/lib/db/research";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { uuid } from "@/lib/validation";
import { storedArena } from "@/lib/validation-research";

type Ctx = RouteContext<"/api/claims/arenas/[id]">;

export async function PUT(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    if (!uuid.safeParse(id).success) throw new ApiError("bad_request", "Invalid arena id.");
    const body = await parseJsonBody(req, storedArena, 500_000);
    if (body.id !== id) throw new ApiError("bad_request", "Arena id does not match the URL.");
    const auth = await requireUser();
    await saveArena(auth.supabase, auth.user.id, body as unknown as Arena);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    if (!uuid.safeParse(id).success) throw new ApiError("bad_request", "Invalid arena id.");
    const auth = await requireUser();
    await deleteArena(auth.supabase, auth.user.id, id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
