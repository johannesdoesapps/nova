import { answerMessages } from "@/lib/council/prompts";
import { streamStep } from "@/lib/council/run";
import { councilAnswerRequest } from "@/lib/council/schema";
import { errorResponse, parseJsonBody } from "@/lib/http";

export const maxDuration = 60;

/** POST /api/council/answer — one model's independent answer (Council round 1, Arena). */
export async function POST(req: Request) {
  try {
    const b = await parseJsonBody(req, councilAnswerRequest, 64_000);
    return await streamStep(req, { modelId: b.modelId, messages: answerMessages(b.question, b.sources), purpose: "council", prompt: b.question, maxOutputTokens: 2400 });
  } catch (err) {
    return errorResponse(err);
  }
}
