import { synthesisMessages } from "@/lib/council/prompts";
import { streamStep } from "@/lib/council/run";
import { councilSynthesizeRequest } from "@/lib/council/schema";
import { errorResponse, parseJsonBody } from "@/lib/http";

export const maxDuration = 60;

const PURPOSE = { council: "council-synthesis", compare: "arena-summary", analysis: "arena-analysis", final: "arena-final", evaluate: "arena-evaluate" } as const;

/** POST /api/council/synthesize — Council's final answer, or for Arena: a comparison summary, agreement analysis, combined final answer or criteria evaluation. */
export async function POST(req: Request) {
  try {
    const b = await parseJsonBody(req, councilSynthesizeRequest, 240_000);
    return await streamStep(req, {
      modelId: b.modelId,
      messages: synthesisMessages(b.question, b.responses, b.critiques, b.sources, b.kind, b.goal),
      purpose: PURPOSE[b.kind],
      prompt: b.question,
      maxOutputTokens: 3000,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
