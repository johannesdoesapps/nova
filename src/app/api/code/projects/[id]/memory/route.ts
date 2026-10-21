import { NextResponse } from "next/server";
import { memoryInput } from "@/lib/code/memory";
import { addMemory, listMemory } from "@/lib/code/memory-store";
import { codeContext, getProjectRow } from "@/lib/code/server";
import { errorResponse, parseJsonBody, requireUuid } from "@/lib/http";

type Ctx = RouteContext<"/api/code/projects/[id]/memory">;

/** GET /api/code/projects/[id]/memory — the project's notes and workflows, including suggestions waiting for approval. */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const id = requireUuid((await ctx.params).id);
    const auth = await codeContext();
    await getProjectRow(auth, id);
    return NextResponse.json({ memory: await listMemory(auth, id) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/code/projects/[id]/memory — add a note (the user's own, so it's active at once). */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const id = requireUuid((await ctx.params).id);
    const body = await parseJsonBody(req, memoryInput, 12_000);
    const auth = await codeContext();
    await getProjectRow(auth, id);
    return NextResponse.json({ entry: await addMemory(auth, id, body) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
