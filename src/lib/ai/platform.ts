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
  /** Usage units per message, by model id, overriding the defaults (by default from the model tier: see tierUnits in src/lib/plans.ts). */
  modelUnits: z.record(z.string().min(1).max(120), z.number().int().min(0).max(100)).default({}),
  /** Extra models added by an administrator, e.g. new releases discovered with "Test connection". */
  customModels: z.array(modelInfoSchema).max(50).default([]),
  /** Task agents an administrator has paused: no new task can start with them until resumed (ids from the agent registry). */
  pausedAgents: z.array(z.string().min(1).max(40)).max(50).default([]),
  /**
   * Default resource limits for a new coding-agent task (Software Engineer, Bug Fixing, QA Testing, Website Builder).
   * When a task reaches one it pauses and asks the user to allow more or stop; it never silently continues.
   * Unset fields keep the built-in defaults (600,000 tokens, 30 minutes).
   */
  taskLimits: z
    .object({ tokenBudget: z.number().int().min(10_000).max(10_000_000).optional(), timeLimitMinutes: z.number().int().min(1).max(240).optional() })
    .strict()
    .default({}),
  /** Plans, prices, allowances and budget rules (merged over DEFAULT_BILLING; see src/lib/plans.ts). */
  billing: z.record(z.string(), z.unknown()).optional(),
});

export type PlatformSettings = z.infer<typeof platformSettingsSchema>;

export const DEFAULT_PLATFORM_SETTINGS: PlatformSettings = platformSettingsSchema.parse({});

/** Parse stored settings, falling back to defaults field by field rather than failing. */
export function parsePlatformSettings(raw: unknown): PlatformSettings {
  const r = platformSettingsSchema.safeParse(raw ?? {});
  return r.success ? r.data : DEFAULT_PLATFORM_SETTINGS;
}

/** The pseudo model id that asks the server to route each message. */
export { AUTO_MODEL_ID, ROUTER_MODES, autoIdFor, isAutoId, routerModeOf, type RouterMode } from "./router-modes";
