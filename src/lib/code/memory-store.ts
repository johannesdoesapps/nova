import "server-only";
import { ApiError } from "@/lib/http";
import type { MemoryEntry, MemoryKind } from "./memory";
import { dbError, type Authed } from "./server";

/** Project memory in the database, with the user's own session (row-level security keeps it to the project's owner). */

const COLS = "id, kind, title, content, always, status, source, run_id, created_at, updated_at";
type Row = {
  id: string;
  kind: MemoryKind;
  title: string;
  content: string;
  always: boolean;
  status: "active" | "proposed";
  source: "user" | "agent";
  run_id: string | null;
  created_at: string;
  updated_at: string;
};

const toEntry = (r: Row): MemoryEntry => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  content: r.content,
  always: r.always,
  status: r.status,
  source: r.source,
  runId: r.run_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export async function listMemory(auth: Authed, projectId: string): Promise<MemoryEntry[]> {
  const { data, error } = await auth.supabase.from("code_project_memory").select(COLS).eq("project_id", projectId).order("updated_at", { ascending: false }).limit(200);
  if (error) throw dbError(error, "code.memory.list");
  return ((data ?? []) as Row[]).map(toEntry);
}

export async function addMemory(
  auth: Authed,
  projectId: string,
  e: { kind: MemoryKind; title: string; content: string; always?: boolean; status?: "active" | "proposed"; source?: "user" | "agent"; runId?: string | null },
): Promise<MemoryEntry> {
  const { data, error } = await auth.supabase
    .from("code_project_memory")
    .insert({ project_id: projectId, kind: e.kind, title: e.title, content: e.content, always: e.always ?? false, status: e.status ?? "active", source: e.source ?? "user", run_id: e.runId ?? null })
    .select(COLS)
    .single();
  if (error) throw dbError(error, "code.memory.add");
  return toEntry(data as Row);
}

export async function updateMemory(
  auth: Authed,
  projectId: string,
  id: string,
  patch: { kind?: MemoryKind; title?: string; content?: string; always?: boolean; status?: "active" },
): Promise<MemoryEntry> {
  const { data, error } = await auth.supabase.from("code_project_memory").update(patch).eq("id", id).eq("project_id", projectId).select(COLS).maybeSingle();
  if (error) throw dbError(error, "code.memory.update");
  if (!data) throw new ApiError("not_found", "Note not found.");
  return toEntry(data as Row);
}

export async function deleteMemory(auth: Authed, projectId: string, id: string): Promise<void> {
  const { data, error } = await auth.supabase.from("code_project_memory").delete().eq("id", id).eq("project_id", projectId).select("id");
  if (error) throw dbError(error, "code.memory.delete");
  if (!data?.length) throw new ApiError("not_found", "Note not found.");
}
