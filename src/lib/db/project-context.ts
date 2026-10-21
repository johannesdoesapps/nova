import "server-only";
import { ApiError } from "../http";
import { MAX_NOTES, readContextSettings, writeContextSettings, type ContextSettings, type ProjectContextInput } from "../projects/context";
import type { ServerSupabase } from "../supabase/server";

/** Project context for chats. Every read is limited to the user's own rows (and row-level security applies). */

const fail = (what: string): never => {
  throw new ApiError("internal", `Could not load ${what}.`);
};

async function readPrefs(db: ServerSupabase, userId: string): Promise<Record<string, unknown>> {
  const { data, error } = await db.from("profiles").select("preferences").eq("id", userId).maybeSingle();
  if (error) fail("your preferences");
  return (data?.preferences as Record<string, unknown> | null) ?? {};
}

/** What one project shares with its chats: its instructions and the user's choices, plus notes when allowed. Null if it isn't the user's. */
export async function getProjectContext(db: ServerSupabase, userId: string, projectId: string): Promise<ProjectContextInput | null> {
  const [project, prefs] = await Promise.all([db.from("projects").select("name,description").eq("id", projectId).eq("user_id", userId).maybeSingle(), readPrefs(db, userId)]);
  if (project.error) fail("the project");
  if (!project.data) return null;
  const settings = readContextSettings(prefs, projectId);
  let notes: { title: string; content: string }[] = [];
  if (settings.notes) {
    const r = await db.from("project_notes").select("title,content").eq("project_id", projectId).eq("user_id", userId).order("created_at", { ascending: false }).limit(MAX_NOTES);
    if (r.error) fail("the project's notes");
    notes = (r.data ?? []) as typeof notes;
  }
  return { name: project.data.name as string, instructions: (project.data.description as string | null) ?? null, notes, settings };
}

/** Change what one of the user's projects shares with its chats. */
export async function setProjectContext(db: ServerSupabase, userId: string, projectId: string, patch: Partial<ContextSettings>): Promise<ContextSettings> {
  const { data: project, error } = await db.from("projects").select("id").eq("id", projectId).eq("user_id", userId).maybeSingle();
  if (error) fail("the project");
  if (!project) throw new ApiError("not_found", "Project not found.");
  const prefs = await readPrefs(db, userId);
  const next = writeContextSettings(prefs, projectId, patch);
  const { error: uErr } = await db.from("profiles").update({ preferences: next }).eq("id", userId);
  if (uErr) throw new ApiError("internal", "Could not save your choice.");
  return readContextSettings(next, projectId);
}
