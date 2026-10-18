import "server-only";
import type { Arena } from "../claims/hypothesis";
import type { ClaimReport } from "../claims/types";
import { ApiError } from "../http";
import type { BenchmarkRun, TrialRecord, UsageRow } from "../intel/types";
import type { ServerSupabase } from "../supabase/server";
import { assertProject, touchProject } from "./index";

/** Data access for Claim DNA and Model Intelligence. RLS applies; user_id filters are defence in depth. */

// ─── claim reports ──────────────────────────────────────────────────────────
export async function saveClaimReport(db: ServerSupabase, userId: string, report: ClaimReport, projectId?: string | null) {
  await assertProject(db, userId, projectId);
  const { error } = await db.from("claim_reports").upsert({
    id: report.id,
    user_id: userId,
    project_id: projectId ?? null,
    question: report.question.slice(0, 2000),
    mode: report.mode,
    model_id: report.modelId,
    summary: report.summary,
    report,
  });
  if (error) throw new ApiError("internal", "Could not save the claim report.");
  await touchProject(db, projectId);
}

export async function listClaimReports(db: ServerSupabase, userId: string, limit = 30) {
  const { data, error } = await db
    .from("claim_reports")
    .select("id,question,mode,model_id,summary,created_at,project_id")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new ApiError("internal", "Could not load claim reports.");
  return data ?? [];
}

export async function getClaimReport(db: ServerSupabase, userId: string, id: string): Promise<ClaimReport> {
  const { data, error } = await db.from("claim_reports").select("report").eq("id", id).eq("user_id", userId).maybeSingle();
  if (error) throw new ApiError("internal", "Could not load the claim report.");
  if (!data) throw new ApiError("not_found", "Claim report not found.");
  return data.report as ClaimReport;
}

export async function deleteClaimReport(db: ServerSupabase, userId: string, id: string) {
  const { data, error } = await db.from("claim_reports").delete().eq("id", id).eq("user_id", userId).select("id");
  if (error) throw new ApiError("internal", "Could not delete the claim report.");
  if (!data?.length) throw new ApiError("not_found", "Claim report not found.");
}

// ─── hypothesis arenas ──────────────────────────────────────────────────────
export async function saveArena(db: ServerSupabase, userId: string, arena: Arena) {
  const { error } = await db.from("hypothesis_arenas").upsert({
    id: arena.id,
    user_id: userId,
    claim_report_id: arena.reportId,
    question: arena.question.slice(0, 2000),
    arena,
  });
  if (error) throw new ApiError("internal", "Could not save the arena.");
}

export async function listArenas(db: ServerSupabase, userId: string, limit = 30): Promise<Arena[]> {
  const { data, error } = await db.from("hypothesis_arenas").select("arena").eq("user_id", userId).order("updated_at", { ascending: false }).limit(limit);
  if (error) throw new ApiError("internal", "Could not load arenas.");
  return (data ?? []).map((r) => r.arena as Arena);
}

export async function deleteArena(db: ServerSupabase, userId: string, id: string) {
  const { error } = await db.from("hypothesis_arenas").delete().eq("id", id).eq("user_id", userId);
  if (error) throw new ApiError("internal", "Could not delete the arena.");
}

// ─── trials, benchmarks, usage ──────────────────────────────────────────────
export async function saveTrial(db: ServerSupabase, userId: string, t: TrialRecord) {
  const { error } = await db.from("blind_trials").insert({
    id: t.id,
    user_id: userId,
    category: t.category,
    prompt: t.prompt,
    prompt_hash: t.promptHash,
    test_item_id: t.testItemId,
    winner: t.winner,
    arms: t.arms,
    ratings: t.ratings,
    note: t.note,
    redactions: t.redactions,
    created_at: t.createdAt,
  });
  if (error?.code === "23505") throw new ApiError("bad_request", "You already voted on this trial.");
  if (error) throw new ApiError("internal", "Could not save the trial.");
}

