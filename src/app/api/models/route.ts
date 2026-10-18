import { NextResponse } from "next/server";
import { z } from "zod";
import { getModels } from "@/lib/ai";
import { getPlatformSettings } from "@/lib/ai/settings";
import { recommendModel } from "@/lib/ai/router";
import { errorResponse, parseQuery } from "@/lib/http";

const query = z.object({
  prompt: z.string().max(100_000).optional(),
  mode: z.string().max(20).optional(),
  costSensitive: z.enum(["true", "false"]).optional(),
});

/** GET /api/models — the model registry with availability; add ?prompt= for a recommendation. */
export async function GET(req: Request) {
  try {
    const q = parseQuery(req.url, query);
    const settings = await getPlatformSettings();
    const models = await getModels(settings);
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
