import { improveMessages } from "@/lib/council/prompts";
import { streamStep } from "@/lib/council/run";
import { councilImproveRequest } from "@/lib/council/schema";
import { errorResponse, parseJsonBody } from "@/lib/http";

export const maxDuration = 60;

/** POST /api/council/improve — ask a model to improve one chosen answer (Arena). */
export async function POST(req: Request) {
  try {
    const b = await parseJsonBody(req, councilImproveRequest, 64_000);
    return await streamStep(req, {
      modelId: b.modelId,
      messages: improveMessages(b.question, b.response, b.instruction),
      purpose: "arena-improve",
      prompt: b.question,
      maxOutputTokens: 2400,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
