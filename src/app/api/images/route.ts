import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { errorResponse, parseJsonBody } from "@/lib/http";
import { generateImage, IMAGE_MODEL, IMAGE_QUALITIES, IMAGE_SIZES, OUTPUT_TOKEN_ESTIMATE } from "@/lib/images";
import { enforceLimits, recordRunLater, releaseUsage } from "@/lib/usage";

export const maxDuration = 120;

const body = z.object({
  prompt: z.string().trim().min(3).max(2_000),
  size: z.enum(IMAGE_SIZES).default("1024x1024"),
  quality: z.enum(IMAGE_QUALITIES).default("medium"),
  requestId: z.uuid().optional(),
});

/**
 * POST /api/images — create one image from a description (signed in; Pro and up, like other advanced models).
 * The usage allowance is reserved first and charged by the tokens OpenAI reports; a failed image costs nothing.
 * Images aren't stored by Orbis: the browser gets the picture and can download it.
 */
export async function POST(req: Request) {
  try {
    const { prompt, size, quality, requestId } = await parseJsonBody(req, body, 8_000);
    const auth = await requireUser();
    await enforceLimits(req, auth, 1, [IMAGE_MODEL], { requestId, purpose: "image", inputTokens: Math.ceil(prompt.length / 3) + 50, maxOutputTokens: OUTPUT_TOKEN_ESTIMATE[quality], ttlSeconds: 150 });
    const started = performance.now();
    try {
      const img = await generateImage(prompt, size, quality, AbortSignal.timeout(110_000));
      recordRunLater(auth, { model: IMAGE_MODEL, prompt: "", response: "image", latencyMs: performance.now() - started, usage: img.usage, status: "success", purpose: "image" });
      return NextResponse.json({ image: img.dataUrl, size, quality });
    } catch (err) {
      await releaseUsage(auth);
      throw err;
    }
  } catch (err) {
    return errorResponse(err);
  }
}
