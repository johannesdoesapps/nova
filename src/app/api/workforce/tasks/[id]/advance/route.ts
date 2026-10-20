import { NextResponse } from "next/server";
import { advance } from "@/lib/workforce/commander";
import { requireOperator, wfError } from "@/lib/workforce/server";
import { requireUuid } from "@/lib/http";

// One bounded tick of Orbis Commander. Long checks run detached in the
// sandbox, so ticks stay short; the dashboard calls this while a task is active.
export const maxDuration = 300;

/** POST /api/workforce/tasks/[id]/advance */
export async function POST(req: Request, ctx: RouteContext<"/api/workforce/tasks/[id]/advance">) {
  try {
    const { rt } = await requireOperator();
    const id = requireUuid((await ctx.params).id);
    const r = await advance(rt, id, { budgetMs: 240_000, signal: req.signal });
    return NextResponse.json({ status: r.task.status, ran: r.ran, note: r.note });
  } catch (err) {
    return wfError(err);
  }
}
