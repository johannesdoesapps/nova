import "server-only";
import { ENGINEERING_PREFIXES } from "../security/guardian/categories";
import { ApiError } from "../http";
import type { FindingDraft, FindingStatus, SecurityAgentId, ToolRun } from "../security/types";
import type { ServerSupabase } from "../supabase/server";

/** Security Center persistence. Row Level Security limits every query to the owner. */

export interface FindingRow {
  id: string;
  run_id: string | null;
  last_run_id: string | null;
  agent: SecurityAgentId;
  fingerprint: string;
  rule_id: string;
  title: string;
  description: string;
  severity: FindingDraft["severity"];
  confidence: FindingDraft["confidence"];
  rationale: string;
  asset: string;
  location: string | null;
  evidence: FindingDraft["evidence"];
  evidence_source: string;
  remediation: string;
  refs: string[];
  status: FindingStatus;
  verification: "not_verified" | "still_present" | "not_detected";
  verification_note: string | null;
  related: string[];
  duplicate_of: string | null;
  user_note: string | null;
  patch: string | null;
  tests: string | null;
  occurrences: number;
  first_seen: string;
  last_seen: string;
  updated_at: string;
}

export interface RunRow {
  id: string;
  parent_id: string | null;
  agent: SecurityAgentId | "coordinated";
  action: string;
  status: "running" | "completed" | "failed" | "cancelled";
  asset: string | null;
  scope: string | null;
  tools: ToolRun[];
  summary: string | null;
  model_id: string | null;
  stats: Record<string, unknown>;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export const FINDING_COLS =
  "id,run_id,last_run_id,agent,fingerprint,rule_id,title,description,severity,confidence,rationale,asset,location,evidence,evidence_source,remediation,refs,status,verification,verification_note,related,duplicate_of,user_note,patch,tests,occurrences,first_seen,last_seen,updated_at";
const RUN_COLS = "id,parent_id,agent,action,status,asset,scope,tools,summary,model_id,stats,error,started_at,finished_at";

const fail = (what: string): never => {
  throw new ApiError("internal", `Could not save or load ${what}.`);
};

/** Runs left "running" by a crashed or timed-out request are shown as failed. */
const STALE_MS = 10 * 60 * 1000;
const fixStale = (r: RunRow): RunRow =>
  r.status === "running" && Date.now() - new Date(r.started_at).getTime() > STALE_MS ? { ...r, status: "failed", error: r.error ?? "The run stopped without finishing (timed out or interrupted)." } : r;

export async function audit(db: ServerSupabase, userId: string, action: string, ref: { runId?: string | null; findingId?: string | null; detail?: Record<string, unknown> } = {}) {
  await db.from("security_audit").insert({ user_id: userId, action, run_id: ref.runId ?? null, finding_id: ref.findingId ?? null, detail: ref.detail ?? {} });
}

export async function startRun(db: ServerSupabase, userId: string, r: { agent: string; action: string; asset?: string | null; scope?: string | null; parentId?: string | null; modelId?: string | null }) {
  const { data, error } = await db
    .from("security_runs")
    .insert({ user_id: userId, agent: r.agent, action: r.action, asset: r.asset?.slice(0, 300) ?? null, scope: r.scope ?? null, parent_id: r.parentId ?? null, model_id: r.modelId ?? null })
    .select("id")
    .single();
  if (error || !data) fail("the run");
  return (data as { id: string }).id;
}

export async function finishRun(db: ServerSupabase, runId: string, r: { status: RunRow["status"]; summary?: string | null; tools?: ToolRun[]; stats?: Record<string, unknown>; error?: string | null; modelId?: string | null }) {
  const patch: Record<string, unknown> = { status: r.status, finished_at: new Date().toISOString() };
  if (r.summary !== undefined) patch.summary = r.summary?.slice(0, 40000) ?? null;
  if (r.tools) patch.tools = r.tools;
  if (r.stats) patch.stats = r.stats;
  if (r.error !== undefined) patch.error = r.error?.slice(0, 2000) ?? null;
  if (r.modelId !== undefined) patch.model_id = r.modelId;
  await db.from("security_runs").update(patch).eq("id", runId);
}

export async function getRunRow(db: ServerSupabase, userId: string, id: string): Promise<RunRow> {
  const { data, error } = await db.from("security_runs").select(RUN_COLS).eq("id", id).eq("user_id", userId).maybeSingle();
  if (error) fail("the run");
  if (!data) throw new ApiError("not_found", "Run not found.");
  return fixStale(data as RunRow);
}

/**
 * Store a run's findings. New fingerprints are inserted; known ones are
 * updated in place (evidence, last seen, occurrences). A finding that was
 * fixed or verified and shows up again is reopened as a regression.
 */
export async function saveFindings(
  db: ServerSupabase,
  userId: string,
  runId: string,
  drafts: FindingDraft[],
): Promise<{ ids: Map<string, string>; created: number; updated: number; reopened: number; reopenedFingerprints: string[]; createdFingerprints: string[] }> {
  const ids = new Map<string, string>();
  const list = drafts.slice(0, 400);
  const reopenedFingerprints: string[] = [];
  const createdFingerprints: string[] = [];
  if (!list.length) return { ids, created: 0, updated: 0, reopened: 0, reopenedFingerprints, createdFingerprints };
  const existing = new Map<string, { id: string; status: FindingStatus; occurrences: number }>();
  for (let i = 0; i < list.length; i += 150) {
    const { data } = await db
      .from("security_findings")
      .select("id,fingerprint,status,occurrences")
      .eq("user_id", userId)
      .in("fingerprint", list.slice(i, i + 150).map((d) => d.fingerprint));
    for (const r of (data ?? []) as { id: string; fingerprint: string; status: FindingStatus; occurrences: number }[]) existing.set(r.fingerprint, r);
  }
  const now = new Date().toISOString();
  const fresh = list.filter((d) => !existing.has(d.fingerprint));
  let created = 0;
  if (fresh.length) {
    const { data, error } = await db
      .from("security_findings")
      .insert(
        fresh.map((d) => ({
          user_id: userId,
          run_id: runId,
          last_run_id: runId,
          agent: d.agent,
          fingerprint: d.fingerprint,
          rule_id: d.ruleId,
          title: d.title.slice(0, 300),
          description: d.description.slice(0, 8000),
          severity: d.severity,
          confidence: d.confidence,
          rationale: d.rationale.slice(0, 2000),
          asset: d.asset.slice(0, 300),
          location: d.location?.slice(0, 500) ?? null,
          evidence: d.evidence.slice(0, 6),
          evidence_source: d.evidenceSource,
          remediation: d.remediation.slice(0, 8000),
          refs: d.references.slice(0, 10),
        })),
      )
      .select("id,fingerprint");
    if (error) fail("findings");
    for (const r of (data ?? []) as { id: string; fingerprint: string }[]) {
      ids.set(r.fingerprint, r.id);
      createdFingerprints.push(r.fingerprint);
    }
    created = data?.length ?? 0;
  }
  let reopened = 0;
  let updated = 0;
  for (const d of list) {
    const prev = existing.get(d.fingerprint);
    if (!prev) continue;
    ids.set(d.fingerprint, prev.id);
    const regress = prev.status === "fixed" || prev.status === "verified";
    if (regress) {
      reopened++;
      reopenedFingerprints.push(d.fingerprint);
    }
    const { error } = await db
      .from("security_findings")
      .update({
        last_run_id: runId,
        last_seen: now,
        occurrences: prev.occurrences + 1,
        evidence: d.evidence.slice(0, 6),
        description: d.description.slice(0, 8000),
        location: d.location?.slice(0, 500) ?? null,
        verification: "still_present",
        verification_note: `Detected again on ${now.slice(0, 10)}.`,
        ...(regress ? { status: "open" } : {}),
      })
      .eq("id", prev.id);
    if (!error) updated++;
  }
  return { ids, created, updated, reopened, reopenedFingerprints, createdFingerprints };
}

/**
 * After a re-scan, mark findings for the same agent and asset that the scan
 * checked for but did not detect. Fixed findings become verified.
 */
export async function markNotDetected(
  db: ServerSupabase,
  userId: string,
  runId: string,
  agent: SecurityAgentId,
  asset: string,
  checkedPrefixes: string[],
  /** Rule prefixes whose findings count as re-checked only where the run actually looked (e.g. pages a crawl fetched). */
  located?: { prefix: string; covers: (location: string | null) => boolean },
) {
  if (!checkedPrefixes.length) return 0;
  const { data } = await db
    .from("security_findings")
    .select("id,rule_id,status,last_run_id,location")
    .eq("user_id", userId)
    .eq("agent", agent)
    .eq("asset", asset)
    .not("status", "in", "(false_positive,accepted_risk)")
    .limit(1000);
  const missing = ((data ?? []) as { id: string; rule_id: string; status: FindingStatus; last_run_id: string | null; location: string | null }[]).filter(
    (f) => f.last_run_id !== runId && checkedPrefixes.some((p) => f.rule_id.startsWith(p)) && (!located || !f.rule_id.startsWith(located.prefix) || located.covers(f.location)),
  );
  const note = `Not detected by the re-scan on ${new Date().toISOString().slice(0, 10)}.`;
  for (const f of missing) {
    await db
      .from("security_findings")
      .update({ verification: "not_detected", verification_note: note, ...(f.status === "fixed" || f.status === "fix_proposed" ? { status: "verified" } : {}) })
      .eq("id", f.id);
  }
  return missing.length;
}

export async function linkRelated(db: ServerSupabase, pairs: [string, string][]) {
  const map = new Map<string, Set<string>>();
  for (const [a, b] of pairs) {
    if (a === b) continue;
    (map.get(a) ?? map.set(a, new Set()).get(a)!).add(b);
    (map.get(b) ?? map.set(b, new Set()).get(b)!).add(a);
  }
  if (!map.size) return;
  const { data } = await db.from("security_findings").select("id,related").in("id", [...map.keys()]);
  for (const r of (data ?? []) as { id: string; related: string[] }[]) {
    const next = [...new Set([...(r.related ?? []), ...map.get(r.id)!])].slice(0, 50);
    await db.from("security_findings").update({ related: next }).eq("id", r.id);
  }
}

export interface FindingQuery {
  agent?: string;
  severity?: string;
  status?: string;
  asset?: string;
  q?: string;
  sort?: "severity" | "recent" | "oldest";
  includeDuplicates?: boolean;
  runId?: string;
  /** Security findings only, Code Guardian engineering findings only (quality./compat./arch.), or everything (default). */
  scope?: "security" | "engineering" | "all";
}

const SEV_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

export async function listFindings(db: ServerSupabase, userId: string, q: FindingQuery = {}): Promise<FindingRow[]> {
  let query = db.from("security_findings").select(FINDING_COLS).eq("user_id", userId);
  if (q.agent) query = query.eq("agent", q.agent);
  if (q.severity) query = query.eq("severity", q.severity);
  if (q.status) query = query.eq("status", q.status);
  if (q.asset) query = query.eq("asset", q.asset);
  if (q.runId) query = query.or(`run_id.eq.${q.runId},last_run_id.eq.${q.runId}`);
  if (!q.includeDuplicates) query = query.is("duplicate_of", null);
  if (q.scope === "security") for (const p of ENGINEERING_PREFIXES) query = query.not("rule_id", "like", `${p}%`);
  if (q.scope === "engineering") query = query.or(ENGINEERING_PREFIXES.map((p) => `rule_id.like.${p}%`).join(","));
  if (q.q) {
    const s = q.q.replace(/[%,()*]/g, " ").trim().slice(0, 100);
    if (s) query = query.or(`title.ilike.%${s}%,description.ilike.%${s}%,location.ilike.%${s}%,asset.ilike.%${s}%`);
  }
  const { data, error } = await query.order("last_seen", { ascending: q.sort === "oldest" }).limit(500);
  if (error) fail("findings");
  const rows = (data ?? []) as FindingRow[];
  if (q.sort === "severity" || !q.sort) rows.sort((a, b) => SEV_RANK[a.severity]! - SEV_RANK[b.severity]! || b.last_seen.localeCompare(a.last_seen));
  return rows;
}

export async function getFinding(db: ServerSupabase, userId: string, id: string) {
  const { data, error } = await db.from("security_findings").select(FINDING_COLS).eq("id", id).eq("user_id", userId).maybeSingle();
  if (error) fail("the finding");
  if (!data) throw new ApiError("not_found", "Finding not found.");
  const f = data as FindingRow;
  const relIds = [...new Set([...(f.related ?? []), ...(f.duplicate_of ? [f.duplicate_of] : [])])];
  const [related, duplicates, history, run] = await Promise.all([
    relIds.length ? db.from("security_findings").select("id,title,severity,agent,status,asset,rule_id,confidence,evidence_source,location").in("id", relIds) : Promise.resolve({ data: [] }),
    db.from("security_findings").select("id,title,severity,agent,status,asset").eq("duplicate_of", id).limit(50),
    db.from("security_audit").select("id,action,detail,created_at").eq("finding_id", id).order("created_at", { ascending: false }).limit(50),
    f.run_id ? db.from("security_runs").select("id,agent,action,started_at").eq("id", f.run_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  return { finding: f, related: related.data ?? [], duplicates: duplicates.data ?? [], history: history.data ?? [], run: run.data };
}

export async function updateFinding(db: ServerSupabase, userId: string, id: string, patch: Record<string, unknown>) {
  const { data, error } = await db.from("security_findings").update(patch).eq("id", id).eq("user_id", userId).select(FINDING_COLS).maybeSingle();
  if (error) fail("the finding");
  if (!data) throw new ApiError("not_found", "Finding not found.");
  return data as FindingRow;
}

export async function listRuns(db: ServerSupabase, userId: string, limit = 60): Promise<RunRow[]> {
  const { data, error } = await db.from("security_runs").select(RUN_COLS).eq("user_id", userId).order("started_at", { ascending: false }).limit(limit);
  if (error) fail("scan history");
  return ((data ?? []) as RunRow[]).map(fixStale);
}

export async function getRun(db: ServerSupabase, userId: string, id: string) {
  const run = await getRunRow(db, userId, id);
  const [children, findings, history] = await Promise.all([
    db.from("security_runs").select(RUN_COLS).eq("parent_id", id).order("started_at"),
    listFindings(db, userId, { runId: id, includeDuplicates: true }),
    db.from("security_audit").select("id,action,detail,created_at").eq("run_id", id).order("created_at").limit(100),
  ]);
  const kids = ((children.data ?? []) as RunRow[]).map(fixStale);
  let childFindings: FindingRow[] = [];
  if (kids.length) {
    const lists = await Promise.all(kids.map((k) => listFindings(db, userId, { runId: k.id, includeDuplicates: true })));
    childFindings = lists.flat();
  }
  const seen = new Set<string>();
  const all = [...findings, ...childFindings].filter((f) => !seen.has(f.id) && seen.add(f.id));
  return { run, children: kids, findings: all, history: history.data ?? [] };
}

export interface TargetRow {
  id: string;
  hostname: string;
  token: string;
  verified_at: string | null;
  verified_method: string | null;
  created_at: string;
}

export async function listTargets(db: ServerSupabase, userId: string): Promise<TargetRow[]> {
  const { data, error } = await db.from("security_targets").select("id,hostname,token,verified_at,verified_method,created_at").eq("user_id", userId).order("created_at");
  if (error) fail("targets");
  return (data ?? []) as TargetRow[];
}

export async function getTarget(db: ServerSupabase, userId: string, id: string): Promise<TargetRow> {
  const { data, error } = await db.from("security_targets").select("id,hostname,token,verified_at,verified_method,created_at").eq("id", id).eq("user_id", userId).maybeSingle();
  if (error) fail("the target");
  if (!data) throw new ApiError("not_found", "Target not found. Add the website on the Targets tab first.");
  return data as TargetRow;
}

export async function addTarget(db: ServerSupabase, userId: string, hostname: string): Promise<TargetRow> {
  const token = `orbis-verify-${crypto.randomUUID().replace(/-/g, "")}`;
  const { data, error } = await db
    .from("security_targets")
    .insert({ user_id: userId, hostname, token })
    .select("id,hostname,token,verified_at,verified_method,created_at")
    .single();
  if (error?.code === "23505") throw new ApiError("bad_request", "That website is already in your targets.");
  if (error || !data) fail("the target");
  return data as TargetRow;
}

export async function setTargetVerified(db: ServerSupabase, id: string, method: string | null) {
  await db.from("security_targets").update({ verified_at: method ? new Date().toISOString() : null, verified_method: method }).eq("id", id);
}

export async function deleteTarget(db: ServerSupabase, userId: string, id: string) {
  const { data, error } = await db.from("security_targets").delete().eq("id", id).eq("user_id", userId).select("id");
  if (error) fail("the target");
  if (!data?.length) throw new ApiError("not_found", "Target not found.");
}

export async function auditLog(db: ServerSupabase, userId: string, limit = 100) {
  const { data } = await db.from("security_audit").select("id,action,run_id,finding_id,detail,created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(limit);
  return data ?? [];
}
