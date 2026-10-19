import { parseSettings, type WorkforceSettings } from "./settings";
import type { Approval, MemoryEntry, Project, Step, Task, TaskStatus, WfEvent } from "./types";

/**
 * Persistence for the Workforce. The orchestrator only talks to this
 * interface, so it runs the same against Supabase (production) and the
 * in-memory store (tests).
 */
export interface WorkforceStore {
  getSettings(): Promise<WorkforceSettings>;
  saveSettings(s: WorkforceSettings): Promise<void>;

  listProjects(): Promise<Project[]>;
  getProject(id: string): Promise<Project | null>;
  createProject(p: Omit<Project, "id" | "created_at">): Promise<Project>;
  updateProject(id: string, patch: Partial<Project>): Promise<Project | null>;
  deleteProject(id: string): Promise<void>;

  createTask(t: NewTask): Promise<Task>;
  getTask(id: string): Promise<Task | null>;
  listTasks(q?: { projectId?: string; statuses?: TaskStatus[]; limit?: number }): Promise<Task[]>;
  updateTask(id: string, patch: Partial<Task>): Promise<Task | null>;
  /** Atomically take the task's lease if it is free or expired. */
  acquireLease(id: string, leaseId: string, ms: number): Promise<boolean>;
  releaseLease(id: string, leaseId: string): Promise<void>;

  listSteps(taskId: string): Promise<Step[]>;
  listStepsFor(taskIds: string[]): Promise<Step[]>;
  createSteps(steps: NewStep[]): Promise<Step[]>;
  updateStep(id: string, patch: Partial<Step>): Promise<Step | null>;

  addEvent(e: NewEvent): Promise<void>;
  listEvents(taskId: string, afterId?: number, limit?: number): Promise<WfEvent[]>;
  recentEvents(limit: number): Promise<WfEvent[]>;

  createApproval(a: NewApproval): Promise<Approval>;
  listApprovals(q?: { taskId?: string; status?: Approval["status"] }): Promise<Approval[]>;
  updateApproval(id: string, patch: Partial<Approval>): Promise<Approval | null>;

  addMemory(m: Omit<MemoryEntry, "id" | "created_at">): Promise<void>;
  listMemory(projectId: string, limit?: number): Promise<MemoryEntry[]>;
  deleteMemory(id: string): Promise<void>;
  purgeExpired(retentionDays: number): Promise<void>;
}

export type NewTask = Pick<Task, "project_id" | "title" | "objective" | "acceptance_criteria" | "priority" | "risk" | "autonomy" | "budget_usd" | "token_budget" | "benchmark" | "versions">;
export type NewStep = Pick<Step, "task_id" | "key" | "agent" | "agent_version" | "title" | "depends_on" | "max_attempts" | "input">;
export type NewEvent = { task_id: string | null; step_key?: string | null; level?: WfEvent["level"]; type: string; message: string; data?: Record<string, unknown> };
export type NewApproval = Pick<Approval, "task_id" | "kind" | "title" | "reason" | "risk" | "payload" | "payload_hash">;

const now = () => new Date().toISOString();

export function taskDefaults(t: NewTask, userId: string): Task {
  return {
    id: crypto.randomUUID(),
    user_id: userId,
    ...t,
    status: "created",
    status_reason: null,
    plan: null,
    plan_hash: null,
    spent_usd: 0,
    spent_unpriced_calls: 0,
    tokens_used: 0,
    sandbox_name: null,
    sandbox_ms: 0,
    diff: null,
    changed_files: [],
    verification: null,
    report: null,
    cancel_requested: false,
    lease_until: null,
    lease_id: null,
    ticks: 0,
    created_at: now(),
    updated_at: now(),
    started_at: null,
    finished_at: null,
  };
}

/** In-memory store used by tests and local runs without Supabase. */
export class MemoryStore implements WorkforceStore {
  settings: WorkforceSettings = parseSettings({});
  projects: Project[] = [];
  tasks: Task[] = [];
  steps: Step[] = [];
  events: WfEvent[] = [];
  approvals: Approval[] = [];
  memory: MemoryEntry[] = [];
  private eventId = 1;
  constructor(private userId = "00000000-0000-4000-8000-000000000001") {}

