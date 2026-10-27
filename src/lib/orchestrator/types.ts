import { z } from "zod";

/**
 * The orchestrator's vocabulary: agent profiles, tasks and their lifecycle, and the input schemas every endpoint
 * validates against. Pure (no server code), so the rules are testable and shared. The database enforces the same
 * ranges (supabase/migrations/20261110000000_orchestrator.sql).
 */

export const AGENT_ROLES = ["lead_developer", "frontend_developer", "backend_developer", "security_engineer", "qa_engineer", "code_reviewer", "custom"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];
export const ROLE_LABEL: Record<AgentRole, string> = {
  lead_developer: "Lead Developer",
  frontend_developer: "Frontend Developer",
  backend_developer: "Backend Developer",
  security_engineer: "Security Engineer",
  qa_engineer: "QA Engineer",
  code_reviewer: "Code Reviewer",
  custom: "Custom Agent",
};

export const TASK_STATUSES = ["queued", "running", "blocked", "completed", "failed", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const FINAL_STATUSES: readonly TaskStatus[] = ["completed", "failed", "cancelled"];
export const TASK_KINDS = ["execute", "plan"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/** The lifecycle (mirrors the database trigger, which is what actually enforces it). */
export const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ["running", "blocked", "cancelled", "failed"],
  blocked: ["queued", "cancelled", "failed"],
  running: ["completed", "failed", "queued", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};
export const canTransition = (from: TaskStatus, to: TaskStatus) => from === to || TRANSITIONS[from].includes(to);

/**
 * Tools an agent may be granted. This phase has read-only tools only: nothing can write files, run commands,
 * touch Git or deploy. Later phases add tools here (each with its risk) and approvals for consequential ones.
 */
export const ORCH_TOOLS = {
  read_project: { label: "Read the task's project", description: "List, search and read the project's files (secret files such as .env are withheld).", risk: "low" },
} as const;
export type OrchTool = keyof typeof ORCH_TOOLS;
export const isOrchTool = (t: string): t is OrchTool => Object.hasOwn(ORCH_TOOLS, t);
/** Tools that exist in Orbis elsewhere but aren't available to orchestrator agents yet (asked for → refused clearly). */
export const NOT_YET_AVAILABLE_TOOLS = ["write_files", "run_commands", "git", "deploy", "web"] as const;

/** Hard limits (also enforced by the database). Execution timeout stays under the worker's 300 s function limit. */
export const LIMITS = {
  timeoutSeconds: { min: 10, max: 270, default: 120 },
  maxAttempts: { min: 1, max: 5, default: 2 },
  retryBackoffSeconds: { min: 5, max: 3600, default: 30 },
  maxOutputTokens: { min: 256, max: 32_000, default: 4000 },
  maxTurns: { min: 1, max: 8, default: 4 },
  priority: { min: 0, max: 100, default: 50 },
  subtasks: 8,
  dependencies: 20,
} as const;

export const MAX_CONCURRENCY = 3;

const taskType = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9_-]{0,39}$/, "Use a short lowercase task type, e.g. backend, review, tests.");
const int = (r: { min: number; max: number }) => z.number().int().min(r.min).max(r.max);

const agentFields = {
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2000),
  role: z.enum(AGENT_ROLES),
  provider: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_-]{1,30}$/, "Unknown provider."),
  modelId: z.string().trim().min(1).max(120),
  systemInstructions: z.string().max(20_000),
  enabled: z.boolean(),
  allowedTools: z.array(z.string().trim().min(1).max(40)).max(20),
  permissions: z.object({ requireApprovalFor: z.array(z.string().max(40)).max(20).optional() }).strict(),
  taskTypes: z.array(taskType).max(30),
  priority: int(LIMITS.priority),
  timeoutSeconds: int(LIMITS.timeoutSeconds),
  maxAttempts: int(LIMITS.maxAttempts),
  retryBackoffSeconds: int(LIMITS.retryBackoffSeconds),
  maxOutputTokens: int(LIMITS.maxOutputTokens),
  maxTurns: int(LIMITS.maxTurns),
};

export const agentCreateSchema = z
  .object({
    ...agentFields,
    description: agentFields.description.default(""),
    systemInstructions: agentFields.systemInstructions.default(""),
    enabled: agentFields.enabled.default(true),
    allowedTools: agentFields.allowedTools.default([]),
    permissions: agentFields.permissions.default({}),
    taskTypes: agentFields.taskTypes.default([]),
    priority: agentFields.priority.default(LIMITS.priority.default),
    timeoutSeconds: agentFields.timeoutSeconds.default(LIMITS.timeoutSeconds.default),
    maxAttempts: agentFields.maxAttempts.default(LIMITS.maxAttempts.default),
    retryBackoffSeconds: agentFields.retryBackoffSeconds.default(LIMITS.retryBackoffSeconds.default),
    maxOutputTokens: agentFields.maxOutputTokens.default(LIMITS.maxOutputTokens.default),
    maxTurns: agentFields.maxTurns.default(LIMITS.maxTurns.default),
  })
  .strict();
