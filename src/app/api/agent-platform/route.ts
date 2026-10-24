import { NextResponse } from "next/server";
import { listAgents } from "@/lib/agent-platform/server";
import { getAuth } from "@/lib/auth";
import { errorResponse } from "@/lib/http";

/**
 * GET /api/agent-platform — the task agents, each with whether the caller can run it here (from the
 * server's configuration and the caller's plan). The same check guards starting a task.
 */
export async function GET() {
  try {
    const auth = await getAuth();
    return NextResponse.json(await listAgents(auth), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
