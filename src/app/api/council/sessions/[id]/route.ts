import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { councilSessionInput } from "@/lib/council/schema";
import { deleteCouncilSession, getCouncilSession, updateCouncilResult } from "@/lib/db/council";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";

const id = z.uuid();
async function sessionId(ctx: RouteContext<"/api/council/sessions/[id]">) {
  const r = id.safeParse((await ctx.params).id);
  if (!r.success) throw new ApiError("not_found", "Session not found.");
  return r.data;
}

export async function GET(_req: Request, ctx: RouteContext<"/api/council/sessions/[id]">) {
  try {
    const auth = await requireUser();
    return NextResponse.json({ session: await getCouncilSession(auth.supabase, auth.user.id, await sessionId(ctx)) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** PATCH — update ratings, the preferred answer or added improvements. */
export async function PATCH(req: Request, ctx: RouteContext<"/api/council/sessions/[id]">) {
  try {
    const auth = await requireUser();
    const { result } = await parseJsonBody(req, councilSessionInput.pick({ result: true }), 420_000);
    await updateCouncilResult(auth.supabase, auth.user.id, await sessionId(ctx), result);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: Request, ctx: RouteContext<"/api/council/sessions/[id]">) {
  try {
    const auth = await requireUser();
    await deleteCouncilSession(auth.supabase, auth.user.id, await sessionId(ctx));
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
