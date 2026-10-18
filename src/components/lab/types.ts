export type NodeType = "input" | "model_call" | "retrieval" | "transform" | "branch" | "approval" | "action" | "output";

export interface WfNode {
  id: string;
  type: NodeType;
  name: string;
  config: Record<string, unknown>;
  depends_on: string[];
  when?: { node: string; equals: boolean } | null;
  retry?: { max_attempts: number; backoff_s: number; retry_on?: string[] };
  timeout_s?: number;
  position?: { x: number; y: number } | null;
}

export interface InputDef {
  name: string;
  label?: string | null;
  type: "string" | "text" | "number" | "boolean" | "json";
  required: boolean;
  sensitive: boolean;
  default?: unknown;
}

export interface Spec {
  name: string;
  description: string;
  trigger: { type: "manual" | "schedule" | "webhook" | "radar_signal"; config: Record<string, unknown> };
  inputs: InputDef[];
  nodes: WfNode[];
  budget: { max_cost_usd: number; max_model_calls: number; max_tokens: number; max_steps: number; max_duration_s: number; unknown_price_policy: string };
  permissions: { tools: string[]; network_domains: string[]; allow_external_models: boolean; share_sensitive_with_models: boolean };
  outputs: string[];
}

export interface Validation {
  valid: boolean;
  errors: { node: string; message: string }[];
  warnings: { node: string; message: string }[];
  order: string[];
  estimate: { model_calls_max: number; output_tokens_max: number; cost_usd_max: number | null; consequential_steps: string[] } | null;
}

export interface Workflow {
  id: string;
  name: string;
  status: string;
  latest_version: number;
  draft: Spec;
  tests: unknown[];
  versions: { version: number; spec_hash: string; changelog: string | null; created_at: string }[];
  validation: Validation;
  draft_changed: boolean;
  updated_at: string;
}

export interface Tool {
  id: string;
  name: string;
  description: string;
  risk: "read" | "internal_write" | "external_send" | "irreversible";
  data_egress: boolean;
  consequential: boolean;
  required_params: string[];
  connector: string | null;
  implementation: string;
  notes: string;
  granted: boolean;
}

export interface Catalog {
  node_types: Record<NodeType, string>;
  tools: Tool[];
  approval_kinds: Record<string, string>;
  models: { id: string; label: string; simulated: boolean; priced: boolean }[];
  templates: { id: string; name: string; description: string; category: string; requires: string[]; node_count: number; tools: string[]; trigger: string }[];
}

export interface StepState {
  status: string;
  attempts: number;
  output?: unknown;
  trust?: "trusted" | "generated" | "untrusted";
  error?: string | null;
  flags?: string[];
  duration_ms?: number;
  model?: { id: string; served: string | null; simulated: boolean; input_tokens: number; output_tokens: number; cost_usd: number | null; latency_ms: number };
  skipped_reason?: string;
  approval_id?: string;
}

export interface Approval {
  id: string;
  run_id: string;
  step_id: string;
  kinds: string[];
  reasons: string[];
  payload: unknown;
  payload_hash: string;
  status: "pending" | "approved" | "rejected";
  decided_by: string | null;
  decided_at: string | null;
  note: string | null;
  created_at: string;
}

export interface Run {
  id: string;
  workflow_id: string;
  version: number;
  status: string;
  mode: string;
  inputs: Record<string, unknown>;
  state: { steps: Record<string, StepState>; usage: { model_calls: number; input_tokens: number; output_tokens: number; cost_usd: number; cost_unknown_calls: number; steps_run: number }; outputs: Record<string, unknown>; started_at?: string };
  error: string | null;
  created_at: string;
  finished_at: string | null;
  spec: Spec | null;
  events: { seq: number; ts: string; level: string; step_id: string | null; type: string; message: string; data: unknown }[];
  approvals: Approval[];
  outbox: { id: string; tool: string; status: string; payload: unknown; result: unknown; created_at: string }[];
}

export const TERMINAL = ["succeeded", "failed", "rejected", "cancelled", "budget_exceeded"];

export const RUN_TONE: Record<string, "default" | "accent" | "success" | "warning" | "danger"> = {
  queued: "default",
  running: "accent",
  waiting_approval: "warning",
  succeeded: "success",
  failed: "danger",
  rejected: "danger",
  cancelled: "default",
  budget_exceeded: "danger",
  interrupted: "warning",
};

export const STEP_TONE: Record<string, "default" | "accent" | "success" | "warning" | "danger"> = {
  pending: "default",
  running: "accent",
  retrying: "warning",
  waiting_approval: "warning",
  succeeded: "success",
  failed: "danger",
  skipped: "default",
  blocked: "danger",
  cancelled: "default",
};

export const NODE_COLOR: Record<NodeType, string> = {
  input: "#4f8bff",
  model_call: "#7c6cff",
  retrieval: "#3ccf91",
  transform: "#9a9ab3",
  branch: "#f2b24c",
  approval: "#ff9f43",
  action: "#ff6b7a",
  output: "#4fd1c5",
};
