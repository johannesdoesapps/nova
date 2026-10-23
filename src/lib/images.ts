import "server-only";
import { serverEnv } from "./env";
import { ApiError } from "./http";
import { reportError } from "./observability";
import { billingStop, billingStopError } from "./ai/providers/errors";
import type { ModelInfo } from "./ai/types";

/**
 * Image generation with OpenAI's Image API (POST /v1/images/generations, model gpt-image-2.5-flare:
 * "fast, high-quality everyday image generation"). Prices from OpenAI's image generation guide: $5 per
 * million text input tokens and $30 per million image output tokens. Each image is metered like a message
 * to an advanced model (Pro and up) and charged by the tokens OpenAI reports.
 */
export const IMAGE_MODEL: ModelInfo = {
  id: "openai:gpt-image-2.5-flare",
  provider: "openai",
  providerModelId: "gpt-image-2.5-flare",
  displayName: "GPT Image 2.5 Flare",
  description: "OpenAI image generation.",
  capabilities: [],
  contextWindow: null,
  inputPrice: 5,
  outputPrice: 30,
  isEnabled: true,
  lastVerifiedAt: "2026-10-23",
  priceSourceUrl: "https://learn.chatgpt.com/api/docs/guides/image-generation",
  tier: "advanced",
};

export const IMAGE_SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const;
export const IMAGE_QUALITIES = ["low", "medium", "high"] as const;
export type ImageSize = (typeof IMAGE_SIZES)[number];
export type ImageQuality = (typeof IMAGE_QUALITIES)[number];

/** Upper estimates of image output tokens, used only to hold enough allowance before the call; the charge uses OpenAI's reported usage. */
export const OUTPUT_TOKEN_ESTIMATE: Record<ImageQuality, number> = { low: 600, medium: 2_000, high: 7_000 };

export interface ImageResult {
  dataUrl: string;
  usage: { inputTokens: number | null; outputTokens: number | null; estimated: boolean };
}

export function imagesConfigured(): boolean {
  return Boolean(serverEnv().openaiKey);
}

export async function generateImage(prompt: string, size: ImageSize, quality: ImageQuality, signal?: AbortSignal): Promise<ImageResult> {
  const env = serverEnv();
  if (!env.openaiKey) throw new ApiError("not_configured", "Image generation needs an OpenAI API key on this site.");
  let res: Response;
  try {
    res = await fetch(`${env.openaiBaseUrl.replace(/\/$/, "")}/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.openaiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: IMAGE_MODEL.providerModelId, prompt, size, quality, n: 1, output_format: "jpeg", output_compression: 85 }),
      signal,
    });
  } catch (err) {
    if ((err as Error)?.name === "TimeoutError" || signal?.aborted) throw new ApiError("timeout", "The image took too long. Try again, or choose a lower quality.");
    throw new ApiError("upstream_error", "Couldn't reach OpenAI to create the image. Try again in a moment.");
  }
  const j = (await res.json().catch(() => ({}))) as {
    data?: { b64_json?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: { code?: string | null; type?: string; message?: string };
  };
  if (!res.ok) {
    const code = j.error?.code ?? j.error?.type ?? null;
    const message = j.error?.message ?? "";
    const stop = billingStop(res.status, code, message);
    if (stop) throw billingStopError("openai", IMAGE_MODEL.displayName, stop);
    if (code === "moderation_blocked") throw new ApiError("bad_request", "That image can't be created because it goes against the content policy. Try describing something different.");
    reportError(new Error(`images/generations returned ${res.status}: ${message.slice(0, 300)}`), { where: "images.generate" });
    if (res.status === 429) throw new ApiError("rate_limited", "Image generation is busy right now. Try again shortly.");
    throw new ApiError(res.status >= 500 ? "upstream_error" : "bad_request", `The image couldn't be created (error ${res.status}). Try rephrasing the description.`);
  }
  const b64 = j.data?.[0]?.b64_json;
  if (!b64) throw new ApiError("upstream_error", "OpenAI returned no image. Try again.");
  return { dataUrl: `data:image/jpeg;base64,${b64}`, usage: { inputTokens: j.usage?.input_tokens ?? null, outputTokens: j.usage?.output_tokens ?? null, estimated: false } };
}
