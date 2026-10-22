import "server-only";
import { ApiError } from "../http";
import { reportError } from "../observability";
import type { ServerSupabase } from "../supabase/server";
import { parseSettings, type WorkforceSettings } from "./settings";
import type { NewApproval, NewEvent, NewStep, NewTask, WorkforceStore } from "./store";
import type { Approval, MemoryEntry, Project, Step, Task, TaskStatus, WfEvent } from "./types";

/** Supabase-backed store. RLS restricts every row to the signed-in administrator. */
export class SupabaseStore implements WorkforceStore {
  constructor(
    private db: ServerSupabase,
    private userId: string,
  ) {}

  /** The database's own error text stays in the logs; the screen gets a plain message. */
  private fail(what: string, error?: { message?: string } | null): never {
    if (error) reportError(error, { where: `workforce store: ${what}` });
    throw new ApiError("internal", `Could not save or load ${what}.`);
  }

  async getSettings() {
    const { data } = await this.db.from("wf_settings").select("settings").eq("id", 1).maybeSingle();
    return parseSettings((data as { settings?: unknown } | null)?.settings);
  }
  async saveSettings(s: WorkforceSettings) {
    const { error } = await this.db.from("wf_settings").update({ settings: s, updated_by: this.userId }).eq("id", 1);
    if (error) this.fail("Workforce settings", error);
  }

  async listProjects() {
    const { data, error } = await this.db.from("wf_projects").select("*").eq("user_id", this.userId).order("created_at");
    if (error) this.fail("projects", error);
    return (data ?? []) as Project[];
  }
  async getProject(id: string) {
    const { data } = await this.db.from("wf_projects").select("*").eq("id", id).eq("user_id", this.userId).maybeSingle();
    return (data as Project | null) ?? null;
  }
  async createProject(p: Omit<Project, "id" | "created_at">) {
    const { data, error } = await this.db.from("wf_projects").insert({ ...p, user_id: this.userId }).select("*").single();
    if (error?.code === "23505") throw new ApiError("bad_request", "That repository and branch is already registered.");
    if (error || !data) this.fail("the project", error);
    return data as Project;
  }
  async updateProject(id: string, patch: Partial<Project>) {
    const { data } = await this.db.from("wf_projects").update(patch).eq("id", id).eq("user_id", this.userId).select("*").maybeSingle();
    return (data as Project | null) ?? null;
  }
  async deleteProject(id: string) {
    await this.db.from("wf_projects").delete().eq("id", id).eq("user_id", this.userId);
  }

  async createTask(t: NewTask) {
    const { data, error } = await this.db.from("wf_tasks").insert({ ...t, user_id: this.userId }).select("*").single();
    if (error || !data) this.fail("the task", error);
    return norm(data as Task);
  }
  async getTask(id: string) {
    const { data } = await this.db.from("wf_tasks").select("*").eq("id", id).eq("user_id", this.userId).maybeSingle();
    return data ? norm(data as Task) : null;
  }
  async listTasks(q: { projectId?: string; statuses?: TaskStatus[]; limit?: number } = {}) {
    let query = this.db.from("wf_tasks").select("*").eq("user_id", this.userId);
    if (q.projectId) query = query.eq("project_id", q.projectId);
    if (q.statuses) query = query.in("status", q.statuses);
    const { data, error } = await query.order("created_at", { ascending: false }).limit(q.limit ?? 200);
    if (error) this.fail("tasks", error);
    return ((data ?? []) as Task[]).map(norm);
  }
  async updateTask(id: string, patch: Partial<Task>) {
    const { data, error } = await this.db.from("wf_tasks").update(patch).eq("id", id).eq("user_id", this.userId).select("*").maybeSingle();
    if (error) this.fail("the task", error);
    return data ? norm(data as Task) : null;
  }
  async acquireLease(id: string, leaseId: string, ms: number) {
    const nowIso = new Date().toISOString();
    const { data, error } = await this.db
      .from("wf_tasks")
      .update({ lease_until: new Date(Date.now() + ms).toISOString(), lease_id: leaseId })
      .eq("id", id)
      .eq("user_id", this.userId)
      .or(`lease_until.is.null,lease_until.lt.${nowIso}`)
      .select("id");
    if (error) this.fail("the task lease", error);
    return (data?.length ?? 0) > 0;
  }
  async releaseLease(id: string, leaseId: string) {
    await this.db.from("wf_tasks").update({ lease_until: null, lease_id: null }).eq("id", id).eq("lease_id", leaseId);
  }

