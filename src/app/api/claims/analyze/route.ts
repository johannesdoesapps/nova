import { NextResponse } from "next/server";
import { getProvider, resolveModel, withTimeout } from "@/lib/ai";
import { estimateTokens } from "@/lib/ai/cost";
import { requireUserIfConfigured } from "@/lib/auth";
import { extractClaims } from "@/lib/claims/extract";
import { buildJudgeMessages, parseJudgements, promptHash } from "@/lib/claims/llm";
import { runClaimPipeline } from "@/lib/claims/pipeline";
import { buildSource } from "@/lib/claims/sources";
import type { ModelJudgement, PipelineInput } from "@/lib/claims/types";
import { saveClaimReport } from "@/lib/db/research";
import { errorResponse, parseJsonBody } from "@/lib/http";
import { reportError } from "@/lib/observability";
import { enforceLimits, recordRunLater } from "@/lib/usage";
import { claimsAnalyzeRequest } from "@/lib/validation-research";

export const maxDuration = 60;

/**
 * POST /api/claims/analyze — break an answer into claims and link each to
 * evidence in the supplied sources. Rule-based checks always run (free,
 * deterministic). In "model" mode a model also judges claim–source pairs; its
 * judgements only count when its quotes are found verbatim in the sources.
 */
export async function POST(req: Request) {
  try {
    const body = await parseJsonBody(req, claimsAnalyzeRequest, 700_000);
    const auth = await requireUserIfConfigured();
    const now = new Date().toISOString();
    const notices: string[] = [];

    let modelJudgements: ModelJudgement[] = [];
    let modelMeta: PipelineInput["modelMeta"];
    let modelId: string | null = null;

    if (body.mode === "model") {
      const model = await resolveModel(body.modelId);
      await enforceLimits(req, auth, 1, [model], { purpose: "claims", inputTokens: Math.ceil(JSON.stringify(body).length / 4) + 1000 });
      modelId = model.id;
      if (model.provider === "demo") {
        notices.push("Demo mode: no real model is configured, so only rule-based checks were applied.");
      } else if (body.sources.length === 0) {
        notices.push("No sources were provided, so there was nothing for the model to judge against.");
      } else {
        const claims = extractClaims(body.answer).claims;
        const sources = body.sources.map((s, i) => buildSource(s, i, now));
        const messages = buildJudgeMessages(claims, sources);
        const started = performance.now();
        try {
          const r = await getProvider(model.provider).generate({ model, messages, maxOutputTokens: 4000, temperature: 0, signal: withTimeout(50_000, req.signal) });
          const durationMs = Math.round(performance.now() - started);
          const parsed = parseJudgements(r.text);
          if (parsed.error) notices.push(parsed.error);
          modelJudgements = parsed.judgements;
          modelMeta = { servedModel: r.servedModel ?? null, temperature: 0, promptHash: promptHash(messages), durationMs };
          recordRunLater(auth, {
            model,
            prompt: `[claim-dna judge] ${body.question}`.slice(0, 400),
            response: r.text,
            latencyMs: durationMs,
            usage: r.usage.inputTokens === null ? { inputTokens: estimateTokens(messages), outputTokens: estimateTokens(r.text), estimated: true } : r.usage,
            status: "success",
            purpose: "claims",
            category: "research",
            servedModel: r.servedModel ?? null,
          });
        } catch (err) {
          reportError(err, { where: "claims.judge" });
          notices.push("The model call failed, so only rule-based checks were applied.");
        }
      }
    }

    const report = runClaimPipeline({
      question: body.question,
      answer: body.answer,
      sources: body.sources,
      now,
      mode: body.mode,
      modelId,
      modelJudgements,
      modelMeta,
    });

    let saved = false;
    if (body.save && auth.mode === "authenticated") {
      try {
        await saveClaimReport(auth.supabase, auth.user.id, report, body.projectId);
        saved = true;
      } catch (err) {
        reportError(err, { where: "saveClaimReport" });
        notices.push("The report could not be saved, but you can still review it here.");
      }
    }
    return NextResponse.json({ report, saved, notices });
  } catch (err) {
    return errorResponse(err);
  }
}
