import { after, NextResponse } from "next/server";
import { z } from "zod";
import { kickOrchestrator } from "@/lib/orchestrator/background";
import { createTask, listTasks, requireOrchestrator } from "@/lib/orchestrator/server";
import { taskCreateSchema, TASK_STATUSES } from "@/lib/orchestrator/types";
import { errorResponse, parseJsonBody, parseQuery } from "@/lib/http";

const query = z.object({
  status: z.enum(TASK_STATUSES).optional(),
  projectId: z.uuid().optional(),
  agentId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** GET /api/orchestrator/tasks?status=&projectId=&agentId=&limit= — the administrator's tasks, newest first. */
export async function GET(req: Request) {
  try {
    const f = parseQuery(req.url, query);
    const auth = await requireOrchestrator();
    return NextResponse.json({ tasks: await listTasks(auth, f) });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/orchestrator/tasks — queue a task (kind "execute") or a planning task (kind "plan", which a lead agent
 * breaks into sub-tasks). It's queued, not run: a worker starts it when one of the global execution slots is free.
 */
export async function POST(req: Request) {
  try {
    const auth = await requireOrchestrator(30);
    const input = await parseJsonBody(req, taskCreateSchema, 60_000);
    const task = await createTask(auth, input);
    const origin = new URL(req.url).origin;
    after(() => kickOrchestrator(origin));
    return NextResponse.json({ task }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
