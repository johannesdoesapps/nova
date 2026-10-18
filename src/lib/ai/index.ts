import "server-only";
import { serverEnv, isSupabaseConfigured } from "../env";
import { ApiError } from "../http";
import { createServerSupabase } from "../supabase/server";
import { demoProvider } from "./providers/demo";
import { AnthropicProvider } from "./providers/anthropic";
import { OpenAICompatibleProvider } from "./providers/openai-compatible";
import { AUTO_MODEL_ID, type PlatformSettings } from "./platform";
import { DEFAULT_MODELS, parseModelsOverride, withStatus } from "./registry";
import { autoRoute } from "./router";
import { getPlatformSettings } from "./settings";
import type { AIProvider, Capability, ModelInfo, ModelWithStatus, ProviderId } from "./types";

const providers: Record<ProviderId, AIProvider> = {
  anthropic: new AnthropicProvider(() => serverEnv().anthropicKey),
  openai: new OpenAICompatibleProvider("openai", {
    baseUrl: serverEnv().openaiBaseUrl,
    apiKey: () => serverEnv().openaiKey,
    envVar: "OPENAI_API_KEY",
  }),
  google: new OpenAICompatibleProvider("google", {
    baseUrl: serverEnv().geminiBaseUrl,
    apiKey: () => serverEnv().geminiKey,
    envVar: "GEMINI_API_KEY",
  }),
  deepseek: new OpenAICompatibleProvider("deepseek", {
    baseUrl: serverEnv().deepseekBaseUrl,
    apiKey: () => serverEnv().deepseekKey,
    envVar: "DEEPSEEK_API_KEY",
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
    google: providers.google.isConfigured(),
    deepseek: providers.deepseek.isConfigured(),
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

/** Every registered model before admin filtering: model_registry table → NOVA_MODELS env → defaults, plus admin-added models. */
export async function getAllModels(settings?: PlatformSettings): Promise<ModelWithStatus[]> {
  const cfg = settings ?? (await getPlatformSettings());
  const base =
    (await registryFromDatabase()) ?? parseModelsOverride(serverEnv().modelsJson) ?? DEFAULT_MODELS.filter((m) => m.provider !== "demo");
  const custom = cfg.customModels.filter((c) => !base.some((m) => m.id === c.id));
  const demos = DEFAULT_MODELS.filter((m) => m.provider === "demo");
  const all = [...base, ...custom];
  const ids = new Set(all.map((m) => m.id));
  return withStatus([...all, ...demos.filter((d) => !ids.has(d.id))], providerConfiguredMap());
}

/**
 * Models users may choose: admin-enabled ones, with the admin's default first.
 * Demo models are only offered when no real provider is configured.
 */
export async function getModels(settings?: PlatformSettings): Promise<ModelWithStatus[]> {
  const cfg = settings ?? (await getPlatformSettings());
  const enabled = cfg.enabledModelIds ? new Set(cfg.enabledModelIds) : null;
  const models = (await getAllModels(cfg)).filter((m) => !enabled || m.provider === "demo" || enabled.has(m.id));
  const def = models.find((m) => m.id === cfg.defaultModelId && m.available);
  if (!def) return models;
  return [{ ...def, isDefault: true }, ...models.filter((m) => m.id !== def.id)];
}

export async function resolveModel(modelId?: string | null, settings?: PlatformSettings): Promise<ModelWithStatus> {
  const models = await getModels(settings);
  if (modelId) {
    const m = models.find((x) => x.id === modelId);
    if (!m) throw new ApiError("bad_request", `"${modelId}" isn't an available model. Choose another model.`);
    if (!m.available) throw new ApiError("not_configured", `${m.displayName} is unavailable: ${m.unavailableReason}.`);
    return m;
  }
  const first = models.find((m) => m.available && m.provider !== "demo") ?? models.find((m) => m.available);
  if (!first) throw new ApiError("not_configured", "No AI model is available.");
  return first;
}

export interface ModelChoice {
  model: ModelWithStatus;
  /** Present when Auto picked the model. */
  routing: { auto: true; reason: string } | null;
  settings: PlatformSettings;
}

/** Resolve the user's choice, including Auto, which routes by task type with the router's published rules. */
export async function resolveModelChoice(
  modelId: string | null | undefined,
  ctx: { prompt: string; mode?: string; needs?: Capability[]; preferLowCost?: boolean },
): Promise<ModelChoice> {
  const settings = await getPlatformSettings();
  if (modelId !== AUTO_MODEL_ID) return { model: await resolveModel(modelId, settings), routing: null, settings };
  if (!settings.autoEnabled) {
    throw new ApiError("bad_request", "Auto mode is turned off on this site. Choose a model from the model menu.");
  }
  const route = autoRoute(await getModels(settings), ctx.prompt, ctx);
  if (!route) throw new ApiError("not_configured", "Auto mode has no configured model to choose from. Choose a model manually.");
  return { model: route.model, routing: { auto: true, reason: route.reason }, settings };
}

/**
 * Models that may answer if the chosen one fails: only when the administrator
 * allows fallback and the user opted in, and only models with the same key
 * capabilities. Same-provider models are tried first.
 */
export async function fallbackChain(primary: ModelWithStatus, settings: PlatformSettings, userAllows: boolean): Promise<ModelWithStatus[]> {
  if (!settings.fallbackEnabled || !userAllows || primary.provider === "demo") return [];
  const key: Capability[] = (["reasoning", "coding"] as Capability[]).filter((c) => primary.capabilities.includes(c));
  return (await getModels(settings))
    .filter((m) => m.available && m.provider !== "demo" && m.id !== primary.id && key.every((c) => m.capabilities.includes(c)))
    .sort((a, b) => Number(b.provider === primary.provider) - Number(a.provider === primary.provider))
    .slice(0, 2);
}

/** Combine a caller's abort signal with a hard timeout. */
export function withTimeout(ms: number, outer?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return outer ? AbortSignal.any([outer, t]) : t;
}
