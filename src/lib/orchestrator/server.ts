import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isAdmin } from "../admin";
import { recordAdminAction } from "../admin-audit";
import { requireUser } from "../auth";
import type { Authed } from "../code/server";
import { ApiError } from "../http";
import { limiter } from "../rate-limit";
import { serviceSupabase } from "../supabase/admin";
import { orchestratorPaused } from "./background";
import { classifyError } from "./errors";
import { checkProfileModel, orbisGateway } from "./providers";
import {
  agentView,
  attemptView,
  isOrchTool,
  NOT_YET_AVAILABLE_TOOLS,
  taskView,
  type AgentInput,
  type AgentPatch,
  type AgentRow,
  type AttemptRow,
  type TaskInput,
  type TaskRow,
  type TaskStatus,
} from "./types";

/**
 * The orchestrator's server-side operations, used by the /api/orchestrator routes. Every operation runs as the
 * signed-in administrator through their own Supabase session, so row-level security applies on top of these
 * checks: an administrator only sees and changes their own agents and tasks. Only queue changes that a user may
 * not make directly (dispatch, finishing attempts, live provider checks) use the service role.
 */

/** A signed-in administrator, or a 401/403. The orchestrator is limited to administrators (operators). */
export async function requireOrchestrator(perMinute = 120): Promise<Authed> {
  const auth = await requireUser();
  if (!(await isAdmin(auth))) throw new ApiError("forbidden", "The orchestrator is limited to Orbis administrators.");
  if (!limiter("orchestrator", perMinute, 60_000).check(`u:${auth.user.id}`, 1).ok) throw new ApiError("rate_limited", "Too many requests. Please wait a moment.");
  return auth;
}

/** Database errors as API errors (the database enforces the same rules as the schemas). */
export function dbFailure(error: { code?: string; message: string }, what: string): ApiError {
  if (error.code === "23505") return new ApiError("conflict", `${what}: an agent with this name already exists.`);
  if (error.code === "23514" || error.code === "22P02" || error.code === "22023") return new ApiError("bad_request", `${what}: ${error.message.replace(/^.*?: /, "").slice(0, 300)}`);
  if (error.code === "42501" || error.code === "P0002") return new ApiError("not_found", `${what}: ${/not found/i.test(error.message) ? error.message.slice(0, 200) : "not found."}`);
  return new ApiError("internal", `${what} failed.`);
}

const db = (auth: Authed) => auth.supabase as unknown as SupabaseClient;

// ---------------------------------------------------------------- agents

/** Tools and model for a profile; refuses unknown or not-yet-available tools and unknown providers/models. */
async function checkProfile(provider: string, modelId: string, tools: string[]): Promise<string[]> {
  const bad = tools.filter((t) => !isOrchTool(t));
  if (bad.length) {
    const later = bad.filter((t) => (NOT_YET_AVAILABLE_TOOLS as readonly string[]).includes(t));
    throw new ApiError("bad_request", later.length ? `Not available to orchestrator agents yet: ${later.join(", ")}. Only read_project exists in this phase.` : `Unknown tool${bad.length > 1 ? "s" : ""}: ${bad.join(", ")}.`);
  }
  const check = await checkProfileModel(provider, modelId, tools);
  if (check.errors.length) throw new ApiError("bad_request", check.errors.join(" "));
  return check.warnings;
}

const agentColumns = (a: Partial<AgentInput>) => ({
  ...(a.name !== undefined && { name: a.name }),
  ...(a.description !== undefined && { description: a.description }),
  ...(a.role !== undefined && { role: a.role }),
  ...(a.provider !== undefined && { provider: a.provider }),
  ...(a.modelId !== undefined && { model_id: a.modelId }),
  ...(a.systemInstructions !== undefined && { system_instructions: a.systemInstructions }),
  ...(a.enabled !== undefined && { enabled: a.enabled }),
  ...(a.allowedTools !== undefined && { allowed_tools: [...new Set(a.allowedTools)] }),
  ...(a.permissions !== undefined && { permissions: a.permissions }),
  ...(a.taskTypes !== undefined && { task_types: [...new Set(a.taskTypes)] }),
  ...(a.priority !== undefined && { priority: a.priority }),
  ...(a.timeoutSeconds !== undefined && { timeout_seconds: a.timeoutSeconds }),
  ...(a.maxAttempts !== undefined && { max_attempts: a.maxAttempts }),
  ...(a.retryBackoffSeconds !== undefined && { retry_backoff_seconds: a.retryBackoffSeconds }),
  ...(a.maxOutputTokens !== undefined && { max_output_tokens: a.maxOutputTokens }),
  ...(a.maxTurns !== undefined && { max_turns: a.maxTurns }),
});

export async function listAgents(auth: Authed) {
  const { data, error } = await db(auth).from("orch_agents").select("*").order("created_at", { ascending: true });
  if (error) throw dbFailure(error, "Listing agents");
  return (data as AgentRow[]).map(agentView);
}

