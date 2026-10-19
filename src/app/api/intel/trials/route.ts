import { NextResponse } from "next/server";
import { getModels } from "@/lib/ai";
import type { ChatMessage, ModelWithStatus } from "@/lib/ai/types";
import { requireUserIfConfigured } from "@/lib/auth";
import { hash } from "@/lib/claims/text";
import { randomPair, redactIdentity, secureShuffle } from "@/lib/intel/blinding";
import { callModel } from "@/lib/intel/execute";
import { seal } from "@/lib/intel/seal";
import { TRIAL_SYSTEM_PROMPT, type SealedTrial } from "@/lib/intel/trials";
import type { TrialArm } from "@/lib/intel/types";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { modelTier } from "@/lib/plans";
import { enforceLimits, planLimits } from "@/lib/usage";
import { trialStartRequest } from "@/lib/validation-research";

export const maxDuration = 60;

/**
 * POST /api/intel/trials — run one prompt on two models and return the answers
 * as "A" and "B" in random order, with model self-identification redacted.
 * Identities, latency and cost travel only inside an encrypted token and are
 * revealed after the vote.
 */
export async function POST(req: Request) {
  try {
    const body = await parseJsonBody(req, trialStartRequest, 48_000);
    const auth = await requireUserIfConfigured();
    // Only models the user's plan includes take part (an explicit pick outside it is refused by enforceLimits).
    const tiers = auth.mode === "authenticated" ? (await planLimits(auth)).tiers : null;
    const registry = await getModels();
    const available = registry.filter((m) => m.available && (!tiers || tiers.includes(modelTier(m))));

    let pair: [ModelWithStatus, ModelWithStatus] | null;
    if (body.modelIds) {
      const [a, b] = body.modelIds.map((id) => registry.find((m) => m.id === id));
      if (!a || !b) throw new ApiError("bad_request", "Unknown model.");
      if (a.id === b.id) throw new ApiError("bad_request", "Pick two different models.");
      if (!a.available || !b.available) throw new ApiError("not_configured", "Both models must be available.");
      pair = [a, b];
    } else {
      const real = available.filter((m) => m.provider !== "demo");
      pair = randomPair(real.length >= 2 ? real : available);
    }
    if (!pair) throw new ApiError("not_configured", "At least two available models are needed for a blind trial.");

    await enforceLimits(req, auth, 2, pair, { purpose: "trial" });
    const messages: ChatMessage[] = [
      { role: "system", content: TRIAL_SYSTEM_PROMPT },
      { role: "user", content: body.prompt },
    ];
    // Identical settings for both arms; answers are released together so speed doesn't unblind.
    const settled = await Promise.all(
      pair.map(async (model) => {
        try {
          const o = await callModel(auth, model, messages, { maxOutputTokens: 1500, timeoutMs: 45_000, signal: req.signal, purpose: "trial", category: body.category, prompt: body.prompt });
          return { model, ok: true as const, o };
        } catch (err) {
          return { model, ok: false as const, error: err instanceof ApiError ? err.message : "The model call failed." };
        }
      }),
    );

    const order = secureShuffle(settled);
    let redactions = 0;
    const shown: { label: "A" | "B"; text: string }[] = [];
    const arms: TrialArm[] = order.map((s, i) => {
      const label = i === 0 ? "A" : "B";
      if (s.ok) {
        const r = redactIdentity(s.o.result.text);
        redactions += r.count;
        shown.push({ label, text: r.text });
      } else shown.push({ label, text: "" });
      return {
        label,
        modelId: s.model.id,
        displayName: s.model.displayName,
        provider: s.model.provider,
        servedModel: s.ok ? (s.o.result.servedModel ?? null) : null,
        latencyMs: s.ok ? s.o.latencyMs : null,
        inputTokens: s.ok ? s.o.usage.inputTokens : null,
        outputTokens: s.ok ? s.o.usage.outputTokens : null,
        tokensEstimated: s.ok ? s.o.usage.estimated : false,
        cost: s.ok ? s.o.cost : null,
        simulated: s.ok ? s.o.result.simulated : false,
        error: s.ok ? null : s.error,
      };
    });

    if (arms.some((a) => a.error)) {
      // A one-sided trial can't measure preference; reveal immediately and record nothing.
      return NextResponse.json({ void: true, reason: "One of the models failed, so this trial can't be judged blind.", arms, shown });
    }

    const sealed: SealedTrial = {
      id: crypto.randomUUID(),
      userId: auth.mode === "authenticated" ? auth.user.id : null,
      createdAt: new Date().toISOString(),
      category: body.category,
      prompt: body.prompt,
      promptHash: hash(body.prompt),
      testItemId: body.testItemId ?? null,
      arms,
      redactions,
    };
    return NextResponse.json({
      void: false,
      token: seal(sealed),
      category: body.category,
      shown,
      redactions,
      simulated: arms.some((a) => a.simulated),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
