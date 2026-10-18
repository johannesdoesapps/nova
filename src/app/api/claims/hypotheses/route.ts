import { NextResponse } from "next/server";
import { getProvider, resolveModel, withTimeout } from "@/lib/ai";
import { requireUserIfConfigured } from "@/lib/auth";
import { templateHypotheses } from "@/lib/claims/hypothesis";
import { HYPOTHESIS_SYSTEM_PROMPT, parseHypotheses } from "@/lib/claims/llm";
import { errorResponse, parseJsonBody } from "@/lib/http";
import { reportError } from "@/lib/observability";
import { enforceLimits, recordRun } from "@/lib/usage";
import { hypothesesRequest } from "@/lib/validation-research";

export const maxDuration = 60;

/** POST /api/claims/hypotheses — starter hypotheses: model-generated when asked and available, else a labelled template. */
export async function POST(req: Request) {
  try {
    const body = await parseJsonBody(req, hypothesesRequest, 40_000);
    if (!body.useModel) return NextResponse.json({ hypotheses: templateHypotheses(body.question), origin: "template", notices: [] });

    const auth = await requireUserIfConfigured();
    await enforceLimits(req, auth, 1);
    const model = await resolveModel(body.modelId);
    if (model.provider === "demo")
      return NextResponse.json({ hypotheses: templateHypotheses(body.question), origin: "template", notices: ["Demo mode: showing template hypotheses instead of model-generated ones."] });

    const context = body.context?.length ? `\n\nClaims found so far (unverified):\n${body.context.map((c) => `- ${c}`).join("\n")}` : "";
    const messages = [
      { role: "system" as const, content: HYPOTHESIS_SYSTEM_PROMPT },
      { role: "user" as const, content: `Question: ${body.question}${context}` },
    ];
    const started = performance.now();
    try {
      const r = await getProvider(model.provider).generate({ model, messages, maxOutputTokens: 2000, temperature: 0.4, signal: withTimeout(45_000, req.signal) });
      void recordRun(auth, { model, prompt: body.question, response: r.text, latencyMs: performance.now() - started, usage: r.usage, status: "success", purpose: "hypotheses", category: "research", servedModel: r.servedModel ?? null });
      const hypotheses = parseHypotheses(r.text);
      if (!hypotheses) return NextResponse.json({ hypotheses: templateHypotheses(body.question), origin: "template", notices: ["The model's response could not be parsed, so template hypotheses are shown."] });
      return NextResponse.json({ hypotheses, origin: "model", modelId: model.id, notices: [] });
    } catch (err) {
      reportError(err, { where: "hypotheses" });
      return NextResponse.json({ hypotheses: templateHypotheses(body.question), origin: "template", notices: ["The model call failed, so template hypotheses are shown."] });
    }
  } catch (err) {
    return errorResponse(err);
  }
}
