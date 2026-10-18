import { NextResponse } from "next/server";
import { getModels, getProvider, withTimeout } from "@/lib/ai";
import { estimateCost, estimateTokens } from "@/lib/ai/cost";
import type { ChatMessage, ModelWithStatus } from "@/lib/ai/types";
import { requireUserIfConfigured } from "@/lib/auth";
import { serverEnv } from "@/lib/env";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { enforceLimits, recordRun } from "@/lib/usage";
import { compareRequest } from "@/lib/validation";

export const maxDuration = 60;

export interface CompareResult {
  modelId: string;
  displayName: string;
  provider: string;
  status: "success" | "error";
  text: string;
  error: string | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  tokensEstimated: boolean;
  estimatedCost: number | null;
  simulated: boolean;
}

/**
 * POST /api/compare — run one prompt against several models in parallel.
 * Each model fails independently. The number of models is capped by
 * NOVA_MAX_COMPARE_MODELS, and each model counts against the user's quota.
 */
export async function POST(req: Request) {
  try {
    const body = await parseJsonBody(req, compareRequest, 48_000);
    const max = serverEnv().maxCompareModels;
    const ids = [...new Set(body.modelIds)];
    if (ids.length < 2) throw new ApiError("bad_request", "Select at least two different models.");
    if (ids.length > max) throw new ApiError("bad_request", `You can compare at most ${max} models at once.`);

    const auth = await requireUserIfConfigured();
    await enforceLimits(req, auth, ids.length);

    const registry = await getModels();
    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          body.systemPrompt ??
          "You are a helpful assistant. Answer accurately and concisely. Do not invent facts, citations or numbers.",
      },
      { role: "user", content: body.prompt },
    ];

    const results = await Promise.all(
      ids.map(async (id): Promise<CompareResult> => {
        const model: ModelWithStatus | undefined = registry.find((m) => m.id === id);
        if (!model) {
          return blank(id, id, "unknown", `Unknown model "${id}".`);
        }
        if (!model.available) return blank(model.id, model.displayName, model.provider, model.unavailableReason ?? "Unavailable");
        const started = performance.now();
        try {
          const r = await getProvider(model.provider).generate({
            model,
            messages,
            maxOutputTokens: 1500,
            signal: withTimeout(45_000, req.signal),
          });
          const latencyMs = Math.round(performance.now() - started);
          const usage =
            r.usage.inputTokens === null || r.usage.outputTokens === null
              ? { inputTokens: estimateTokens(messages), outputTokens: estimateTokens(r.text), estimated: true }
              : r.usage;
          void recordRun(auth, { model, prompt: body.prompt, response: r.text, latencyMs, usage, status: "success", purpose: "compare", servedModel: r.servedModel ?? null });
          return {
            modelId: model.id,
            displayName: model.displayName,
            provider: model.provider,
            status: "success",
            text: r.text,
            error: null,
            latencyMs,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            tokensEstimated: usage.estimated,
            estimatedCost: estimateCost(model, usage),
            simulated: r.simulated,
          };
        } catch (err) {
          const latencyMs = Math.round(performance.now() - started);
          const message = err instanceof ApiError ? err.message : "The model call failed.";
          void recordRun(auth, {
            model,
            prompt: body.prompt,
            response: "",
            latencyMs,
            usage: { inputTokens: null, outputTokens: null, estimated: true },
            status: "error",
          });
          return { ...blank(model.id, model.displayName, model.provider, message), latencyMs };
        }
      }),
    );

    return NextResponse.json({ prompt: body.prompt, results, maxModels: max });
  } catch (err) {
    return errorResponse(err);
  }
}

function blank(modelId: string, displayName: string, provider: string, error: string): CompareResult {
  return {
    modelId,
    displayName,
    provider,
    status: "error",
    text: "",
    error,
    latencyMs: null,
    inputTokens: null,
    outputTokens: null,
    tokensEstimated: false,
    estimatedCost: null,
    simulated: false,
  };
}
