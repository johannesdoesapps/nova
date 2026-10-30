import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ApiError } from "@/lib/http";
import { isWorkspaceKey, type WorkspaceKey } from "./catalog";

/** A saved item in a workspace (a report, a drafted site, a saved analysis). RLS limits every query to the owner. */
export interface WorkspaceItem {
  id: string;
  workspace: WorkspaceKey;
  kind: string;
  title: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

const COLS = "id, workspace, kind, title, data, created_at, updated_at";

function toItem(r: Record<string, unknown>): WorkspaceItem {
  return {
    id: r.id as string,
    workspace: r.workspace as WorkspaceKey,
    kind: r.kind as string,
    title: r.title as string,
    data: (r.data as Record<string, unknown>) ?? {},
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

const KIND_RE = /^[a-z][a-z0-9-]{1,48}$/;

function clean(input: { kind?: string; title?: string; data?: unknown }): { kind: string; title: string; data: Record<string, unknown> } {
  const kind = (input.kind ?? "").trim();
  if (!KIND_RE.test(kind)) throw new ApiError("bad_request", "Invalid item kind.");
  const title = (input.title ?? "").trim().slice(0, 160) || "Untitled";
  const data = (input.data && typeof input.data === "object" && !Array.isArray(input.data) ? input.data : {}) as Record<string, unknown>;
  if (JSON.stringify(data).length > 600_000) throw new ApiError("payload_too_large", "This item is too large to save.");
  return { kind, title, data };
}

export async function listItems(db: SupabaseClient, workspace: WorkspaceKey, kind?: string): Promise<WorkspaceItem[]> {
  let q = db.from("workspace_items").select(COLS).eq("workspace", workspace).order("updated_at", { ascending: false }).limit(200);
  if (kind) q = q.eq("kind", kind);
  const { data, error } = await q;
  if (error) throw new ApiError("internal", "Your saved items couldn't be loaded.");
  return (data ?? []).map(toItem);
}

export async function getItem(db: SupabaseClient, workspace: WorkspaceKey, id: string): Promise<WorkspaceItem> {
  const { data, error } = await db.from("workspace_items").select(COLS).eq("workspace", workspace).eq("id", id).maybeSingle();
  if (error) throw new ApiError("internal", "That item couldn't be loaded.");
  if (!data) throw new ApiError("not_found", "That item doesn't exist, or it isn't yours.");
  return toItem(data);
}

export async function createItem(db: SupabaseClient, workspace: WorkspaceKey, input: { kind?: string; title?: string; data?: unknown }): Promise<WorkspaceItem> {
  const row = clean(input);
  const { data, error } = await db.from("workspace_items").insert({ workspace, ...row }).select(COLS).single();
  if (error) throw mapWrite(error);
  return toItem(data);
}

export async function updateItem(db: SupabaseClient, workspace: WorkspaceKey, id: string, input: { title?: string; data?: unknown }): Promise<WorkspaceItem> {
  await getItem(db, workspace, id); // 404 for someone else's or missing.
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.title !== undefined) patch.title = input.title.trim().slice(0, 160) || "Untitled";
  if (input.data !== undefined) {
    const d = input.data && typeof input.data === "object" && !Array.isArray(input.data) ? input.data : {};
    if (JSON.stringify(d).length > 600_000) throw new ApiError("payload_too_large", "This item is too large to save.");
    patch.data = d;
  }
  const { data, error } = await db.from("workspace_items").update(patch).eq("workspace", workspace).eq("id", id).select(COLS).single();
  if (error) throw mapWrite(error);
  return toItem(data);
}

export async function duplicateItem(db: SupabaseClient, workspace: WorkspaceKey, id: string): Promise<WorkspaceItem> {
  const src = await getItem(db, workspace, id);
  return createItem(db, workspace, { kind: src.kind, title: `${src.title} (copy)`.slice(0, 160), data: src.data });
}

export async function deleteItem(db: SupabaseClient, workspace: WorkspaceKey, id: string): Promise<void> {
  await getItem(db, workspace, id);
  const { error } = await db.from("workspace_items").delete().eq("workspace", workspace).eq("id", id);
  if (error) throw new ApiError("internal", "That item couldn't be deleted.");
}

function mapWrite(error: { message?: string; code?: string }): ApiError {
  if (error.code === "54000") return new ApiError("quota_exceeded", error.message ?? "You've reached the saved-item limit for this workspace.");
  return new ApiError("internal", "The item couldn't be saved.");
}

export function requireWorkspace(v: string): WorkspaceKey {
  if (!isWorkspaceKey(v)) throw new ApiError("not_found", "Unknown workspace.");
  return v;
}
