import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonBody } from "@/lib/http";
import { requestCancel, retryTask, reworkTask, setPaused } from "@/lib/workforce/commander";
import { requireOperator, wfError } from "@/lib/workforce/server";

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("cancel") }),
  z.object({ action: z.literal("retry") }),
  z.object({ action: z.literal("pause") }),
  z.object({ action: z.literal("resume") }),
  z.object({ action: z.literal("rework"), note: z.string().trim().max(2000).default("") }),
]);

/** POST /api/workforce/tasks/[id]/action — operator controls, all audited. */
export async function POST(req: Request, ctx: RouteContext<"/api/workforce/tasks/[id]/action">) {
  try {
    const { rt } = await requireOperator();
    const { id } = await ctx.params;
    const b = await parseJsonBody(req, body);
    if (b.action === "cancel") await requestCancel(rt, id);
    else if (b.action === "retry") await retryTask(rt, id);
    else if (b.action === "pause") await setPaused(rt, id, true);
    else if (b.action === "resume") await setPaused(rt, id, false);
    else await reworkTask(rt, id, b.note);
    const task = await rt.store.getTask(id);
    return NextResponse.json({ status: task?.status });
  } catch (err) {
    return wfError(err);
  }
}
