import "server-only";
import { serverEnv, isSupabaseConfigured } from "../env";
import { ApiError } from "../http";
import { createServerSupabase } from "../supabase/server";
import { demoProvider } from "./providers/demo";
import { AnthropicProvider } from "./providers/anthropic";
import { OpenAICompatibleProvider } from "./providers/openai-compatible";
import { isAutoId, routerModeOf, type PlatformSettings, type RouterMode } from "./platform";
import { DEFAULT_MODELS, RETIRED_MODELS, parseModelsOverride, withStatus } from "./registry";
import { autoRoute, cheapestModel } from "./router";
import { getPlatformSettings } from "./settings";
import type { AIProvider, Capability, ModelInfo, ModelWithStatus, ProviderId } from "./types";
import { modelTier } from "../plans";

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
  xai: new OpenAICompatibleProvider("xai", {
    baseUrl: serverEnv().xaiBaseUrl,
    apiKey: () => serverEnv().xaiKey,
    envVar: "XAI_API_KEY",
  }),
  deepseek: new OpenAICompatibleProvider("deepseek", {
    baseUrl: serverEnv().deepseekBaseUrl,
    apiKey: () => serverEnv().deepseekKey,
    envVar: "DEEPSEEK_API_KEY",
  }),
  // Z.ai's OpenAI-compatible API (GLM models). ZAI_BASE_URL overrides it (e.g. the mainland China endpoint).
  zai: new OpenAICompatibleProvider("zai", {
    baseUrl: serverEnv().zaiBaseUrl,
    apiKey: () => serverEnv().zaiKey,
    envVar: "ZAI_API_KEY",
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
    xai: providers.xai.isConfigured(),
    deepseek: providers.deepseek.isConfigured(),
    zai: providers.zai.isConfigured(),
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

/** Every registered model before admin filtering: model_registry table → ORBIS_MODELS env → defaults, plus admin-added models. */
export async function getAllModels(settings?: PlatformSettings): Promise<ModelWithStatus[]> {
  const cfg = settings ?? (await getPlatformSettings());
  const base =
    (await registryFromDatabase()) ?? parseModelsOverride(serverEnv().modelsJson) ?? DEFAULT_MODELS.filter((m) => m.provider !== "demo");
  const custom = cfg.customModels.filter((c) => !base.some((m) => m.id === c.id));
  const demos = DEFAULT_MODELS.filter((m) => m.provider === "demo");
  const all = [...base, ...custom];
  const ids = new Set(all.map((m) => m.id));
  // Administrators can move a model to another plan tier (Admin → Plans & pricing).
  const tiers = ((cfg.billing as { modelTiers?: Record<string, ModelInfo["tier"]> } | undefined)?.modelTiers ?? {}) as Record<string, ModelInfo["tier"]>;
  const tiered = all.map((m) => (tiers[m.id] ? { ...m, tier: tiers[m.id] } : m));
  return withStatus([...tiered, ...demos.filter((d) => !ids.has(d.id))], providerConfiguredMap());
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
  // A retired model (saved choice, agent default, setting) runs on its replacement.
  if (modelId && RETIRED_MODELS[modelId] && !models.some((x) => x.id === modelId)) modelId = RETIRED_MODELS[modelId].replacement;
  if (modelId) {
    const m = models.find((x) => x.id === modelId);
    if (!m) throw new ApiError("bad_request", `"${modelId}" isn't an available model. Choose another model.`);
    if (!m.available) throw new ApiError("not_configured", `${m.displayName} is unavailable: ${m.unavailableReason}.`);
    return m;
  }
  // No choice made: the administrator's default if one is set, otherwise the cheapest available model.
  const first = models.find((m) => m.isDefault && m.available) ?? cheapestModel(models);
  if (!first) throw new ApiError("not_configured", "No AI model is available.");
  return first;
}

export interface ModelChoice {
  model: ModelWithStatus;
  /** Present when Auto picked the model. */
  routing: { auto: true; mode: RouterMode; reason: string } | null;
  settings: PlatformSettings;
}

/** Resolve the user's choice, including Auto, which routes by task type with the router's published rules. */
export async function resolveModelChoice(
  modelId: string | null | undefined,
  ctx: { prompt: string; mode?: string; needs?: Capability[]; preferLowCost?: boolean; tiers?: readonly string[] },
): Promise<ModelChoice> {
  const settings = await getPlatformSettings();
  if (!isAutoId(modelId)) return { model: await resolveModel(modelId, settings), routing: null, settings };
  if (!settings.autoEnabled) {
    throw new ApiError("bad_request", "Auto mode is turned off on this site. Choose a model from the model menu.");
  }
  const routerMode = routerModeOf(modelId);
  // Auto only chooses among the models the user's plan includes.
  const models = (await getModels(settings)).filter((m) => !ctx.tiers || ctx.tiers.includes(modelTier(m)));
  const route = autoRoute(models, ctx.prompt, { ...ctx, routerMode });
  if (!route) throw new ApiError("not_configured", "Auto mode has no configured model to choose from. Choose a model manually.");
  return { model: route.model, routing: { auto: true, mode: routerMode, reason: route.reason }, settings };
}

const TIER_RANK = { standard: 0, advanced: 1, premium: 2 } as const;

/**
 * Models that may answer if the chosen one fails: only when the administrator
 * allows fallback and the user opted in, and only models with the same key
 * capabilities, in the same or a cheaper tier. Same-provider models are tried
 * first; for a model the user picked, only same-provider models are used.
 */
export async function fallbackChain(
  primary: ModelWithStatus,
  settings: PlatformSettings,
  userAllows: boolean,
  opts: { sameProvider?: boolean; tiers?: readonly string[] } = {},
): Promise<ModelWithStatus[]> {
  if (!settings.fallbackEnabled || !userAllows || primary.provider === "demo") return [];
  const key: Capability[] = (["reasoning", "coding"] as Capability[]).filter((c) => primary.capabilities.includes(c));
  return (await getModels(settings))
    .filter((m) => m.available && m.provider !== "demo" && m.id !== primary.id && key.every((c) => m.capabilities.includes(c)))
    // A model the user picked is never replaced by another provider's, and backups stay within the plan.
    .filter((m) => (!opts.sameProvider || m.provider === primary.provider) && (!opts.tiers || opts.tiers.includes(modelTier(m))))
    // Never a more expensive tier than the one asked for: a backup can't silently use more of the allowance.
    .filter((m) => TIER_RANK[modelTier(m)] <= TIER_RANK[modelTier(primary)])
    .sort((a, b) => Number(b.provider === primary.provider) - Number(a.provider === primary.provider) || TIER_RANK[modelTier(b)] - TIER_RANK[modelTier(a)])
    .slice(0, 2);
}

/** Combine a caller's abort signal with a hard timeout. */
export function withTimeout(ms: number, outer?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return outer ? AbortSignal.any([outer, t]) : t;
}
