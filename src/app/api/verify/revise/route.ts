import { NextResponse } from "next/server";
import { getProvider, resolveModelChoice, withTimeout } from "@/lib/ai";
import { estimateCost } from "@/lib/ai/cost";
import { isAutoId } from "@/lib/ai/platform";
import { requireUserIfConfigured } from "@/lib/auth";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { enforceLimits, planLimits, recordRun, shouldSaveAllowance } from "@/lib/usage";
import { buildReviseMessages } from "@/lib/verify/revise";
import { reviseRequest } from "@/lib/verify/schema";

export const maxDuration = 60;

/** POST /api/verify/revise — a revised answer that keeps supported claims, fixes or flags the rest, and cites only the sources that were checked. */
export async function POST(req: Request) {
  try {
    const body = await parseJsonBody(req, reviseRequest, 200_000);
    const auth = await requireUserIfConfigured();
    const requested = body.modelId ?? "auto";
    const { model } = await resolveModelChoice(requested, {
      prompt: body.answer.slice(0, 2000),
      mode: "critic",
      preferLowCost: isAutoId(requested) ? await shouldSaveAllowance(auth) : false,
      tiers: (await planLimits(auth)).tiers,
    });
    if (model.provider === "demo") throw new ApiError("not_configured", "Writing a revised answer needs a real AI model. An administrator can add one in Admin.");
    const { messages, sources } = buildReviseMessages(body);
    await enforceLimits(req, auth, 1, [model], { purpose: "verify", inputTokens: Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4), maxOutputTokens: 3000 });
    const started = performance.now();
    const base = {
      model,
      prompt: `[revise] ${body.question || body.answer}`.slice(0, 400),
      purpose: "verify" as const,
      requestedModel: body.modelId ?? null,
      routingReason: "Revised answer after a source check",
    };
    let r;
    try {
      r = await getProvider(model.provider).generate({ model, messages, maxOutputTokens: 3000, temperature: 0.2, signal: withTimeout(50_000, req.signal) });
    } catch (err) {
      await recordRun(auth, {
        ...base,
        response: "",
        latencyMs: performance.now() - started,
        usage: { inputTokens: null, outputTokens: null, estimated: true },
        status: "error",
        error: err instanceof Error ? err.message : "failed",
      });
      throw err;
    }
    await recordRun(auth, { ...base, response: r.text, latencyMs: performance.now() - started, usage: r.usage, status: "success" });
    if (!r.text.trim()) throw new ApiError("upstream_error", "The model returned an empty reply. Try again or choose another model.");
    return NextResponse.json({ revised: r.text, sources, model: { id: model.id, displayName: model.displayName }, estimatedCost: estimateCost(model, r.usage) });
  } catch (err) {
    return errorResponse(err);
  }
}
