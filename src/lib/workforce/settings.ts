import { z } from "zod";

/** Operator-configurable Workforce policy. Validated and enforced on the server. */
export const workforceSettingsSchema = z.object({
  /** Global ceiling; a task can ask for less autonomy, never more. */
  maxAutonomy: z.enum(["assist", "collaborate", "execute"]).default("collaborate"),
  /** Continuous operations are not implemented; kept false. */
  continuousOperations: z.literal(false).default(false),
  emergencyStop: z.boolean().default(false),
  disabledAgents: z.array(z.string().max(40)).max(20).default([]),
  /** Model per agent: a model id or an Auto mode such as "auto:coding". */
  models: z.record(z.string().max(40), z.string().max(120)).default({}),
  defaultBudgetUsd: z.number().min(0).max(100).default(2),
  maxBudgetUsd: z.number().min(0).max(1000).default(10),
  defaultTokenBudget: z.number().int().min(10_000).max(5_000_000).default(400_000),
  /** Models without a known price can't be cost-limited; allow them only if the operator opts in. */
  allowUnpricedModels: z.boolean().default(false),
  maxConcurrentTasks: z.number().int().min(1).max(10).default(2),
  maxParallelSteps: z.number().int().min(1).max(4).default(2),
  stepTimeoutMs: z.number().int().min(10_000).max(1_800_000).default(600_000),
  maxRepairAttempts: z.number().int().min(0).max(5).default(2),
  maxStepRetries: z.number().int().min(0).max(5).default(1),
  /** Block delivery on security findings at or above this severity. */
  blockOnSecurity: z.enum(["critical", "high", "medium", "never"]).default("high"),
  allowDependencyChanges: z.boolean().default(false),
  runBuildCheck: z.boolean().default(true),
  aiSecurityReview: z.boolean().default(true),
  retentionDays: z.number().int().min(1).max(365).default(30),
  sandboxVcpus: z.union([z.literal(2), z.literal(4)]).default(2),
});
export type WorkforceSettings = z.infer<typeof workforceSettingsSchema>;

export const DEFAULT_SETTINGS: WorkforceSettings = workforceSettingsSchema.parse({});

export function parseSettings(raw: unknown): WorkforceSettings {
  const r = workforceSettingsSchema.safeParse(raw ?? {});
  return r.success ? r.data : DEFAULT_SETTINGS;
}

export const AUTONOMY_RANK = { assist: 0, collaborate: 1, execute: 2 } as const;
