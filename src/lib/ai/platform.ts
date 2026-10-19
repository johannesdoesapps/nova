import { z } from "zod";
import { modelInfoSchema } from "./registry";

/**
 * Platform-wide AI settings, edited by administrators and stored in
 * app_settings. Shared by the server and the admin screen; holds no secrets.
 */
export const platformSettingsSchema = z.object({
  /** Model ids users may pick; null means every configured model. */
  enabledModelIds: z.array(z.string().min(1).max(120)).max(200).nullable().default(null),
  /** Default model for new chats; null means the first available in registry order. */
  defaultModelId: z.string().min(1).max(120).nullable().default(null),
  /** Whether users can choose Auto, which routes each message by simple published rules. */
  autoEnabled: z.boolean().default(true),
  /** Whether another compatible model may answer when the chosen one fails (users must also opt in). */
  fallbackEnabled: z.boolean().default(false),
  /** Usage units per message, by model id, overriding the defaults (1 for low-cost models, 15 otherwise). */
  modelUnits: z.record(z.string().min(1).max(120), z.number().int().min(0).max(100)).default({}),
  /** Extra models added by an administrator, e.g. new releases discovered with "Test connection". */
  customModels: z.array(modelInfoSchema).max(50).default([]),
});

export type PlatformSettings = z.infer<typeof platformSettingsSchema>;

export const DEFAULT_PLATFORM_SETTINGS: PlatformSettings = platformSettingsSchema.parse({});

/** Parse stored settings, falling back to defaults field by field rather than failing. */
export function parsePlatformSettings(raw: unknown): PlatformSettings {
  const r = platformSettingsSchema.safeParse(raw ?? {});
  return r.success ? r.data : DEFAULT_PLATFORM_SETTINGS;
}

/** The pseudo model id that asks the server to route each message. */
export const AUTO_MODEL_ID = "auto";

/**
 * Smart Router preferences. "auto" is balanced; the others bias the same
 * published rules toward speed, reasoning depth, sources or code. Chosen as
 * "auto:<mode>" in the model selector.
 */
export const ROUTER_MODES = [
  { id: "balanced", label: "Auto", blurb: "The lowest-cost available model, by current prices." },
  { id: "quick", label: "Quick", blurb: "Fast, economical models first." },
  { id: "deep", label: "Deep", blurb: "Reasoning models for complex problems." },
  { id: "research", label: "Research", blurb: "Reasoning model plus web sources when search is set up." },
  { id: "coding", label: "Coding", blurb: "Models suited to programming." },
] as const;
export type RouterMode = (typeof ROUTER_MODES)[number]["id"];

export function isAutoId(id: string | null | undefined): boolean {
  return id === AUTO_MODEL_ID || (!!id && id.startsWith(`${AUTO_MODEL_ID}:`) && ROUTER_MODES.some((m) => `${AUTO_MODEL_ID}:${m.id}` === id));
}

export function routerModeOf(id: string | null | undefined): RouterMode {
  const mode = id?.startsWith(`${AUTO_MODEL_ID}:`) ? id.slice(AUTO_MODEL_ID.length + 1) : "balanced";
  return (ROUTER_MODES.find((m) => m.id === mode)?.id ?? "balanced") as RouterMode;
}

export function autoIdFor(mode: RouterMode): string {
  return mode === "balanced" ? AUTO_MODEL_ID : `${AUTO_MODEL_ID}:${mode}`;
}
