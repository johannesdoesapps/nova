import { NextResponse } from "next/server";
import { getModels } from "@/lib/ai";
import { requireUserIfConfigured } from "@/lib/auth";
import { saveBenchmarkRun } from "@/lib/db/research";
import { check } from "@/lib/intel/checkers";
import { callModel } from "@/lib/intel/execute";
import { getTestSet, testSetHash } from "@/lib/intel/testsets";
import type { BenchmarkItemResult, BenchmarkRun, TestSet } from "@/lib/intel/types";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { reportError } from "@/lib/observability";
import { enforceLimits } from "@/lib/usage";
import { benchmarkRequest } from "@/lib/validation-research";

export const maxDuration = 60;

/**
 * POST /api/intel/benchmarks — run (part of) a reproducible test set against one
 * model and score each item with its deterministic checker. Items run with a
 * fixed system prompt, temperature 0 where the provider accepts it, and a fixed
 * output cap; all of that is recorded with the run.
 */
export async function POST(req: Request) {
  try {
    const body = await parseJsonBody(req, benchmarkRequest, 200_000);
    const set: TestSet | undefined = body.testSet ? { ...body.testSet, builtIn: false } : getTestSet(body.testSetId!);
    if (!set) throw new ApiError("bad_request", "Unknown test set.");
    const model = (await getModels()).find((m) => m.id === body.modelId);
    if (!model) throw new ApiError("bad_request", "Unknown model.");
    if (!model.available) throw new ApiError("not_configured", `${model.displayName} is unavailable: ${model.unavailableReason}.`);

    const items = set.items.slice(0, body.maxItems);
    const auth = await requireUserIfConfigured();
    await enforceLimits(req, auth, items.length, Array.from({ length: items.length }, () => model), { purpose: "benchmark" });

    const maxOutputTokens = 600;
    // OpenAI's newer models reject non-default temperature, so the provider omits it; record what was actually sent.
    const temperature = model.provider === "openai" ? null : 0;
    let servedModel: string | null = null;
    let simulated = false;
    const results: BenchmarkItemResult[] = [];
    const queue = [...items];
    const worker = async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        const messages = [
          ...(set.systemPrompt ? [{ role: "system" as const, content: set.systemPrompt }] : []),
          { role: "user" as const, content: item.prompt },
        ];
        try {
          const o = await callModel(auth, model, messages, { maxOutputTokens, temperature: temperature ?? undefined, timeoutMs: 40_000, signal: req.signal, purpose: "benchmark", category: set.category, prompt: item.prompt });
          servedModel ??= o.result.servedModel ?? null;
          simulated ||= o.result.simulated;
          const c = check(item.checker, o.result.text);
          results.push({ itemId: item.id, ...c, output: o.result.text.slice(0, 4000), latencyMs: o.latencyMs, inputTokens: o.usage.inputTokens, outputTokens: o.usage.outputTokens, cost: o.cost, error: null });
        } catch (err) {
          results.push({ itemId: item.id, passed: false, score: 0, detail: "Not scored (call failed).", output: "", latencyMs: null, inputTokens: null, outputTokens: null, cost: null, error: err instanceof ApiError ? err.message : "The model call failed." });
        }
      }
    };
    await Promise.all([worker(), worker()]);
    results.sort((a, b) => items.findIndex((i) => i.id === a.itemId) - items.findIndex((i) => i.id === b.itemId));

    const run: BenchmarkRun = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      testSetId: set.id,
      testSetName: set.name,
      category: set.category,
      testSetHash: testSetHash(set),
      modelId: model.id,
      displayName: model.displayName,
      servedModel,
      params: { maxOutputTokens, temperature },
      simulated,
      results,
    };
    let saved = false;
    if (auth.mode === "authenticated") {
      try {
        await saveBenchmarkRun(auth.supabase, auth.user.id, run);
        saved = true;
      } catch (err) {
        reportError(err, { where: "saveBenchmarkRun" });
      }
    }
    return NextResponse.json({ run, saved, itemsAvailable: set.items.length });
  } catch (err) {
    return errorResponse(err);
  }
}
