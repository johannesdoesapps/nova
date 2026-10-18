import { NextResponse } from "next/server";
import { getModels } from "@/lib/ai";
import { recommendModel } from "@/lib/ai/router";
import { requireUserIfConfigured } from "@/lib/auth";
import { listBenchmarkRuns, listTrials } from "@/lib/db/research";
import { serverEnv } from "@/lib/env";
import { generateWithFallback } from "@/lib/intel/execute";
import { computeFingerprint } from "@/lib/intel/fingerprint";
import { parsePrivacyProfiles } from "@/lib/intel/profiles";
import { planRoute } from "@/lib/intel/routing";
import type { BenchmarkRun, TrialRecord } from "@/lib/intel/types";
import { errorResponse, parseJsonBody } from "@/lib/http";
import { enforceLimits } from "@/lib/usage";
import { routeRequest } from "@/lib/validation-research";

export const maxDuration = 60;

/**
 * POST /api/intel/route — plan (and optionally execute) a route for a prompt:
 * hard constraints first (privacy, price, latency, providers), then the user's
 * own evidence when sufficient, else the published rules. With execute=true,
 * the plan runs with automatic fallbacks and every attempt is reported.
 */
export async function POST(req: Request) {
  try {
    const body = await parseJsonBody(req, routeRequest, 1_500_000);
    const auth = await requireUserIfConfigured();
    const models = await getModels();

    let trials: TrialRecord[] = [];
    let benchmarks: BenchmarkRun[] = [];
    if (auth.mode === "authenticated") {
      [trials, benchmarks] = await Promise.all([listTrials(auth.supabase, auth.user.id), listBenchmarkRuns(auth.supabase, auth.user.id)]);
    } else if (body.history) {
      trials = body.history.trials as TrialRecord[];
      benchmarks = body.history.benchmarks as BenchmarkRun[];
    }
    const fingerprint = trials.length || benchmarks.length ? computeFingerprint({ trials, benchmarks, models }, { now: new Date().toISOString() }) : null;
    const rules = recommendModel(models, body.prompt, { mode: body.mode, costSensitive: body.constraints.maxPricePer1M != null });
    const plan = planRoute({
      prompt: body.prompt,
      mode: body.mode,
      category: body.category,
      models,
      fingerprint,
      privacyProfiles: parsePrivacyProfiles(serverEnv().privacyProfilesJson),
      constraints: body.constraints,
      rulesPick: rules.model?.id ?? null,
    });

    if (!body.execute || !plan.primary) return NextResponse.json({ plan });

    await enforceLimits(req, auth, 1);
    const chain = [plan.primary, ...plan.fallbacks].map((id) => models.find((m) => m.id === id)!).filter(Boolean);
    const { outcome, attempts } = await generateWithFallback(
      auth,
      chain,
      [
        { role: "system", content: "You are a helpful assistant. Answer accurately and concisely. Do not invent facts, citations or numbers." },
        { role: "user", content: body.prompt },
      ],
      { maxOutputTokens: 1500, signal: req.signal, purpose: "route", category: plan.category, prompt: body.prompt },
    );
    return NextResponse.json({
      plan,
      attempts,
      result: outcome && {
        modelId: outcome.model.id,
        displayName: outcome.model.displayName,
        text: outcome.result.text,
        simulated: outcome.result.simulated,
        servedModel: outcome.result.servedModel ?? null,
        latencyMs: outcome.latencyMs,
        cost: outcome.cost,
        usage: outcome.usage,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
