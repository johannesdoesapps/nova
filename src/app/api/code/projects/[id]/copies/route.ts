import { NextResponse } from "next/server";
import { z } from "zod";
import { createCopy, listCopies } from "@/lib/code/copies";
import { codeContext } from "@/lib/code/server";
import { errorResponse, parseJsonBody, requireUuid } from "@/lib/http";

type Ctx = RouteContext<"/api/code/projects/[id]/copies">;

/** GET /api/code/projects/[id]/copies — the project's parallel copies. */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const id = requireUuid((await ctx.params).id);
    const auth = await codeContext("code-ws", 120);
    return NextResponse.json({ copies: await listCopies(auth, id) });
  } catch (err) {
    return errorResponse(err);
  }
}

const body = z.object({ task: z.string().trim().min(1).max(200) });

/** POST /api/code/projects/[id]/copies — make a parallel copy of the project for a task (merge it back when done). */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const id = requireUuid((await ctx.params).id);
    const { task } = await parseJsonBody(req, body, 2_000);
    const auth = await codeContext("code-ws", 10);
    return NextResponse.json({ project: await createCopy(auth, id, task) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
