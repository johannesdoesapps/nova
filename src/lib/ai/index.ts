import "server-only";
import { serverEnv, isSupabaseConfigured } from "../env";
import { ApiError } from "../http";
import { createServerSupabase } from "../supabase/server";
import { demoProvider } from "./providers/demo";
import { AnthropicProvider } from "./providers/anthropic";
import { OpenAICompatibleProvider } from "./providers/openai-compatible";
import { DEFAULT_MODELS, parseModelsOverride, withStatus } from "./registry";
import type { AIProvider, ModelInfo, ModelWithStatus, ProviderId } from "./types";

const providers: Record<ProviderId, AIProvider> = {
  anthropic: new AnthropicProvider(() => serverEnv().anthropicKey),
  openai: new OpenAICompatibleProvider("openai", {
    baseUrl: serverEnv().openaiBaseUrl,
    apiKey: () => serverEnv().openaiKey,
    envVar: "OPENAI_API_KEY",
  }),
  huggingface: new OpenAICompatibleProvider("huggingface", {
    baseUrl: "https://router.huggingface.co/v1",
    apiKey: () => serverEnv().huggingfaceKey,
    envVar: "HUGGINGFACE_API_KEY",
  }),
  demo: demoProvider,
};

export function getProvider(id: ProviderId): AIProvider {
  return providers[id];
}

export function providerConfiguredMap(): Record<ProviderId, boolean> {
  return {
    anthropic: providers.anthropic.isConfigured(),
    openai: providers.openai.isConfigured(),
    huggingface: providers.huggingface.isConfigured(),
    demo: true,
  };
}

type RegistryRow = {
  id: string;
  provider: ProviderId;
  provider_model_id: string;
  display_name: string;
  description: string | null;
  capabilities: string[] | null;
  context_window: number | null;
  input_price: number | string | null;
  output_price: number | string | null;
  is_enabled: boolean;
  last_verified_at: string | null;
  price_source_url?: string | null;
};

function num(v: number | string | null): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}

async function registryFromDatabase(): Promise<ModelInfo[] | null> {
  if (!isSupabaseConfigured()) return null;
  try {
    const supabase = await createServerSupabase();
    const { data, error } = await supabase.from("model_registry").select("*").eq("is_enabled", true);
    if (error || !data || data.length === 0) return null;
    return (data as RegistryRow[]).map((r) => ({
      id: r.id,
      provider: r.provider,
      providerModelId: r.provider_model_id,
      displayName: r.display_name,
      description: r.description ?? "",
      capabilities: (r.capabilities ?? ["chat"]) as ModelInfo["capabilities"],
      contextWindow: r.context_window,
      inputPrice: num(r.input_price),
      outputPrice: num(r.output_price),
      isEnabled: r.is_enabled,
      lastVerifiedAt: r.last_verified_at,
      priceSourceUrl: r.price_source_url ?? null,
    }));
  } catch {
    return null;
  }
}

/**
 * Registry source priority: model_registry table → NOVA_MODELS env → defaults.
 * Demo models are always appended so the UI works with no keys.
 */
export async function getModels(): Promise<ModelWithStatus[]> {
  const base =
    (await registryFromDatabase()) ?? parseModelsOverride(serverEnv().modelsJson) ?? DEFAULT_MODELS.filter((m) => m.provider !== "demo");
  const demos = DEFAULT_MODELS.filter((m) => m.provider === "demo");
  const ids = new Set(base.map((m) => m.id));
  return withStatus([...base, ...demos.filter((d) => !ids.has(d.id))], providerConfiguredMap());
}

export async function resolveModel(modelId?: string | null): Promise<ModelWithStatus> {
  const models = await getModels();
  if (modelId) {
    const m = models.find((x) => x.id === modelId);
    if (!m) throw new ApiError("bad_request", `Unknown model "${modelId}".`);
    if (!m.available) throw new ApiError("not_configured", `${m.displayName} is unavailable: ${m.unavailableReason}.`);
    return m;
  }
  const first = models.find((m) => m.available && m.provider !== "demo") ?? models.find((m) => m.available);
  if (!first) throw new ApiError("not_configured", "No AI model is available.");
  return first;
}

/** Combine a caller's abort signal with a hard timeout. */
export function withTimeout(ms: number, outer?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return outer ? AbortSignal.any([outer, t]) : t;
}
