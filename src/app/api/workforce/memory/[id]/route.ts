import { NextResponse } from "next/server";
import { requireOperator, wfError } from "@/lib/workforce/server";

/** DELETE /api/workforce/memory/[id] — forget a memory entry. */
export async function DELETE(_req: Request, ctx: RouteContext<"/api/workforce/memory/[id]">) {
  try {
    const { store } = await requireOperator();
    const { id } = await ctx.params;
    await store.deleteMemory(id);
    await store.addEvent({ task_id: null, level: "audit", type: "memory.deleted", message: `Memory entry ${id} deleted` });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return wfError(err);
  }
}