export type AgentInput = z.infer<typeof agentCreateSchema>;

export const agentUpdateSchema = z
  .object(Object.fromEntries(Object.entries(agentFields).map(([k, v]) => [k, v.optional()])) as { [K in keyof typeof agentFields]: z.ZodOptional<(typeof agentFields)[K]> })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to change.");
export type AgentPatch = z.infer<typeof agentUpdateSchema>;

export const taskCreateSchema = z
  .object({
    projectId: z.uuid(),
    title: z.string().trim().min(1).max(200),
    input: z.string().max(20_000).default(""),
    /** "plan": a lead agent breaks the work into sub-tasks (with dependencies) instead of doing it. */
    kind: z.enum(TASK_KINDS).default("execute"),
    taskType: taskType.optional(),
    /** Run on this agent only (otherwise the scheduler picks an enabled agent that handles the task type). */
    agentId: z.uuid().optional(),
    priority: int(LIMITS.priority).default(LIMITS.priority.default),
    dependsOn: z.array(z.uuid()).max(LIMITS.dependencies).default([]),
    maxAttempts: int(LIMITS.maxAttempts).optional(),
  })
  .strict();
export type TaskInput = z.infer<typeof taskCreateSchema>;

export const settingsSchema = z.object({ maxConcurrency: z.number().int().min(1).max(MAX_CONCURRENCY) }).strict();

// ---------------------------------------------------------------- rows (as stored) and views (as returned)

export interface AgentRow {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  role: AgentRole;
  provider: string;
  model_id: string;
  system_instructions: string;
  enabled: boolean;
  allowed_tools: string[];
  permissions: Record<string, unknown>;
  task_types: string[];
  priority: number;
  timeout_seconds: number;
  max_attempts: number;
  retry_backoff_seconds: number;
  max_output_tokens: number;
  max_turns: number;
  created_at: string;
  updated_at: string;
}

export interface TaskRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  parent_id: string | null;
  kind: TaskKind;
  task_type: string;
  title: string;
  input: string;
  status: TaskStatus;
  block_kind: "dependencies" | "agent" | null;
  status_reason: string | null;
  agent_id: string | null;
  agent_locked: boolean;
  agent_name: string | null;
  provider: string | null;
  model_id: string | null;
  priority: number;
  depends_on: string[];
  attempts: number;
  max_attempts: number;
  retry_backoff_seconds: number;
  run_after: string;
  current_attempt_id: string | null;
  output: string | null;
  error: string | null;
  usage: Record<string, unknown>;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | string | null;
  updated_at: string;
}

export interface AttemptRow {
  id: string;
  task_id: string;
  attempt_no: number;
  agent_id: string | null;
  agent_name: string | null;
  provider: string | null;
  model_id: string | null;
  status: "running" | "succeeded" | "failed" | "timed_out" | "cancelled" | "interrupted";
  slot_no: number | null;
  started_at: string;
  expires_at: string;
  finished_at: string | null;
  error_kind: string | null;
  error: string | null;
  model_calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | string | null;
}

export function agentView(r: AgentRow) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    role: r.role,
    roleLabel: ROLE_LABEL[r.role] ?? r.role,
    provider: r.provider,
    modelId: r.model_id,
    systemInstructions: r.system_instructions,
    enabled: r.enabled,
    allowedTools: r.allowed_tools,
    permissions: r.permissions,
    taskTypes: r.task_types,
    priority: r.priority,
    timeoutSeconds: r.timeout_seconds,
    maxAttempts: r.max_attempts,
    retryBackoffSeconds: r.retry_backoff_seconds,
    maxOutputTokens: r.max_output_tokens,
    maxTurns: r.max_turns,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
export type AgentView = ReturnType<typeof agentView>;

export function taskView(r: TaskRow) {
  return {
    id: r.id,
    projectId: r.project_id,
    parentId: r.parent_id,
    kind: r.kind,
    taskType: r.task_type,
    title: r.title,
    input: r.input,
    status: r.status,
    statusReason: r.status_reason,
    agentId: r.agent_id,
    agentLocked: r.agent_locked,
    agentName: r.agent_name,
    provider: r.provider,
    modelId: r.model_id,
    priority: r.priority,
    dependsOn: r.depends_on,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    runAfter: r.run_after,
    output: r.output,
    error: r.error,
    usage: r.usage,
    createdAt: r.created_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
  };
}
export type TaskView = ReturnType<typeof taskView>;

export function attemptView(r: AttemptRow) {
  return {
    id: r.id,
    attemptNo: r.attempt_no,
    agentId: r.agent_id,
    agentName: r.agent_name,
    provider: r.provider,
    modelId: r.model_id,
    status: r.status,
    slot: r.slot_no,
    startedAt: r.started_at,
    expiresAt: r.expires_at,
    finishedAt: r.finished_at,
    errorKind: r.error_kind,
    error: r.error,
    modelCalls: r.model_calls,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
  };
}