  async getSettings() {
    return this.settings;
  }
  async saveSettings(s: WorkforceSettings) {
    this.settings = s;
  }
  async listProjects() {
    return [...this.projects];
  }
  async getProject(id: string) {
    return this.projects.find((p) => p.id === id) ?? null;
  }
  async createProject(p: Omit<Project, "id" | "created_at">) {
    const row = { ...p, id: crypto.randomUUID(), created_at: now() };
    this.projects.push(row);
    return row;
  }
  async updateProject(id: string, patch: Partial<Project>) {
    const p = this.projects.find((x) => x.id === id);
    if (!p) return null;
    Object.assign(p, patch);
    return p;
  }
  async deleteProject(id: string) {
    this.projects = this.projects.filter((p) => p.id !== id);
    const taskIds = new Set(this.tasks.filter((t) => t.project_id === id).map((t) => t.id));
    this.tasks = this.tasks.filter((t) => !taskIds.has(t.id));
    this.steps = this.steps.filter((s) => !taskIds.has(s.task_id));
  }
  async createTask(t: NewTask) {
    const row = taskDefaults(t, this.userId);
    this.tasks.push(row);
    return { ...row };
  }
  async getTask(id: string) {
    const t = this.tasks.find((x) => x.id === id);
    return t ? { ...t } : null;
  }
  async listTasks(q: { projectId?: string; statuses?: TaskStatus[]; limit?: number } = {}) {
    return this.tasks
      .filter((t) => (!q.projectId || t.project_id === q.projectId) && (!q.statuses || q.statuses.includes(t.status)))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, q.limit ?? 200)
      .map((t) => ({ ...t }));
  }
  async updateTask(id: string, patch: Partial<Task>) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return null;
    Object.assign(t, patch, { updated_at: now() });
    return { ...t };
  }
  async acquireLease(id: string, leaseId: string, ms: number) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return false;
    if (t.lease_until && t.lease_until > now()) return false;
    t.lease_until = new Date(Date.now() + ms).toISOString();
    t.lease_id = leaseId;
    return true;
  }
  async releaseLease(id: string, leaseId: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (t && t.lease_id === leaseId) {
      t.lease_until = null;
      t.lease_id = null;
    }
  }
  async listSteps(taskId: string) {
    return this.steps.filter((s) => s.task_id === taskId).map((s) => ({ ...s }));
  }
  async listStepsFor(taskIds: string[]) {
    const ids = new Set(taskIds);
    return this.steps.filter((s) => ids.has(s.task_id)).map((s) => ({ ...s }));
  }
  async createSteps(steps: NewStep[]) {
    const rows: Step[] = steps.map((s) => {
      if (this.steps.some((x) => x.task_id === s.task_id && x.key === s.key)) throw new Error(`duplicate step key ${s.key}`);
      return { ...s, id: crypto.randomUUID(), status: "pending", attempt: 0, output: null, state: {}, error: null, model_id: null, tokens: 0, cost_usd: null, started_at: null, finished_at: null, created_at: now() };
    });
    this.steps.push(...rows);
    return rows.map((r) => ({ ...r }));
  }
  async updateStep(id: string, patch: Partial<Step>) {
    const s = this.steps.find((x) => x.id === id);
    if (!s) return null;
    Object.assign(s, patch);
    return { ...s };
  }
  async addEvent(e: NewEvent) {
    this.events.push({ id: this.eventId++, task_id: e.task_id, step_key: e.step_key ?? null, level: e.level ?? "info", type: e.type, message: e.message, data: e.data ?? {}, created_at: now() });
  }
  async listEvents(taskId: string, afterId = 0, limit = 500) {
    return this.events.filter((e) => e.task_id === taskId && e.id > afterId).slice(0, limit);
  }
  async recentEvents(limit: number) {
    return this.events.slice(-limit).reverse();
  }
  async createApproval(a: NewApproval) {
    const row: Approval = { ...a, id: crypto.randomUUID(), status: "pending", decided_at: null, decision_note: null, created_at: now() };
    this.approvals.push(row);
    return { ...row };
  }
  async listApprovals(q: { taskId?: string; status?: Approval["status"] } = {}) {
    return this.approvals.filter((a) => (!q.taskId || a.task_id === q.taskId) && (!q.status || a.status === q.status)).map((a) => ({ ...a }));
  }
  async updateApproval(id: string, patch: Partial<Approval>) {
    const a = this.approvals.find((x) => x.id === id);
    if (!a) return null;
    Object.assign(a, patch);
    return { ...a };
  }
  async addMemory(m: Omit<MemoryEntry, "id" | "created_at">) {
    this.memory.push({ ...m, id: crypto.randomUUID(), created_at: now() });
  }
  async listMemory(projectId: string, limit = 50) {
    return this.memory.filter((m) => m.project_id === projectId).slice(-limit).reverse();
  }
  async deleteMemory(id: string) {
    this.memory = this.memory.filter((m) => m.id !== id);
  }
  async purgeExpired(retentionDays: number) {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    this.events = this.events.filter((e) => e.level === "audit" || e.created_at >= cutoff);
    this.memory = this.memory.filter((m) => !m.expires_at || m.expires_at > now());
  }
}
