import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { getModels, withTimeout } from "@/lib/ai";
import { estimateCost, estimateTokens } from "@/lib/ai/cost";
import { streamWithFallback } from "@/lib/ai/fallback";
import { systemPromptFor } from "@/lib/ai/modes";
import { buildTurnContext } from "@/lib/ai/turn-context";
import type { ChatMessage, ModelWithStatus, Usage } from "@/lib/ai/types";
import { getAuth } from "@/lib/auth";
import { ANSWER_CASES, gradeReply, summarise, type AnswerCase } from "@/lib/evals/answer-check";
import { ApiError, errorResponse, ndjsonStream, parseJsonBody } from "@/lib/http";
import { recordRun } from "@/lib/usage";

export const maxDuration = 300;

/** The same reply limit as the Pro plan, so the check sees what most paying users get. */
const MAX_OUTPUT_TOKENS = 2400;
/** Replies run a few at a time: fast enough, gentle on provider rate limits. */
const CONCURRENCY = 5;
/** Assumed reply length for the estimate shown before a run (most checks expect short replies). */
const EST_OUTPUT_TOKENS = 250;

/** The messages a chat would send for this question (default Research mode, no web, no project). */
function messagesFor(c: AnswerCase): ChatMessage[] {
  const turn = buildTurnContext(c.prompt, { timeZone: "UTC", liveSources: false });
  return [{ role: "system", content: `${systemPromptFor("research")}\n\n${turn.system}` }, ...(c.history ?? []), { role: "user", content: c.prompt }];
}

function estimate(model: ModelWithStatus): number | null {
  let total = 0;
  for (const c of ANSWER_CASES) {
    const cost = estimateCost(model, { inputTokens: estimateTokens(messagesFor(c)), outputTokens: EST_OUTPUT_TOKENS });
    if (cost === null) return null;
    total += cost;
  }
  return Math.round(total * 10000) / 10000;
}

async function usableModels(): Promise<ModelWithStatus[]> {
  return (await getModels()).filter((m) => m.available);
}

/** GET — the models the check can run on, each with an estimated cost for one run. */
export async function GET() {
  try {
    await requireAdmin(await getAuth());
    const models = await usableModels();
    return NextResponse.json(
      { cases: ANSWER_CASES.length, models: models.map((m) => ({ id: m.id, displayName: m.displayName, provider: m.provider, estimatedUsd: estimate(m) })) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err);
  }
}

const body = z.object({ modelId: z.string().min(1).max(120) });

/**
 * POST — run every question once on one model and grade each reply. Streams a
 * line per question, then a summary. Costs real money (shown before running);
 * each call is recorded like any other model run, without using the admin's allowance.
 */
export async function POST(req: Request) {
  try {
    const auth = await requireAdmin(await getAuth());
    const { modelId } = await parseJsonBody(req, body, 1_000);
    const model = (await usableModels()).find((m) => m.id === modelId);
    if (!model) throw new ApiError("bad_request", "That model isn't available.");
    if (model.provider === "demo") throw new ApiError("bad_request", "Demo models give simulated replies, so checking them measures nothing.");

    return ndjsonStream(async (send, signal) => {
      send({ type: "start", total: ANSWER_CASES.length, model: { id: model.id, displayName: model.displayName } });
      const graded: { category: AnswerCase["category"]; pass: boolean }[] = [];
      let costUsd = 0;
      let next = 0;
      const worker = async () => {
        while (next < ANSWER_CASES.length && !signal.aborted) {
          const c = ANSWER_CASES[next++]!;
          const messages = messagesFor(c);
          const started = performance.now();
          let text = "";
          let usage: Usage | null = null;
          let error: string | null = null;
          try {
            for await (const ev of streamWithFallback(model, [], { messages, maxOutputTokens: MAX_OUTPUT_TOKENS }, () => withTimeout(60_000, signal))) {
              if (ev.type === "delta") text += ev.text;
              else if (ev.type === "usage") usage = ev.usage;
            }
          } catch (err) {
            error = err instanceof ApiError ? err.message : "The model call failed.";
          }
          usage ??= { inputTokens: estimateTokens(messages), outputTokens: estimateTokens(text), estimated: true };
          const cost = estimateCost(model, usage) ?? 0;
          costUsd += cost;
          await recordRun(auth, {
            model,
            prompt: c.prompt,
            response: text,
            latencyMs: performance.now() - started,
            usage,
            status: error ? "error" : "success",
            purpose: "answer-check",
            auxiliary: true,
            error,
          });
          const g = gradeReply(c, error ? "" : text);
          graded.push(g);
          send({ type: "result", ...g, prompt: c.prompt, reply: text, error, latencyMs: Math.round(performance.now() - started), costUsd: cost });
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      send({ type: "done", summary: summarise(graded), costUsd: Math.round(costUsd * 10000) / 10000 });
    }, req.signal);
  } catch (err) {
    return errorResponse(err);
  }
}
