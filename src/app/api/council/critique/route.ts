import { critiqueMessages } from "@/lib/council/prompts";
import { streamStep } from "@/lib/council/run";
import { councilCritiqueRequest } from "@/lib/council/schema";
import { errorResponse, parseJsonBody } from "@/lib/http";

export const maxDuration = 60;

/** POST /api/council/critique — a model reviews all answers and writes an improved one (Deep mode). */
export async function POST(req: Request) {
  try {
    const b = await parseJsonBody(req, councilCritiqueRequest, 160_000);
    return await streamStep(req, {
      modelId: b.modelId,
      messages: critiqueMessages(b.question, b.responses, b.sources),
      purpose: "council-critique",
      prompt: b.question,
      maxOutputTokens: 3000,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
