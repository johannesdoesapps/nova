import { NextResponse } from "next/server";
import { reverifyRun } from "@/lib/code/agent/engine";
import { codeContext } from "@/lib/code/server";
import { errorResponse, requireUuid } from "@/lib/http";

/**
 * POST /api/code/agent/[runId]/verify — re-run the checks that apply to a finished run (its tests, and a browser
 * inspection for a website). The run goes back to work in the verifying phase; the page then steps it as usual,
 * and the report is rebuilt from what the checks found.
 */
export async function POST(_req: Request, ctx: RouteContext<"/api/code/agent/[runId]/verify">) {
  try {
    const runId = requireUuid((await ctx.params).runId);
    const auth = await codeContext("code-agent", 20);
    return NextResponse.json({ run: await reverifyRun(auth, runId) });
  } catch (err) {
    return errorResponse(err);
  }
}