  async listSteps(taskId: string) {
    const { data, error } = await this.db.from("wf_steps").select("*").eq("task_id", taskId).eq("user_id", this.userId).order("created_at");
    if (error) this.fail("task steps", error);
    return ((data ?? []) as Step[]).map((s) => ({ ...s, cost_usd: s.cost_usd === null ? null : Number(s.cost_usd) }));
  }
  async listStepsFor(taskIds: string[]) {
    if (!taskIds.length) return [];
    const out: Step[] = [];
    for (let i = 0; i < taskIds.length; i += 100) {
      const { data } = await this.db.from("wf_steps").select("id,task_id,key,agent,agent_version,title,status,attempt,max_attempts,error,model_id,tokens,cost_usd,started_at,finished_at,created_at,depends_on,state,output").eq("user_id", this.userId).in("task_id", taskIds.slice(i, i + 100));
      out.push(...((data ?? []) as Step[]));
    }
    return out;
  }
  async createSteps(steps: NewStep[]) {
    if (!steps.length) return [];
    const { data, error } = await this.db
      .from("wf_steps")
      .insert(steps.map((s) => ({ ...s, user_id: this.userId })))
      .select("*");
    if (error) this.fail("task steps", error);
    return (data ?? []) as Step[];
  }
  async updateStep(id: string, patch: Partial<Step>) {
    const { data, error } = await this.db.from("wf_steps").update(patch).eq("id", id).eq("user_id", this.userId).select("*").maybeSingle();
    if (error) this.fail("the step", error);
    return (data as Step | null) ?? null;
  }

  async addEvent(e: NewEvent) {
    await this.db.from("wf_events").insert({ user_id: this.userId, task_id: e.task_id, step_key: e.step_key ?? null, level: e.level ?? "info", type: e.type, message: e.message.slice(0, 4000), data: e.data ?? {} });
  }
  async listEvents(taskId: string, afterId = 0, limit = 500) {
    const { data } = await this.db.from("wf_events").select("*").eq("task_id", taskId).eq("user_id", this.userId).gt("id", afterId).order("id").limit(limit);
    return (data ?? []) as WfEvent[];
  }
  async recentEvents(limit: number) {
    const { data } = await this.db.from("wf_events").select("*").eq("user_id", this.userId).order("id", { ascending: false }).limit(limit);
    return (data ?? []) as WfEvent[];
  }

  async createApproval(a: NewApproval) {
    const { data, error } = await this.db.from("wf_approvals").insert({ ...a, user_id: this.userId }).select("*").single();
    if (error || !data) this.fail("the approval", error);
    return data as Approval;
  }
  async listApprovals(q: { taskId?: string; status?: Approval["status"] } = {}) {
    let query = this.db.from("wf_approvals").select("*").eq("user_id", this.userId);
    if (q.taskId) query = query.eq("task_id", q.taskId);
    if (q.status) query = query.eq("status", q.status);
    const { data, error } = await query.order("created_at", { ascending: false }).limit(200);
    if (error) this.fail("approvals", error);
    return (data ?? []) as Approval[];
  }
  async updateApproval(id: string, patch: Partial<Approval>) {
    const { data } = await this.db.from("wf_approvals").update(patch).eq("id", id).eq("user_id", this.userId).select("*").maybeSingle();
    return (data as Approval | null) ?? null;
  }

  async addMemory(m: Omit<MemoryEntry, "id" | "created_at">) {
    await this.db.from("wf_memory").insert({ ...m, user_id: this.userId });
  }
  async listMemory(projectId: string, limit = 50) {
    const { data } = await this.db.from("wf_memory").select("*").eq("project_id", projectId).eq("user_id", this.userId).order("created_at", { ascending: false }).limit(limit);
    return (data ?? []) as MemoryEntry[];
  }
  async deleteMemory(id: string) {
    await this.db.from("wf_memory").delete().eq("id", id).eq("user_id", this.userId);
  }
  async purgeExpired(retentionDays: number) {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    await this.db.from("wf_events").delete().eq("user_id", this.userId).neq("level", "audit").lt("created_at", cutoff);
    await this.db.from("wf_memory").delete().eq("user_id", this.userId).lt("expires_at", new Date().toISOString());
  }
}

const norm = (t: Task): Task => ({ ...t, budget_usd: Number(t.budget_usd), spent_usd: Number(t.spent_usd), sandbox_ms: Number(t.sandbox_ms) });
