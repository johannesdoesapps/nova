import { NextResponse } from "next/server";
import { enforce } from "@/lib/bastion/server";
import { advance } from "@/lib/workforce/commander";
import { requireOperator, wfError } from "@/lib/workforce/server";
import { requireUuid } from "@/lib/http";

// One bounded tick of Orbis Commander. Long checks run detached in the
// sandbox, so ticks stay short; the dashboard calls this while a task is active.
export const maxDuration = 300;

/** POST /api/workforce/tasks/[id]/advance */
export async function POST(req: Request, ctx: RouteContext<"/api/workforce/tasks/[id]/advance">) {
  try {
    const { rt, auth } = await requireOperator();
    const id = requireUuid((await ctx.params).id);
    // Orbis Bastion: each tick is a step by the Workforce agents (suspension, lockdown and blocked capabilities apply).
    await enforce({ db: auth.supabase, userId: auth.user.id, kind: "agent", agent: "workforce", runId: id }, "workforce.step", `task ${id}`);
    const r = await advance(rt, id, { budgetMs: 240_000, signal: req.signal });
    return NextResponse.json({ status: r.task.status, ran: r.ran, note: r.note });
  } catch (err) {
    return wfError(err);
  }
}
