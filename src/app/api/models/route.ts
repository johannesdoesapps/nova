import { NextResponse } from "next/server";
import { z } from "zod";
import { getModels } from "@/lib/ai";
import { getPlatformSettings } from "@/lib/ai/settings";
import { recommendModel } from "@/lib/ai/router";
import { errorResponse, parseQuery } from "@/lib/http";
import { getAuth } from "@/lib/auth";
import { entitlementFor } from "@/lib/entitlements";
import { modelTier, modelUnits, planForTier, resolveBilling } from "@/lib/plans";

const query = z.object({
  prompt: z.string().max(100_000).optional(),
  mode: z.string().max(20).optional(),
  costSensitive: z.enum(["true", "false"]).optional(),
});

/** GET /api/models — the model registry with availability and plan access; add ?prompt= for a recommendation. */
export async function GET(req: Request) {
  try {
    const q = parseQuery(req.url, query);
    const settings = await getPlatformSettings();
    const [registry, auth] = await Promise.all([getModels(settings), getAuth()]);
    const entitlement = await entitlementFor(auth);
    const billing = entitlement?.billing ?? resolveBilling(settings.billing);
    const allowed = entitlement?.kind === "unlimited" ? null : (entitlement?.limits.tiers ?? billing.plans.free.tiers);
    // Each model's tier, the plan that includes it, and whether the caller's plan does.
    const models = registry.map((m) => {
      const tier = modelTier(m);
      // Units: how much of the allowance one message to this model uses (shown before multi-model runs).
      return { ...m, tier, units: modelUnits(m, settings.modelUnits?.[m.id], billing.tierUnits), requiredPlan: planForTier(billing, tier), locked: !!allowed && !allowed.includes(tier) };
    });
    const realAvailable = models.some((m) => m.available && m.provider !== "demo");
    const auto = !settings.autoEnabled
      ? { enabled: false, reason: "Auto mode is turned off by the site administrator." }
      : !realAvailable
        ? { enabled: false, reason: "Auto mode needs at least one configured AI provider." }
        : { enabled: true, reason: null };
    const recommendation =
      q.prompt !== undefined
        ? recommendModel(models, q.prompt, { mode: q.mode, costSensitive: q.costSensitive === "true" })
        : null;
    return NextResponse.json(
      {
        models,
        auto,
        defaultModelId: models.find((m) => m.isDefault)?.id ?? null,
        recommendation: recommendation && {
          modelId: recommendation.model?.id ?? null,
          task: recommendation.task,
          explanation: recommendation.explanation,
          disclaimer: recommendation.disclaimer,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
