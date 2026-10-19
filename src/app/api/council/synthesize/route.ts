import { synthesisMessages } from "@/lib/council/prompts";
import { streamStep } from "@/lib/council/run";
import { councilSynthesizeRequest } from "@/lib/council/schema";
import { errorResponse, parseJsonBody } from "@/lib/http";

export const maxDuration = 60;

/** POST /api/council/synthesize — final Council answer, or an Arena comparison summary (kind: "compare"). */
export async function POST(req: Request) {
  try {
    const b = await parseJsonBody(req, councilSynthesizeRequest, 240_000);
    return await streamStep(req, {
      modelId: b.modelId,
      messages: synthesisMessages(b.question, b.responses, b.critiques, b.sources, b.kind),
      purpose: b.kind === "council" ? "council-synthesis" : "arena-summary",
      prompt: b.question,
      maxOutputTokens: 3000,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