async function agentRow(auth: Authed, id: string): Promise<AgentRow> {
  const { data, error } = await db(auth).from("orch_agents").select("*").eq("id", id).maybeSingle();
  if (error) throw dbFailure(error, "Reading the agent");
  if (!data) throw new ApiError("not_found", "Agent not found.");
  return data as AgentRow;
}
export const getAgent = async (auth: Authed, id: string) => agentView(await agentRow(auth, id));

export async function createAgent(auth: Authed, input: AgentInput) {
  const warnings = await checkProfile(input.provider, input.modelId, input.allowedTools);
  const { data, error } = await db(auth).from("orch_agents").insert(agentColumns(input)).select("*").single();
  if (error) throw dbFailure(error, "Creating the agent");
  const row = data as AgentRow;
  await recordAdminAction(db(auth), "orchestrator.agent.create", row.name, { id: row.id, role: row.role, provider: row.provider, model: row.model_id, enabled: row.enabled, tools: row.allowed_tools });
  return { agent: agentView(row), warnings };
}

export async function updateAgent(auth: Authed, id: string, patch: AgentPatch) {
  const before = await agentRow(auth, id);
  const provider = patch.provider ?? before.provider;
  const modelId = patch.modelId ?? before.model_id;
  const tools = patch.allowedTools ?? before.allowed_tools;
  const warnings = patch.provider !== undefined || patch.modelId !== undefined || patch.allowedTools !== undefined ? await checkProfile(provider, modelId, tools) : [];
  const { data, error } = await db(auth).from("orch_agents").update(agentColumns(patch)).eq("id", id).select("*").maybeSingle();
  if (error) throw dbFailure(error, "Updating the agent");
  if (!data) throw new ApiError("not_found", "Agent not found.");
  const row = data as AgentRow;
  const action = patch.enabled !== undefined && Object.keys(patch).length === 1 ? (patch.enabled ? "orchestrator.agent.enable" : "orchestrator.agent.disable") : "orchestrator.agent.update";
  await recordAdminAction(db(auth), action, row.name, { id, changed: Object.keys(patch) });
  return { agent: agentView(row), warnings };
}

/** Delete a profile. Its tasks and attempts stay (they keep the agent's name and model); a running one blocks deletion. */
export async function deleteAgent(auth: Authed, id: string) {
  const row = await agentRow(auth, id);
  const { data: running } = await db(auth).from("orch_attempts").select("id").eq("agent_id", id).eq("status", "running").limit(1);
  if ((running as unknown[] | null)?.length) throw new ApiError("conflict", "This agent is running a task right now. Cancel the task or wait for it to finish, then delete the agent.");
  const { error } = await db(auth).from("orch_agents").delete().eq("id", id);
  if (error) throw dbFailure(error, "Deleting the agent");
  await recordAdminAction(db(auth), "orchestrator.agent.delete", row.name, { id, provider: row.provider, model: row.model_id });
  return { deleted: true };
}

export async function agentTasks(auth: Authed, id: string, limit = 50) {
  await agentRow(auth, id);
  const { data, error } = await db(auth).from("orch_tasks").select("*").eq("agent_id", id).order("created_at", { ascending: false }).limit(limit);
  if (error) throw dbFailure(error, "Listing the agent's tasks");
  return (data as TaskRow[]).map(taskView);
}

// ---------------------------------------------------------------- tasks

export async function createTask(auth: Authed, input: TaskInput) {
  let agent: AgentRow | null = null;
  if (input.agentId) {
    agent = await agentRow(auth, input.agentId);
    if (!agent.enabled) throw new ApiError("conflict", `Agent "${agent.name}" is disabled, so it can't take new tasks. Enable it first.`);
  }
  const { data, error } = await db(auth)
    .from("orch_tasks")
    .insert({
      project_id: input.projectId,
      kind: input.kind,
      task_type: input.taskType ?? (input.kind === "plan" ? "plan" : "general"),
      title: input.title,
      input: input.input,
      agent_id: agent?.id ?? null,
      agent_locked: !!agent,
      priority: input.priority,
      depends_on: [...new Set(input.dependsOn)],
      // Without its own limit, the task follows the retry policy of the agent that runs it (set at its first dispatch).
      ...(input.maxAttempts !== undefined && { max_attempts: input.maxAttempts, retry_backoff_seconds: agent?.retry_backoff_seconds ?? 30, policy_from_agent: false }),
    })
    .select("*")
    .single();
  if (error) throw dbFailure(error, "Creating the task");
  return taskView(data as TaskRow);
}

export async function listTasks(auth: Authed, f: { status?: TaskStatus; projectId?: string; agentId?: string; limit?: number }) {
  let q = db(auth).from("orch_tasks").select("*");
  if (f.status) q = q.eq("status", f.status);
  if (f.projectId) q = q.eq("project_id", f.projectId);
  if (f.agentId) q = q.eq("agent_id", f.agentId);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(Math.min(200, f.limit ?? 50));
  if (error) throw dbFailure(error, "Listing tasks");
  return (data as TaskRow[]).map(taskView);
}

