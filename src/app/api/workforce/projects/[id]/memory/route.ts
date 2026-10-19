import { NextResponse } from "next/server";
import { requireOperator, wfError } from "@/lib/workforce/server";

/** GET /api/workforce/projects/[id]/memory — project knowledge with source and verification status. */
export async function GET(_req: Request, ctx: RouteContext<"/api/workforce/projects/[id]/memory">) {
  try {
    const { store } = await requireOperator();
    const { id } = await ctx.params;
    return NextResponse.json({ memory: await store.listMemory(id, 100) });
  } catch (err) {
    return wfError(err);
  }
}
