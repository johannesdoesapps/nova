import "server-only";
import type { CouncilSessionInput } from "../council/schema";
import { ApiError } from "../http";
import type { ServerSupabase } from "../supabase/server";

/** Saved Council and Arena sessions. Row Level Security limits every query to the owner. */
export interface CouncilSessionSummary {
  id: string;
  kind: "council" | "arena";
  question: string;
  mode: string;
  models: string[];
  created_at: string;
}

const fail = (): never => {
  throw new ApiError("internal", "Could not save or load the session.");
};

export async function listCouncilSessions(db: ServerSupabase, userId: string, kind: "council" | "arena", limit = 30): Promise<CouncilSessionSummary[]> {
  const { data, error } = await db
    .from("council_sessions")
    .select("id,kind,question,mode,models,created_at")
    .eq("user_id", userId)
    .eq("kind", kind)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) fail();
  return (data ?? []) as CouncilSessionSummary[];
}

export async function getCouncilSession(db: ServerSupabase, userId: string, id: string) {
  const { data, error } = await db.from("council_sessions").select("*").eq("id", id).eq("user_id", userId).maybeSingle();
  if (error) fail();
  if (!data) throw new ApiError("not_found", "Session not found.");
  return data as CouncilSessionSummary & { result: CouncilSessionInput["result"] };
}

export async function saveCouncilSession(db: ServerSupabase, userId: string, input: CouncilSessionInput) {
  const { data, error } = await db
    .from("council_sessions")
    .insert({ user_id: userId, kind: input.kind, question: input.question, mode: input.mode, models: input.models, result: input.result })
    .select("id,kind,question,mode,models,created_at")
    .single();
  if (error) fail();
  return data as CouncilSessionSummary;
}

export async function updateCouncilResult(db: ServerSupabase, userId: string, id: string, result: CouncilSessionInput["result"]) {
  const { data, error } = await db.from("council_sessions").update({ result }).eq("id", id).eq("user_id", userId).select("id").maybeSingle();
  if (error) fail();
  if (!data) throw new ApiError("not_found", "Session not found.");
}

export async function deleteCouncilSession(db: ServerSupabase, userId: string, id: string) {
  const { error } = await db.from("council_sessions").delete().eq("id", id).eq("user_id", userId);
  if (error) fail();
}
