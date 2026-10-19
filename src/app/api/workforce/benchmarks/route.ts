import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, parseJsonBody } from "@/lib/http";
import { createTask } from "@/lib/workforce/commander";
import { BENCHMARKS } from "@/lib/workforce/metrics";
import { requireOperator, wfError } from "@/lib/workforce/server";

const body = z.object({ projectId: z.uuid(), suite: z.string().max(40), autonomy: z.enum(["collaborate", "execute"]).default("execute") });

/** GET /api/workforce/benchmarks — available suites. */
export async function GET() {
  try {
    await requireOperator();
    return NextResponse.json({ suites: Object.entries(BENCHMARKS).map(([id, tasks]) => ({ id, tasks: tasks.map((t) => t.title) })) });
  } catch (err) {
    return wfError(err);
  }
}

/** POST /api/workforce/benchmarks — create the suite's tasks (tagged) against a project. */
export async function POST(req: Request) {
  try {
    const { rt } = await requireOperator();
    const b = await parseJsonBody(req, body);
    const suite = BENCHMARKS[b.suite];
    if (!suite) throw new ApiError("not_found", "Unknown benchmark suite.");
    const tasks = [];
    for (const t of suite) tasks.push(await createTask(rt, { projectId: b.projectId, title: `[${b.suite}] ${t.title}`, objective: t.objective, acceptanceCriteria: t.criteria, priority: "low", autonomy: b.autonomy, benchmark: b.suite }));
    return NextResponse.json({ tasks }, { status: 201 });
  } catch (err) {
    return wfError(err);
  }
}
