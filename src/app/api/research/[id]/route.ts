import { NextResponse } from "next/server";
import { codeContext } from "@/lib/code/server";
import { errorResponse, requireUuid } from "@/lib/http";
import { deleteResearch, getResearch, toView } from "@/lib/research/server";

type Ctx = RouteContext<"/api/research/[id]">;

/** GET /api/research/[id] — the run: plan, progress, notes, cited sources and the report. */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const id = requireUuid((await ctx.params).id);
    const auth = await codeContext("research-read", 240);
    return NextResponse.json({ run: toView(await getResearch(auth, id)) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE /api/research/[id] — delete the run, its notes and report. */
export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const id = requireUuid((await ctx.params).id);
    const auth = await codeContext("research-write", 60);
    await getResearch(auth, id);
    await deleteResearch(auth, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
