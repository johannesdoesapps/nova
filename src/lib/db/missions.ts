import "server-only";
import { ApiError } from "../http";
import type { TaskStatus } from "../missions/schema";
import type { ServerSupabase } from "../supabase/server";

/** Mission Control data. Row Level Security limits every query to the owner. */

export interface MissionRow {
  id: string;
  name: string;
  description: string | null;
  goal: string | null;
  status: "active" | "paused" | "completed" | "archived";
  created_at: string;
  updated_at: string;
}

export interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  milestone: string | null;
  status: TaskStatus;
  priority: "low" | "medium" | "high";
  position: number;
  ai_suitable: boolean;
  output: string | null;
  output_model: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunRow {
  id: string;
  task_id: string;
  model_id: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

const MISSION_COLS = "id,name,description,goal,status,created_at,updated_at";
const TASK_COLS = "id,project_id,title,description,milestone,status,priority,position,ai_suitable,output,output_model,completed_at,created_at,updated_at";

const fail = (what: string): never => {
  throw new ApiError("internal", `Could not save or load ${what}.`);
};

export async function listMissions(db: ServerSupabase, userId: string) {
  const { data, error } = await db.from("projects").select(MISSION_COLS).eq("user_id", userId).order("updated_at", { ascending: false }).limit(100);
  if (error) fail("missions");
  const missions = (data ?? []) as MissionRow[];
  if (!missions.length) return [];
  const { data: tasks } = await db.from("project_tasks").select("project_id,status").eq("user_id", userId).in("project_id", missions.map((m) => m.id));
  const counts = new Map<string, Record<TaskStatus, number>>();
  for (const t of (tasks ?? []) as { project_id: string; status: TaskStatus }[]) {
    const c = counts.get(t.project_id) ?? { pending: 0, in_progress: 0, completed: 0, blocked: 0, cancelled: 0 };
    c[t.status] += 1;
    counts.set(t.project_id, c);
  }
  return missions.map((m) => ({ ...m, counts: counts.get(m.id) ?? { pending: 0, in_progress: 0, completed: 0, blocked: 0, cancelled: 0 } }));
}

export async function getMission(db: ServerSupabase, userId: string, id: string) {
  const { data, error } = await db.from("projects").select(MISSION_COLS).eq("id", id).eq("user_id", userId).maybeSingle();
  if (error) fail("the mission");
  if (!data) throw new ApiError("not_found", "Mission not found.");
  const [tasks, runs, notes, conversations] = await Promise.all([
    db.from("project_tasks").select(TASK_COLS).eq("project_id", id).order("position").limit(200),
    db.from("task_runs").select("id,task_id,model_id,status,error,started_at,finished_at").eq("project_id", id).order("started_at", { ascending: false }).limit(100),
    db.from("project_notes").select("id,title,content,source_type,created_at").eq("project_id", id).order("created_at", { ascending: false }).limit(100),
    db.from("conversations").select("id,title,updated_at").eq("project_id", id).order("updated_at", { ascending: false }).limit(30),
  ]);
  return {
    mission: data as MissionRow,
    tasks: (tasks.data ?? []) as TaskRow[],
    runs: (runs.data ?? []) as RunRow[],
    notes: notes.data ?? [],
    conversations: conversations.data ?? [],
  };
}

export async function createMission(
  db: ServerSupabase,
  userId: string,
  input: { name: string; goal: string; description: string; tasks: { title: string; description: string; milestone: string | null; priority: string; aiSuitable: boolean }[] },
) {
  const { data, error } = await db
    .from("projects")
    .insert({ user_id: userId, name: input.name, goal: input.goal || null, description: input.description || null })
    .select(MISSION_COLS)
    .single();
  if (error || !data) fail("the mission");
  const mission = data as MissionRow;
  if (input.tasks.length) {
    const { error: e2 } = await db.from("project_tasks").insert(
      input.tasks.map((t, i) => ({
        user_id: userId,
        project_id: mission.id,
        title: t.title,
        description: t.description,
        milestone: t.milestone,
        priority: t.priority,
        ai_suitable: t.aiSuitable,
        position: i,
      })),
    );
    if (e2) {
      // Don't leave a half-created mission behind.
      await db.from("projects").delete().eq("id", mission.id).eq("user_id", userId);
      fail("the mission's tasks");
    }
  }
  return mission;
}

export async function updateMission(db: ServerSupabase, userId: string, id: string, patch: { name?: string; goal?: string; status?: string }) {
  const { data, error } = await db.from("projects").update(patch).eq("id", id).eq("user_id", userId).select(MISSION_COLS).maybeSingle();
  if (error) fail("the mission");
  if (!data) throw new ApiError("not_found", "Mission not found.");
  return data as MissionRow;
}

export async function getTask(db: ServerSupabase, userId: string, taskId: string): Promise<TaskRow> {
  const { data, error } = await db.from("project_tasks").select(TASK_COLS).eq("id", taskId).eq("user_id", userId).maybeSingle();
  if (error) fail("the task");
  if (!data) throw new ApiError("not_found", "Task not found.");
  return data as TaskRow;
}

export async function addTask(
  db: ServerSupabase,
  userId: string,
  projectId: string,
  t: { title: string; description: string; milestone: string | null; priority: string; aiSuitable: boolean },
) {
  const { data: last } = await db.from("project_tasks").select("position").eq("project_id", projectId).order("position", { ascending: false }).limit(1).maybeSingle();
  const { data, error } = await db
    .from("project_tasks")
    .insert({
      user_id: userId,
      project_id: projectId,
      title: t.title,
      description: t.description,
      milestone: t.milestone,
      priority: t.priority,
      ai_suitable: t.aiSuitable,
      position: ((last as { position: number } | null)?.position ?? -1) + 1,
    })
    .select(TASK_COLS)
    .single();
  if (error) fail("the task");
  return data as TaskRow;
}

export async function updateTask(db: ServerSupabase, userId: string, taskId: string, patch: Record<string, unknown>) {
  const { data, error } = await db.from("project_tasks").update(patch).eq("id", taskId).eq("user_id", userId).select(TASK_COLS).maybeSingle();
  if (error) fail("the task");
  if (!data) throw new ApiError("not_found", "Task not found.");
  return data as TaskRow;
}

export async function deleteTask(db: ServerSupabase, userId: string, taskId: string) {
  const { data, error } = await db.from("project_tasks").delete().eq("id", taskId).eq("user_id", userId).select("id");
  if (error) fail("the task");
  if (!data?.length) throw new ApiError("not_found", "Task not found.");
}

export async function startRun(db: ServerSupabase, userId: string, task: TaskRow, modelId: string): Promise<string> {
  const { data, error } = await db
    .from("task_runs")
    .insert({ user_id: userId, task_id: task.id, project_id: task.project_id, model_id: modelId, status: "running" })
    .select("id")
    .single();
  if (error || !data) fail("the task run");
  return (data as { id: string }).id;
}

export async function finishRun(db: ServerSupabase, runId: string, result: { status: "succeeded" | "failed" | "cancelled"; output?: string; error?: string }) {
  await db
    .from("task_runs")
    .update({ status: result.status, output: result.output?.slice(0, 60000) ?? null, error: result.error?.slice(0, 2000) ?? null, finished_at: new Date().toISOString() })
    .eq("id", runId);
}
