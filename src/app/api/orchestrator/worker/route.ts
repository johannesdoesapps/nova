import { randomUUID } from "node:crypto";
import { after, NextResponse } from "next/server";
import { productionWorkerDeps, WORKER_BUDGET_MS, workerAuthorized } from "@/lib/orchestrator/background";
import { runWorker } from "@/lib/orchestrator/worker";
import { ApiError, errorResponse } from "@/lib/http";
import { reportError } from "@/lib/observability";

// One worker call runs attempts for up to WORKER_BUDGET_MS, then hands over to a fresh call.
export const maxDuration = 300;

/**
 * POST /api/orchestrator/worker — run queued orchestrator tasks (src/lib/orchestrator/worker.ts). Called only by
 * Orbis itself, with the worker secret, and it takes no input: what to run, as whom and on which slot all come
 * from the database. It answers at once and works afterwards. However many of these run at once, the database
 * lets at most three attempts execute.
 */
export async function POST(req: Request) {
  try {
    if (!workerAuthorized(req)) throw new ApiError("unauthorized", "Not allowed.");
    const deps = productionWorkerDeps(new URL(req.url).origin);
    if (!deps) throw new ApiError("not_configured", "The orchestrator's worker isn't configured.");
    const workerId = `w-${randomUUID()}`;
    after(() => runWorker(deps, { workerId, budgetMs: WORKER_BUDGET_MS }).catch((err) => reportError(err, { where: "orchestrator.worker" })));
    return NextResponse.json({ accepted: true }, { status: 202 });
  } catch (err) {
    return errorResponse(err);
  }
}
