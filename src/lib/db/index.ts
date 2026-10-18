import "server-only";
import { ApiError } from "../http";
import type { ServerSupabase } from "../supabase/server";

/**
 * Data access layer. Every function receives the per-request Supabase client
 * (acting as the signed-in user), so Row Level Security is always applied.
 * Explicit `user_id` filters are added on top as defence in depth.
 */

export interface Project {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConversationRow {
  id: string;
  project_id: string | null;
  title: string;
  mode: string;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  model_id: string | null;
  usage_metadata: Record<string, unknown>;
  created_at: string;
}

function fail(error: { message: string; code?: string } | null, what: string): never {
  if (error?.code === "PGRST116") throw new ApiError("not_found", `${what} not found.`);
  throw new ApiError("internal", `Could not load ${what.toLowerCase()}.`);
}

// ─── projects ────────────────────────────────────────────────────────────────
export async function listProjects(db: ServerSupabase, userId: string, limit = 50): Promise<Project[]> {
  const { data, error } = await db
    .from("projects")
    .select("id,name,description,created_at,updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) fail(error, "Projects");
  return data as Project[];
}

export async function getProject(db: ServerSupabase, userId: string, id: string) {
  const { data, error } = await db
    .from("projects")
    .select("id,name,description,created_at,updated_at")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) fail(error, "Project");
  if (!data) throw new ApiError("not_found", "Project not found.");
  const [conversations, searches, comparisons, notes] = await Promise.all([
    db.from("conversations").select("id,title,mode,updated_at").eq("project_id", id).order("updated_at", { ascending: false }).limit(50),
    db.from("search_sessions").select("id,query,answer,created_at").eq("project_id", id).order("created_at", { ascending: false }).limit(50),
    db.from("model_comparisons").select("id,prompt,selected_models,comparison_metadata,created_at").eq("project_id", id).order("created_at", { ascending: false }).limit(50),
    db.from("project_notes").select("id,title,content,source_type,source_ref,created_at").eq("project_id", id).order("created_at", { ascending: false }).limit(100),
  ]);
  return {
    project: data as Project,
    conversations: conversations.data ?? [],
    searches: searches.data ?? [],
    comparisons: comparisons.data ?? [],
    notes: notes.data ?? [],
  };
}

export async function createProject(db: ServerSupabase, userId: string, input: { name: string; description?: string | null }) {
  const { data, error } = await db
    .from("projects")
    .insert({ user_id: userId, name: input.name, description: input.description ?? null })
    .select("id,name,description,created_at,updated_at")
    .single();
  if (error) fail(error, "Project");
  return data as Project;
}

export async function updateProject(
  db: ServerSupabase,
  userId: string,
  id: string,
  patch: { name?: string; description?: string | null },
) {
  const { data, error } = await db
    .from("projects")
    .update(patch)
    .eq("id", id)
    .eq("user_id", userId)
    .select("id,name,description,created_at,updated_at")
    .maybeSingle();
  if (error) fail(error, "Project");
  if (!data) throw new ApiError("not_found", "Project not found.");
  return data as Project;
}

export async function deleteProject(db: ServerSupabase, userId: string, id: string) {
  const { data, error } = await db.from("projects").delete().eq("id", id).eq("user_id", userId).select("id");
  if (error) fail(error, "Project");
  if (!data?.length) throw new ApiError("not_found", "Project not found.");
}

export async function assertProject(db: ServerSupabase, userId: string, projectId: string | null | undefined) {
  if (!projectId) return;
  const { data } = await db.from("projects").select("id").eq("id", projectId).eq("user_id", userId).maybeSingle();
  if (!data) throw new ApiError("not_found", "Project not found.");
}

export async function touchProject(db: ServerSupabase, projectId: string | null | undefined) {
  if (projectId) await db.from("projects").update({ updated_at: new Date().toISOString() }).eq("id", projectId);
}

export async function addNote(
  db: ServerSupabase,
  userId: string,
  projectId: string,
  note: { title: string; content: string; sourceType: "note" | "chat" | "search" | "comparison"; sourceRef?: string | null },
) {
  await assertProject(db, userId, projectId);
  const { data, error } = await db
    .from("project_notes")
    .insert({
      user_id: userId,
      project_id: projectId,
      title: note.title,
      content: note.content,
      source_type: note.sourceType,
      source_ref: note.sourceRef ?? null,
    })
    .select("id,title,content,source_type,source_ref,created_at")
    .single();
  if (error) fail(error, "Note");
  await touchProject(db, projectId);
  return data;
}

export async function deleteNote(db: ServerSupabase, userId: string, id: string) {
  const { data, error } = await db.from("project_notes").delete().eq("id", id).eq("user_id", userId).select("id");
  if (error) fail(error, "Note");
  if (!data?.length) throw new ApiError("not_found", "Note not found.");
}

// ─── conversations ───────────────────────────────────────────────────────────
export async function listConversations(db: ServerSupabase, userId: string, limit = 50): Promise<ConversationRow[]> {
  const { data, error } = await db
    .from("conversations")
    .select("id,project_id,title,mode,created_at,updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) fail(error, "Conversations");
  return data as ConversationRow[];
}

export async function getConversation(db: ServerSupabase, userId: string, id: string) {
  const { data, error } = await db
    .from("conversations")
    .select("id,project_id,title,mode,created_at,updated_at")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) fail(error, "Conversation");
  if (!data) throw new ApiError("not_found", "Conversation not found.");
  const { data: messages, error: mErr } = await db
    .from("messages")
    .select("id,conversation_id,role,content,model_id,usage_metadata,created_at")
    .eq("conversation_id", id)
    .order("created_at", { ascending: true })
    .limit(500);
  if (mErr) fail(mErr, "Messages");
  return { conversation: data as ConversationRow, messages: (messages ?? []) as MessageRow[] };
}

export async function createConversation(
  db: ServerSupabase,
  userId: string,
  input: { title: string; mode: string; projectId?: string | null },
) {
  await assertProject(db, userId, input.projectId);
  const { data, error } = await db
    .from("conversations")
    .insert({ user_id: userId, title: input.title, mode: input.mode, project_id: input.projectId ?? null })
    .select("id,project_id,title,mode,created_at,updated_at")
    .single();
  if (error) fail(error, "Conversation");
  return data as ConversationRow;
}

export async function updateConversation(
  db: ServerSupabase,
  userId: string,
  id: string,
  patch: { title?: string; mode?: string; project_id?: string | null },
) {
  if (patch.project_id) await assertProject(db, userId, patch.project_id);
  const { data, error } = await db
    .from("conversations")
    .update(patch)
    .eq("id", id)
    .eq("user_id", userId)
    .select("id,project_id,title,mode,created_at,updated_at")
    .maybeSingle();
  if (error) fail(error, "Conversation");
  if (!data) throw new ApiError("not_found", "Conversation not found.");
  return data as ConversationRow;
}

export async function deleteConversation(db: ServerSupabase, userId: string, id: string) {
  const { data, error } = await db.from("conversations").delete().eq("id", id).eq("user_id", userId).select("id");
  if (error) fail(error, "Conversation");
  if (!data?.length) throw new ApiError("not_found", "Conversation not found.");
}

export async function addMessages(
  db: ServerSupabase,
  conversationId: string,
  rows: { role: "user" | "assistant"; content: string; model_id?: string | null; usage_metadata?: Record<string, unknown> }[],
) {
  const { data, error } = await db
    .from("messages")
    .insert(rows.map((r) => ({ conversation_id: conversationId, ...r })))
    .select("id,role");
  if (error) fail(error, "Messages");
  await db.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);
  return data as { id: string; role: string }[];
}