export async function getTask(auth: Authed, id: string) {
  const { data, error } = await db(auth).from("orch_tasks").select("*").eq("id", id).maybeSingle();
  if (error) throw dbFailure(error, "Reading the task");
  if (!data) throw new ApiError("not_found", "Task not found.");
  const [attempts, events, children] = await Promise.all([
    db(auth).from("orch_attempts").select("*").eq("task_id", id).order("attempt_no", { ascending: true }),
    db(auth).from("orch_events").select("id, kind, from_status, to_status, detail, created_at").eq("task_id", id).order("id", { ascending: true }).limit(300),
    db(auth).from("orch_tasks").select("*").eq("parent_id", id).order("created_at", { ascending: true }),
  ]);
  return {
    task: taskView(data as TaskRow),
    attempts: ((attempts.data ?? []) as AttemptRow[]).map(attemptView),
    events: (events.data ?? []) as { id: number; kind: string; from_status: string | null; to_status: string | null; detail: Record<string, unknown>; created_at: string }[],
    subtasks: ((children.data ?? []) as TaskRow[]).map(taskView),
  };
}

export async function cancelTask(auth: Authed, id: string) {
  const { data, error } = await db(auth).rpc("orch_cancel", { p_task: id });
  if (error) throw dbFailure(error, "Cancelling the task");
  return { status: data as string };
}

// ---------------------------------------------------------------- settings, slots and providers

export async function getSettings(auth: Authed) {
  const [settings, slots] = await Promise.all([db(auth).from("orch_settings").select("max_concurrency, updated_at").eq("id", 1).maybeSingle(), db(auth).from("orch_slots").select("*").order("slot_no", { ascending: true })]);
  if (settings.error || !settings.data) throw new ApiError("forbidden", "The orchestrator settings aren't available.");
  const rows = (slots.data ?? []) as { slot_no: number; lease_id: string | null; task_id: string | null; owner_id: string | null; purpose: string | null; acquired_at: string | null; expires_at: string | null }[];
  return {
    maxConcurrency: (settings.data as { max_concurrency: number }).max_concurrency,
    hardLimit: 3,
    slots: rows.map((s) => ({
      slot: s.slot_no,
      busy: !!s.lease_id,
      purpose: s.purpose,
      // Another administrator's task id isn't shown.
      taskId: s.owner_id === auth.user.id ? s.task_id : null,
      acquiredAt: s.acquired_at,
      expiresAt: s.expires_at,
    })),
  };
}

export async function updateSettings(auth: Authed, maxConcurrency: number) {
  const { data, error } = await db(auth).from("orch_settings").update({ max_concurrency: maxConcurrency, updated_by: auth.user.id, updated_at: new Date().toISOString() }).eq("id", 1).select("max_concurrency").maybeSingle();
  if (error) throw dbFailure(error, "Saving the settings");
  if (!data) throw new ApiError("forbidden", "Only administrators can change the orchestrator settings.");
  await recordAdminAction(db(auth), "orchestrator.settings", "max_concurrency", { maxConcurrency });
  return getSettings(auth);
}

/**
 * A real call to a provider (a few tokens), to confirm its credentials and the model work. It's a model execution
 * like any other: it takes one of the global slots (refused when all are busy) and is metered to the caller.
 */
export async function liveProviderCheck(auth: Authed, provider: string, modelId: string) {
  const svc = serviceSupabase();
  if (!svc) throw new ApiError("not_configured", "SUPABASE_SERVICE_ROLE_KEY isn't set, so the orchestrator can't take an execution slot.");
  const paused = await orchestratorPaused();
  if (paused) throw new ApiError("forbidden", paused);
  const { data: slot, error } = await svc.rpc("orch_acquire_slot", { p_seconds: 30, p_purpose: "provider_check", p_owner: auth.user.id });
  if (error) throw new ApiError("internal", "Couldn't take an execution slot.");
  if (!slot) throw new ApiError("rate_limited", "All execution slots are busy right now (at most 3 model executions run at once). Try again shortly.");
  const t0 = Date.now();
  try {
    const model = await orbisGateway.resolve(provider, modelId);
    const r = await orbisGateway.call(auth, model, { system: "You check that an AI model works.", messages: [{ role: "user", text: "Reply with the single word OK." }], tools: [], maxOutputTokens: 16, signal: AbortSignal.timeout(30_000) }, { taskId: "provider-check", purpose: "provider_check" });
    return { ok: true, provider, modelId, latencyMs: Date.now() - t0, reply: r.text.trim().slice(0, 40), capabilities: model.capabilities };
  } catch (err) {
    const c = classifyError(err);
    return { ok: false, provider, modelId, latencyMs: Date.now() - t0, errorKind: c.kind, error: c.message };
  } finally {
    await svc.rpc("orch_release_slot", { p_lease: (slot as { lease: string }).lease });
  }
}
