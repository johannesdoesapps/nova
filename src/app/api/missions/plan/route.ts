import { NextResponse } from "next/server";
import { getProvider, resolveModelChoice, withTimeout } from "@/lib/ai";
import { estimateTokens } from "@/lib/ai/cost";
import { requireUser } from "@/lib/auth";
import { errorResponse, parseJsonBody, ApiError } from "@/lib/http";
import { parsePlan, planMessages } from "@/lib/missions/prompts";
import { planRequest } from "@/lib/missions/schema";
import { enforceLimits, recordRun, shouldSaveAllowance } from "@/lib/usage";
import { withTimeContext } from "@/lib/ai/turn-context";

export const maxDuration = 60;

/**
 * POST /api/missions/plan — ask a model to break a goal into milestones and
 * tasks. Nothing is saved: the user reviews and edits the plan first.
 */
export async function POST(req: Request) {
  try {
    const body = await parseJsonBody(req, planRequest);
    const auth = await requireUser();
    // Planning uses the model the user picked, else Auto: the lowest-cost available model.
    const { model, routing } = await resolveModelChoice(body.modelId ?? "auto", { prompt: body.goal, preferLowCost: await shouldSaveAllowance(auth) });
    await enforceLimits(req, auth, 1, [model], { purpose: "mission-plan" });
    if (model.provider === "demo") throw new ApiError("not_configured", "Planning needs a real AI provider. An administrator can add one in Admin.");
    const messages = withTimeContext(planMessages(body.goal), req);
    const started = performance.now();
    const r = await getProvider(model.provider).generate({ model, messages, maxOutputTokens: 3000, signal: withTimeout(55_000, req.signal) });
    void recordRun(auth, {
      model,
      prompt: `[mission plan] ${body.goal}`.slice(0, 4000),
      response: r.text,
      latencyMs: performance.now() - started,
      usage: r.usage.inputTokens === null ? { inputTokens: estimateTokens(messages), outputTokens: estimateTokens(r.text), estimated: true } : r.usage,
      status: "success",
      purpose: "mission-plan",
      servedModel: r.servedModel ?? null,
    });
    const parsed = parsePlan(r.text);
    if ("error" in parsed) throw new ApiError("upstream_error", parsed.error);
    return NextResponse.json({ plan: parsed.plan, model: { id: model.id, displayName: model.displayName }, routing });
  } catch (err) {
    return errorResponse(err);
  }
}