// ─── searches & comparisons ─────────────────────────────────────────────────
export async function saveSearchSession(
  db: ServerSupabase,
  userId: string,
  input: {
    query: string;
    answer: string;
    modelId: string;
    projectId?: string | null;
    sources: { index: number; url: string; title: string; snippet: string; publishedAt: string | null }[];
  },
) {
  await assertProject(db, userId, input.projectId);
  const { data, error } = await db
    .from("search_sessions")
    .insert({ user_id: userId, query: input.query, answer: input.answer, model_id: input.modelId, project_id: input.projectId ?? null })
    .select("id")
    .single();
  if (error) fail(error, "Search session");
  if (input.sources.length) {
    await db.from("sources").insert(
      input.sources.map((s) => ({
        search_session_id: data.id,
        position: s.index,
        url: s.url,
        title: s.title,
        snippet: s.snippet,
        published_at: s.publishedAt,
      })),
    );
  }
  await touchProject(db, input.projectId);
  return data.id as string;
}

export async function moveSearchToProject(db: ServerSupabase, userId: string, searchId: string, projectId: string) {
  await assertProject(db, userId, projectId);
  const { data, error } = await db
    .from("search_sessions")
    .update({ project_id: projectId })
    .eq("id", searchId)
    .eq("user_id", userId)
    .select("id");
  if (error) fail(error, "Search session");
  if (!data?.length) throw new ApiError("not_found", "Search session not found.");
  await touchProject(db, projectId);
}

export async function listRecentSearches(db: ServerSupabase, userId: string, limit = 8) {
  const { data } = await db
    .from("search_sessions")
    .select("id,query,created_at,project_id")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  return data ?? [];
}

export async function saveComparison(
  db: ServerSupabase,
  userId: string,
  input: { prompt: string; selectedModels: string[]; metadata: Record<string, unknown>; projectId?: string | null },
) {
  await assertProject(db, userId, input.projectId);
  const { data, error } = await db
    .from("model_comparisons")
    .insert({
      user_id: userId,
      prompt: input.prompt,
      selected_models: input.selectedModels,
      comparison_metadata: input.metadata,
      project_id: input.projectId ?? null,
    })
    .select("id,created_at")
    .single();
  if (error) fail(error, "Comparison");
  await touchProject(db, input.projectId);
  return data;
}

export async function listComparisons(db: ServerSupabase, userId: string, limit = 20) {
  const { data } = await db
    .from("model_comparisons")
    .select("id,prompt,selected_models,comparison_metadata,created_at,project_id")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  return data ?? [];
}

// ─── favourites ─────────────────────────────────────────────────────────────
export async function listFavorites(db: ServerSupabase, userId: string) {
  const { data } = await db
    .from("favorite_models")
    .select("id,model_id,source,created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(200);
  return (data ?? []) as { id: string; model_id: string; source: string; created_at: string }[];
}

export async function addFavorite(db: ServerSupabase, userId: string, modelId: string, source: "hub" | "registry") {
  const { error } = await db
    .from("favorite_models")
    .upsert({ user_id: userId, model_id: modelId, source }, { onConflict: "user_id,model_id", ignoreDuplicates: true });
  if (error) fail(error, "Favorite");
}

export async function removeFavorite(db: ServerSupabase, userId: string, modelId: string) {
  const { error } = await db.from("favorite_models").delete().eq("user_id", userId).eq("model_id", modelId);
  if (error) fail(error, "Favorite");
}
