import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { getAuth } from "@/lib/auth";
import { serverEnv } from "@/lib/env";
import { errorResponse, parseJsonBody } from "@/lib/http";

const body = z.object({ provider: z.enum(["anthropic", "openai", "google", "huggingface"]) });

/**
 * POST /api/admin/providers/test — check a provider's server-side credentials
 * by listing its models. Returns model ids only; keys never leave the server.
 */
export async function POST(req: Request) {
  try {
    await requireAdmin(await getAuth());
    const { provider } = await parseJsonBody(req, body);
    const env = serverEnv();
    const signal = AbortSignal.timeout(15_000);
    try {
      let models: string[] = [];
      if (provider === "anthropic") {
        if (!env.anthropicKey) return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY is not set." });
        const client = new Anthropic({ apiKey: env.anthropicKey, maxRetries: 0 });
        for await (const m of client.models.list({ limit: 100 }, { signal })) models.push(m.id);
      } else {
        const target = {
          openai: { key: env.openaiKey, url: `${env.openaiBaseUrl.replace(/\/$/, "")}/models`, envVar: "OPENAI_API_KEY" },
          google: { key: env.geminiKey, url: `${env.geminiBaseUrl.replace(/\/$/, "")}/models`, envVar: "GEMINI_API_KEY" },
          huggingface: { key: env.huggingfaceKey, url: "https://router.huggingface.co/v1/models", envVar: "HUGGINGFACE_API_KEY" },
        }[provider];
        if (!target.key) return NextResponse.json({ ok: false, error: `${target.envVar} is not set.` });
        const res = await fetch(target.url, { headers: { Authorization: `Bearer ${target.key}` }, signal });
        if (!res.ok) return NextResponse.json({ ok: false, error: `The provider answered ${res.status}${res.status === 401 || res.status === 403 ? " — the key was rejected" : ""}.` });
        const j = (await res.json()) as { data?: { id?: string }[] };
        models = (j.data ?? []).map((m) => String(m.id ?? "").replace(/^models\//, "")).filter(Boolean);
      }
      return NextResponse.json({ ok: true, models: models.sort().slice(0, 200) });
    } catch (err) {
      const status = err instanceof Anthropic.APIError ? err.status : null;
      return NextResponse.json({
        ok: false,
        error: status === 401 || status === 403 ? "The key was rejected." : (err as Error).name === "TimeoutError" ? "The provider did not respond in time." : "Could not reach the provider.",
      });
    }
  } catch (err) {
    return errorResponse(err);
  }
}
