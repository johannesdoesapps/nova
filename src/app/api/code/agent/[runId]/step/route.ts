import { NextResponse } from "next/server";
import { z } from "zod";
import { stepRun } from "@/lib/code/agent/engine";
import { watchRun, type LiveMessage } from "@/lib/code/agent/live";
import { codeContext } from "@/lib/code/server";
import { errorResponse, parseJsonBody, requireUuid } from "@/lib/http";

// A step is one model call plus at most one command (up to 2 minutes); a request takes more steps while it's young.
export const maxDuration = 300;

const body = z.object({ expectStep: z.number().int().min(0).max(1_000).optional() });

/** How often a quiet stream sends a line, so proxies don't close it during a long command. */
const PING_MS = 15_000;

/**
 * POST /api/code/agent/[runId]/step — let the agent take its next step(s).
 * `expectStep` is the step count the page last saw; if the run has moved on
 * since (the request was retried), nothing runs again.
 *
 * With `Accept: application/x-ndjson`, the answer is a stream of JSON lines while the steps run: `step` (a step
 * starts), `text` (the model's words as it writes them), `model_done`, `events` (activity as it's saved), `ping`,
 * then `done` with the same result as the plain JSON answer, or `error` with the usual error body and status.
 * The page closing the stream doesn't stop the step (the model call isn't tied to the request).
 */
export async function POST(req: Request, ctx: RouteContext<"/api/code/agent/[runId]/step">) {
  try {
    const runId = requireUuid((await ctx.params).runId);
    const input = req.headers.get("content-length") === "0" ? {} : await parseJsonBody(req, body, 1_000).catch(() => ({}));
    const auth = await codeContext("code-agent-step", 30);
    if (!req.headers.get("accept")?.includes("application/x-ndjson")) return NextResponse.json(await stepRun(req, auth, runId, input));

    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let open = true;
        const send = (m: LiveMessage | Record<string, unknown>) => {
          if (!open) return;
          try {
            controller.enqueue(enc.encode(`${JSON.stringify(m)}\n`));
          } catch {
            open = false; // the page went away; the step carries on
          }
        };
        const unwatch = watchRun(runId, send);
        const ping = setInterval(() => send({ t: "ping" }), PING_MS);
        try {
          send({ t: "done", result: await stepRun(req, auth, runId, input) });
        } catch (err) {
          const res = errorResponse(err);
          send({ t: "error", status: res.status, body: await res.json().catch(() => ({})) });
        } finally {
          clearInterval(ping);
          unwatch();
          if (open) controller.close();
        }
      },
    });
    return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store, no-transform", "x-accel-buffering": "no" } });
  } catch (err) {
    return errorResponse(err);
  }
}
