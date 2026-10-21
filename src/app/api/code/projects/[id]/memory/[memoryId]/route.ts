import { NextResponse } from "next/server";
import { memoryPatch } from "@/lib/code/memory";
import { deleteMemory, updateMemory } from "@/lib/code/memory-store";
import { codeContext } from "@/lib/code/server";
import { errorResponse, parseJsonBody, requireUuid } from "@/lib/http";

type Ctx = RouteContext<"/api/code/projects/[id]/memory/[memoryId]">;

/** PATCH /api/code/projects/[id]/memory/[memoryId] — edit a note, or approve a suggested one (status: "active"). */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const p = await ctx.params;
    const id = requireUuid(p.id);
    const memoryId = requireUuid(p.memoryId);
    const body = await parseJsonBody(req, memoryPatch, 12_000);
    const auth = await codeContext();
    return NextResponse.json({ entry: await updateMemory(auth, id, memoryId, body) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE /api/code/projects/[id]/memory/[memoryId] — delete a note, or turn down a suggestion. */
export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const p = await ctx.params;
    const id = requireUuid(p.id);
    const memoryId = requireUuid(p.memoryId);
    const auth = await codeContext();
    await deleteMemory(auth, id, memoryId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
