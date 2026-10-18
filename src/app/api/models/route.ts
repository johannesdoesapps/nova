import { NextResponse } from "next/server";
import { z } from "zod";
import { getModels } from "@/lib/ai";
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
    const models = await getModels();
    const recommendation =
      q.prompt !== undefined
        ? recommendModel(models, q.prompt, { mode: q.mode, costSensitive: q.costSensitive === "true" })
        : null;
    return NextResponse.json(
      {
        models,
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
