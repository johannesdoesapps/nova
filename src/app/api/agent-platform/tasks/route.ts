import { NextResponse } from "next/server";
import { startProfileTask, startTaskBody } from "@/lib/agent-platform/tasks";
import { codeContext } from "@/lib/code/server";
import { errorResponse, parseJsonBody } from "@/lib/http";

/**
 * POST /api/agent-platform/tasks — start a Bug Fixing or QA Testing task on one of the user's projects.
 * Signed-in users only; the agent's plan access and configuration are checked here, the project's
 * ownership by row-level security. Returns the task and where to follow it.
 */
export async function POST(req: Request) {
  try {
    const input = await parseJsonBody(req, startTaskBody, 260_000);
    const auth = await codeContext("agent-task", 20);
    return NextResponse.json(await startProfileTask(auth, input), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
