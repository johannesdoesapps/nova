/** Core Workforce types shared by the runtime, API and UI. */

export const TASK_STATUSES = ["created", "analyzing", "planned", "awaiting_approval", "running", "verifying", "completed", "failed", "blocked", "cancelled", "needs_attention", "paused"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const ACTIVE_STATUSES: TaskStatus[] = ["created", "analyzing", "running", "verifying"];
export const TERMINAL_STATUSES: TaskStatus[] = ["completed", "failed", "cancelled"];

export const STEP_STATUSES = ["pending", "running", "succeeded", "failed", "skipped", "cancelled", "blocked"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const AUTONOMY = ["assist", "collaborate", "execute"] as const;
export type Autonomy = (typeof AUTONOMY)[number];

export type Risk = "low" | "medium" | "high";
export type Priority = "low" | "medium" | "high" | "urgent";

export type AgentId = "commander" | "architect" | "archaeologist" | "builder" | "qa_hunter" | "self_heal" | "reviewer" | "sentinel" | "optimizer" | "devops" | "visual";

export interface CheckDef {
  id: string;
  label: string;
  /** Each command is an argv array; no shell is ever used. */
  commands: string[][];
  required: boolean;
  /** Network domains this check may reach (default: none). */
  network?: string[];
  timeoutMs?: number;
}

export interface Project {
  id: string;
  name: string;
  repo: string;
  branch: string;
  package_manager: "npm";
  checks: CheckDef[];
  notes: string | null;
  created_at: string;
}

export interface Task {
  id: string;
  user_id: string;
  project_id: string;
  title: string;
  objective: string;
  acceptance_criteria: string[];
  priority: Priority;
  risk: Risk;
  autonomy: Autonomy;
  status: TaskStatus;
  status_reason: string | null;
  plan: Plan | null;
  plan_hash: string | null;
  budget_usd: number;
  token_budget: number;
  spent_usd: number;
  spent_unpriced_calls: number;
  tokens_used: number;
  sandbox_name: string | null;
  sandbox_ms: number;
  diff: string | null;
  changed_files: string[];
  verification: Verification | null;
  report: string | null;
  benchmark: string | null;
  versions: Record<string, string>;
  cancel_requested: boolean;
  lease_until: string | null;
  lease_id: string | null;
  ticks: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface Step {
  id: string;
  task_id: string;
  key: string;
  agent: AgentId;
  agent_version: string;
  title: string;
  depends_on: string[];
  status: StepStatus;
  attempt: number;
  max_attempts: number;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  state: Record<string, unknown>;
  error: string | null;
  model_id: string | null;
  tokens: number;
  cost_usd: number | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface Approval {
  id: string;
  task_id: string;
  kind: "plan" | "budget" | "changes" | "push";
  status: "pending" | "approved" | "rejected" | "expired";
  title: string;
  reason: string;
  risk: Risk;
  payload: Record<string, unknown>;
  payload_hash: string;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
}

export interface WfEvent {
  id: number;
  task_id: string | null;
  step_key: string | null;
  level: "debug" | "info" | "warn" | "error" | "audit";
  type: string;
  message: string;
  data: Record<string, unknown>;
  created_at: string;
}

export interface MemoryEntry {
  id: string;
  project_id: string;
  task_id: string | null;
  kind: "task_context" | "project_knowledge";
  content: string;
  source: string;
  verified: boolean;
  expires_at: string | null;
  created_at: string;
}

export interface PlanChange {
  path: string;
  action: "modify" | "create";
  intent: string;
}

export interface Plan {
  summary: string;
  approach: string;
  changes: PlanChange[];
  tests: string[];
  risks: string[];
  acceptanceCriteria: string[];
  risk: Risk;
  outOfScope: string[];
}

export interface CheckResult {
  id: string;
  label: string;
  required: boolean;
  exitCode: number | null;
  passed: boolean;
  durationMs: number;
  /** Last part of combined output, secrets masked. */
  outputTail: string;
  timedOut: boolean;
}

export interface Verification {
  verdict: "verified" | "not_verified";
  checks: { name: string; passed: boolean; evidence: string }[];
  criteria: { criterion: string; status: "met" | "not_met" | "unclear"; evidence: string; judgedBy: "reviewer-model" }[];
  reasons: string[];
}