type TrialRow = { id: string; category: string; prompt: string; prompt_hash: string; test_item_id: string | null; winner: string; arms: unknown; ratings: unknown; note: string | null; redactions: number; created_at: string };
type RunRow = { id: string; test_set_id: string; test_set_name: string; test_set_hash: string; category: string; model_id: string; display_name: string; served_model: string | null; params: unknown; simulated: boolean; results: unknown; created_at: string };

export async function listTrials(db: ServerSupabase, userId: string, limit = 2000): Promise<TrialRecord[]> {
  const { data, error } = await db.from("blind_trials").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(limit);
  if (error) throw new ApiError("internal", "Could not load trials.");
  return ((data ?? []) as TrialRow[]).map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    category: r.category as TrialRecord["category"],
    prompt: r.prompt,
    promptHash: r.prompt_hash,
    testItemId: r.test_item_id,
    winner: r.winner as TrialRecord["winner"],
    arms: r.arms as TrialRecord["arms"],
    ratings: (r.ratings ?? {}) as TrialRecord["ratings"],
    note: r.note,
    redactions: r.redactions,
  }));
}

export async function deleteTrial(db: ServerSupabase, userId: string, id: string) {
  const { error } = await db.from("blind_trials").delete().eq("id", id).eq("user_id", userId);
  if (error) throw new ApiError("internal", "Could not delete the trial.");
}

export async function saveBenchmarkRun(db: ServerSupabase, userId: string, r: BenchmarkRun) {
  const { error } = await db.from("benchmark_runs").insert({
    id: r.id,
    user_id: userId,
    test_set_id: r.testSetId,
    test_set_name: r.testSetName,
    test_set_hash: r.testSetHash,
    category: r.category,
    model_id: r.modelId,
    display_name: r.displayName,
    served_model: r.servedModel,
    params: r.params,
    simulated: r.simulated,
    results: r.results,
    created_at: r.createdAt,
  });
  if (error) throw new ApiError("internal", "Could not save the benchmark run.");
}

export async function listBenchmarkRuns(db: ServerSupabase, userId: string, limit = 500): Promise<BenchmarkRun[]> {
  const { data, error } = await db.from("benchmark_runs").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(limit);
  if (error) throw new ApiError("internal", "Could not load benchmark runs.");
  return ((data ?? []) as RunRow[]).map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    testSetId: r.test_set_id,
    testSetName: r.test_set_name,
    testSetHash: r.test_set_hash,
    category: r.category as BenchmarkRun["category"],
    modelId: r.model_id,
    displayName: r.display_name,
    servedModel: r.served_model,
    params: r.params as BenchmarkRun["params"],
    simulated: r.simulated,
    results: r.results as BenchmarkRun["results"],
  }));
}

export async function deleteBenchmarkRun(db: ServerSupabase, userId: string, id: string) {
  const { error } = await db.from("benchmark_runs").delete().eq("id", id).eq("user_id", userId);
  if (error) throw new ApiError("internal", "Could not delete the benchmark run.");
}

type UsageDbRow = { model_id: string; purpose: string | null; category: string | null; served_model: string | null; fallback_from: string | null; status: "success" | "error"; latency_ms: number | null; input_tokens: number | null; output_tokens: number | null; estimated_cost: number | string | null; created_at: string };

export async function listUsage(db: ServerSupabase, userId: string, days = 30): Promise<UsageRow[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data, error } = await db
    .from("model_runs")
    .select("model_id,purpose,category,served_model,fallback_from,status,latency_ms,input_tokens,output_tokens,estimated_cost,created_at")
    .eq("user_id", userId)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(5000);
  if (error) throw new ApiError("internal", "Could not load usage.");
  return ((data ?? []) as UsageDbRow[]).map((r) => ({
    modelId: r.model_id,
    purpose: r.purpose ?? "unknown",
    category: r.category,
    servedModel: r.served_model,
    fallbackFrom: r.fallback_from,
    status: r.status,
    latencyMs: r.latency_ms,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cost: r.estimated_cost === null ? null : Number(r.estimated_cost),
    createdAt: r.created_at,
  }));
}
