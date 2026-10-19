import { NextResponse } from "next/server";
import { parseJsonBody } from "@/lib/http";
import { createTask } from "@/lib/workforce/commander";
import { requireOperator, taskCreateSchema, wfError } from "@/lib/workforce/server";

/** GET /api/workforce/tasks */
export async function GET() {
  try {
    const { store } = await requireOperator();
    const tasks = await store.listTasks({ limit: 200 });
    return NextResponse.json({ tasks: tasks.map((t) => ({ ...t, diff: undefined, report: undefined })) });
  } catch (err) {
    return wfError(err);
  }
}

/** POST /api/workforce/tasks — create an engineering task. Nothing runs until it is advanced. */
export async function POST(req: Request) {
  try {
    const { rt } = await requireOperator();
    const body = await parseJsonBody(req, taskCreateSchema);
    return NextResponse.json({ task: await createTask(rt, body) }, { status: 201 });
  } catch (err) {
    return wfError(err);
  }
}
