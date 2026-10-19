import "server-only";
import { getProvider, resolveModel, withTimeout } from "../ai";
import { estimateCost, estimateTokens } from "../ai/cost";
import { isAutoId } from "../ai/platform";
import type { ChatMessage, Usage } from "../ai/types";
import { requireUserIfConfigured } from "../auth";
import { withTimeContext } from "../ai/turn-context";
import { ApiError, ndjsonStream } from "../http";
import { enforceLimits, recordRunLater } from "../usage";

/**
 * One model call for Council or Arena, streamed as NDJSON:
 * meta → delta… → done (latency, usage, cost when known) | error.
 * Each call is authorised, counted against the user's allowance and logged
 * like a normal chat message, so multi-model work is never "free" or hidden.
 */
export async function streamStep(
  req: Request,
  opts: { modelId: string; messages: ChatMessage[]; purpose: string; prompt: string; maxOutputTokens: number },
): Promise<Response> {
  if (isAutoId(opts.modelId)) throw new ApiError("bad_request", "Choose specific models for Council and Arena.");
  const auth = await requireUserIfConfigured();
  const model = await resolveModel(opts.modelId);
  await enforceLimits(req, auth, 1, [model], { purpose: opts.purpose, inputTokens: estimateTokens(opts.messages) + 300, maxOutputTokens: opts.maxOutputTokens });
  const messages = withTimeContext(opts.messages, req);

  return ndjsonStream(async (send, signal) => {
    send({ type: "meta", model: { id: model.id, displayName: model.displayName, provider: model.provider } });
    const started = performance.now();
    let text = "";
    let usage: Usage | null = null;
    let servedModel: string | null = null;
    let status: "success" | "error" = "success";
    try {
      for await (const ev of getProvider(model.provider).stream({
        model,
        messages,
        maxOutputTokens: opts.maxOutputTokens,
        signal: withTimeout(55_000, signal),
      })) {
        if (ev.type === "delta") {
          text += ev.text;
          send({ type: "delta", text: ev.text });
        } else if (ev.type === "usage") usage = ev.usage;
        else servedModel = ev.servedModel;
      }
    } catch (err) {
      status = "error";
      throw err;
    } finally {
      usage ??= { inputTokens: estimateTokens(messages), outputTokens: estimateTokens(text), estimated: true };
      recordRunLater(auth, {
        model,
        prompt: opts.prompt.slice(0, 4000),
        response: text,
        latencyMs: performance.now() - started,
        usage,
        status,
        purpose: opts.purpose,
        servedModel,
      });
    }
    send({
      type: "done",
      text,
      latencyMs: Math.round(performance.now() - started),
      usage,
      estimatedCost: estimateCost(model, usage),
      servedModel,
      simulated: model.provider === "demo",
    });
  }, req.signal);
}
