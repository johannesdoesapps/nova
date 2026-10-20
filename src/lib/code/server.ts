import "server-only";
import { randomUUID } from "node:crypto";
import { requireUser, type AuthContext } from "@/lib/auth";
import { budgetPeriod, nextRenewal } from "@/lib/budget";
import { entitlementFor, type Entitlement } from "@/lib/entitlements";
import { ApiError, requireUuid } from "@/lib/http";
import { reportError } from "@/lib/observability";
import { limiter } from "@/lib/rate-limit";
import { workspaceBlockCostUsd } from "./pricing";
import { byteLength, isIgnoredPath, MAX_FILE_BYTES, validProjectPath, type ProjectFile, type ProjectSummary } from "./projects";
import { collectFiles, seedWorkspace, syncPlan, vercelWorkspaces, workspaceName, workspacesAvailable, type WorkspaceBackend, type WorkspaceBox } from "./workspace";

/**
 * Code workspace on the server: projects and files (through the user's own
 * Supabase session, so row-level security applies), workspace time
 * allowances, and starting, extending and stopping a project's computer.
 */

export type Authed = Extract<AuthContext, { mode: "authenticated" }>;

/** The signed-in user, rate limited per user for code workspace requests. */
export async function codeContext(bucket = "code-ws", perMinute = 120): Promise<Authed> {
  const auth = await requireUser();
  if (!limiter(bucket, perMinute, 60_000).check(`u:${auth.user.id}`, 1).ok) {
    throw new ApiError("rate_limited", "Too many requests. Please wait a moment.");
  }
  return auth;
}

type ProjectRow = { id: string; name: string; template: string; run_command: string; source_repo: string | null; updated_at: string };
const PROJECT_COLS = "id, name, template, run_command, source_repo, updated_at";

export function toSummary(r: ProjectRow): ProjectSummary {
  return { id: r.id, name: r.name, template: r.template, runCommand: r.run_command, sourceRepo: r.source_repo, updatedAt: r.updated_at };
}

/** Database errors as user-facing messages: limit messages from the database pass through, the rest are generic. */
export function dbError(error: { message?: string; code?: string }, where: string): ApiError {
  if (error.code === "54000" && error.message) return new ApiError("payload_too_large", error.message);
  if (error.code === "23514") return new ApiError("bad_request", "That file name or size isn't allowed.");
  if (error.code === "23505") return new ApiError("conflict", "A file with that name already exists.");
  reportError(error, { where });
  return new ApiError("upstream_error", "Your project couldn't be saved right now. Please try again.");
}

export async function listProjects(auth: Authed): Promise<ProjectSummary[]> {
  const { data, error } = await auth.supabase.from("code_projects").select(PROJECT_COLS).order("updated_at", { ascending: false }).limit(500);
  if (error) throw dbError(error, "code.projects.list");
  return (data as ProjectRow[]).map(toSummary);
}

export async function getProjectRow(auth: Authed, id: string): Promise<ProjectSummary> {
  requireUuid(id);
  const { data, error } = await auth.supabase.from("code_projects").select(PROJECT_COLS).eq("id", id).maybeSingle();
  if (error) throw dbError(error, "code.projects.get");
  if (!data) throw new ApiError("not_found", "Project not found.");
  return toSummary(data as ProjectRow);
}

export async function getFiles(auth: Authed, projectId: string): Promise<ProjectFile[]> {
  const { data, error } = await auth.supabase.from("code_files").select("path, content").eq("project_id", projectId).order("path").limit(1000);
  if (error) throw dbError(error, "code.files.list");
  return data as ProjectFile[];
}

/** Create a project with its first files, within the plan's number of projects. */
export async function createProject(
  auth: Authed,
  input: { name: string; template: string; runCommand: string; sourceRepo?: string | null; files: ProjectFile[] },
): Promise<ProjectSummary> {
  const entitlement = await entitlementFor(auth);
  if (!entitlement) throw new ApiError("not_configured", "Projects need accounts to be set up.");
  if (entitlement.kind !== "unlimited") {
    const { count, error } = await auth.supabase.from("code_projects").select("id", { count: "exact", head: true });
    if (error) throw dbError(error, "code.projects.count");
    const max = entitlement.limits.codeProjects;
    if ((count ?? 0) >= max) {
      const up = upgradeOf(entitlement);
      throw new ApiError(
        "quota_exceeded",
        `The ${entitlement.limits.label} plan can keep ${max} code project${max === 1 ? "" : "s"}. Delete one to make room${up ? `, or upgrade to ${entitlement.billing.plans[up].label} for ${entitlement.billing.plans[up].codeProjects}` : ""}.`,
        { scope: "code_projects", plan: entitlement.plan, upgradeTo: up },
      );
    }
  }
  const { data, error } = await auth.supabase
    .from("code_projects")
    .insert({ name: input.name, template: input.template, run_command: input.runCommand, source_repo: input.sourceRepo ?? null })
    .select(PROJECT_COLS)
    .single();
  if (error) throw dbError(error, "code.projects.create");
  const project = toSummary(data as ProjectRow);
  if (input.files.length) {
    const ins = await auth.supabase.from("code_files").insert(input.files.map((f) => ({ project_id: project.id, path: f.path, content: f.content })));
    if (ins.error) {
      await auth.supabase.from("code_projects").delete().eq("id", project.id);
      throw dbError(ins.error, "code.files.create");
    }
  }
  return project;
}

/** Write and delete files as one change; null content deletes. */
export async function applyFileChanges(auth: Authed, projectId: string, changes: { path: string; content: string | null }[]): Promise<void> {
  const deletes = changes.filter((c) => c.content === null).map((c) => c.path);
  const upserts = changes.filter((c): c is { path: string; content: string } => c.content !== null);
  if (deletes.length) {
    const { error } = await auth.supabase.from("code_files").delete().eq("project_id", projectId).in("path", deletes);
    if (error) throw dbError(error, "code.files.delete");
  }
  if (upserts.length) {
    const { error } = await auth.supabase
      .from("code_files")
      .upsert(upserts.map((f) => ({ project_id: projectId, path: f.path, content: f.content })), { onConflict: "project_id,path" });
    if (error) throw dbError(error, "code.files.upsert");
  }
}

function upgradeOf(e: Entitlement) {
  return e.plan === "free" ? ("pro" as const) : e.plan === "pro" ? ("max" as const) : null;
}

// ---------------------------------------------------------------- workspace time

export interface WorkspaceAllowance {
  /** Minutes used this period, and the plan's minutes (null = no limit). */
  used: number;
  limit: number | null;
  left: number | null;
  blockMinutes: number;
  resetsAt: string;
}

export async function workspaceAllowance(auth: Authed): Promise<WorkspaceAllowance & { entitlement: Entitlement; siteMinutes: number; siteLive: number }> {
  const entitlement = await entitlementFor(auth);
  if (!entitlement) throw new ApiError("not_configured", "Projects need accounts to be set up.");
  const period = budgetPeriod(entitlement);
  const { data, error } = await auth.supabase.rpc("code_workspace_status", { p_since: new Date(period.start).toISOString() });
  if (error) {
    reportError(error, { where: "code_workspace_status" });
    throw new ApiError("upstream_error", "Workspace time can't be checked right now. Please try again shortly.");
  }
  const s = data as { user_minutes: number; site_minutes: number; site_live: number };
  const limit = entitlement.kind === "unlimited" ? null : entitlement.limits.workspaceMinutesPerPeriod;
  const used = Number(s.user_minutes);
  return {
    used,
    limit,
    left: limit === null ? null : Math.max(0, limit - used),
    blockMinutes: entitlement.billing.workspaceBlockMinutes,
    resetsAt: new Date(period.end).toISOString(),
    entitlement,
    siteMinutes: Number(s.site_minutes),
    siteLive: Number(s.site_live),
  };
}

export interface LiveSession {
  sessionId: string;
  endsAt: string;
}

/** The project's running session, if any (from the caller's own time blocks). */
export async function liveSession(auth: Authed, projectId: string): Promise<LiveSession | null> {
  const { data, error } = await auth.supabase.from("code_workspace_live").select("session_id, ends_at").eq("project_id", projectId).order("ends_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw dbError(error, "code.session.live");
  return data ? { sessionId: (data as { session_id: string }).session_id, endsAt: (data as { ends_at: string }).ends_at } : null;
}

/** The caller's other running sessions (one computer at a time per user). */
async function otherSessions(auth: Authed, projectId: string): Promise<{ session_id: string; project_id: string | null }[]> {
  const { data, error } = await auth.supabase.from("code_workspace_live").select("session_id, project_id").neq("project_id", projectId);
  if (error) throw dbError(error, "code.session.others");
  return (data ?? []) as { session_id: string; project_id: string | null }[];
}

function refusal(reason: string, a: WorkspaceAllowance & { entitlement: Entitlement }): ApiError {
  if (reason === "site") return new ApiError("quota_exceeded", "Orbis has reached its limit for workspace time this month. Please try again next month.", { scope: "workspace_site" });
  if (reason === "busy") return new ApiError("rate_limited", "All workspace computers are busy right now. Please try again in a few minutes.", { scope: "workspace_busy" });
  if (reason === "ended") return new ApiError("conflict", "This workspace has already stopped. Start it again.");
  const e = a.entitlement;
  const up = upgradeOf(e);
  const hint = up ? ` ${e.billing.plans[up].label} includes ${e.billing.plans[up].workspaceMinutesPerPeriod.toLocaleString("en-US")} minutes a month.` : "";
  const limit = a.limit ?? 0;
  return new ApiError(
    "quota_exceeded",
    limit <= 0
      ? `The Code workspace computer isn't included in the ${e.limits.label} plan.${hint}`
      : `You've used ${a.used.toLocaleString("en-US")} of your ${limit.toLocaleString("en-US")} workspace minutes this month on the ${e.limits.label} plan (time is counted in ${a.blockMinutes}-minute blocks). They renew on ${nextRenewal(Date.parse(a.resetsAt))}.${hint}`,
    { scope: "workspace_minutes", plan: e.plan, upgradeTo: up, resetsAt: a.resetsAt },
  );
}

/** Refuse before starting a computer when the next block clearly won't fit. */
function precheck(a: WorkspaceAllowance & { entitlement: Entitlement; siteMinutes: number; siteLive: number }, newSession: boolean) {
  const b = a.entitlement.billing;
  if (b.aiPaused && a.entitlement.kind !== "unlimited") throw new ApiError("not_configured", "Orbis has paused new work for a moment. Please try again later.");
  if (a.limit !== null && a.used + a.blockMinutes > a.limit) throw refusal("user", a);
  if (b.workspaceSiteMonthlyMinutes > 0 && a.siteMinutes + a.blockMinutes > b.workspaceSiteMonthlyMinutes) throw refusal("site", a);
  if (newSession && b.workspaceSiteConcurrent > 0 && a.siteLive >= b.workspaceSiteConcurrent) throw refusal("busy", a);
}

async function reserve(auth: Authed, a: WorkspaceAllowance & { entitlement: Entitlement }, blockId: string, projectId: string, sessionId: string | null) {
  const b = a.entitlement.billing;
  const { data, error } = await auth.supabase.rpc("code_workspace_reserve", {
    p_block: blockId,
    p_project: projectId,
    p_session: sessionId,
    p_minutes: a.blockMinutes,
    p_since: new Date(budgetPeriod(a.entitlement).start).toISOString(),
    p_user_limit: a.limit,
    p_site_limit: b.workspaceSiteMonthlyMinutes,
    p_site_concurrent: b.workspaceSiteConcurrent,
  });
  if (error) {
    reportError(error, { where: "code_workspace_reserve" });
    throw new ApiError("upstream_error", "Workspace time can't be reserved right now. Please try again shortly.");
  }
  return data as { ok: true; id: string; session: string; used: number } | { ok: false; reason: string; used: number };
}

/** Record a block in model_runs too, so the admin finance pages see workspace costs. */
async function recordBlock(auth: Authed, entitlement: Entitlement, blockId: string, minutes: number) {
  const { error } = await auth.supabase.from("model_runs").insert({
    user_id: auth.user.id,
    model_id: "vercel:sandbox",
    prompt: "Code workspace time",
    response: `${minutes} minutes`,
    latency_ms: minutes * 60_000,
    input_tokens: 0,
    output_tokens: 0,
    model_tier: "standard",
    reserved_cost_usd: workspaceBlockCostUsd(minutes),
    estimated_cost: workspaceBlockCostUsd(minutes),
    status: "success",
    purpose: "code_workspace",
    request_id: blockId,
    units: 0,
    entitlement: entitlement.label,
    tools: ["code_workspace"],
  });
  if (error) reportError(error, { where: "code_workspace.record" });
}

export interface StartedSession extends LiveSession {
  previewUrl: string | null;
  allowance: WorkspaceAllowance;
}

function allowanceOnly(a: WorkspaceAllowance): WorkspaceAllowance {
  return { used: a.used, limit: a.limit, left: a.left, blockMinutes: a.blockMinutes, resetsAt: a.resetsAt };
}

/**
 * Start the project's computer: stop the caller's other ones, check the
 * allowance, start a computer and copy the files in, then reserve its first
 * block. When the reserve is refused the new computer is stopped at once.
 */
export async function startSession(auth: Authed, project: ProjectSummary, backend: WorkspaceBackend = vercelWorkspaces): Promise<StartedSession> {
  if (!workspacesAvailable()) throw new ApiError("not_configured", "Workspace computers aren't set up on this server.");
  const existing = await liveSession(auth, project.id);
  if (existing) {
    const box = await backend.get(workspaceName(existing.sessionId));
    if (box) return { ...existing, previewUrl: previewUrl(box), allowance: allowanceOnly(await workspaceAllowance(auth)) };
  }
  for (const other of await otherSessions(auth, project.id)) {
    const box = await backend.get(workspaceName(other.session_id));
    await box?.stop().catch(() => {});
  }
  const a = await workspaceAllowance(auth);
  precheck(a, true);
  const files = await getFiles(auth, project.id);
  const blockId = randomUUID();
  let box: WorkspaceBox;
  try {
    box = await backend.create(workspaceName(blockId), a.blockMinutes);
  } catch (err) {
    reportError(err, { where: "code_workspace.create" });
    throw new ApiError("upstream_error", "The workspace computer couldn't start right now. No time was used. Please try again.");
  }
  try {
    const r = await reserve(auth, a, blockId, project.id, null);
    if (!r.ok) throw refusal(r.reason, { ...a, used: r.used });
    await seedWorkspace(box, files);
  } catch (err) {
    await box.stop().catch(() => {});
    throw err;
  }
  await recordBlock(auth, a.entitlement, blockId, a.blockMinutes);
  const used = a.used + a.blockMinutes;
  return {
    sessionId: blockId,
    endsAt: new Date(Date.now() + a.blockMinutes * 60_000).toISOString(),
    previewUrl: previewUrl(box),
    allowance: { ...allowanceOnly(a), used, left: a.limit === null ? null : Math.max(0, a.limit - used) },
  };
}

/** Add a block to the running session and extend its computer's time to match. */
export async function extendSession(auth: Authed, project: ProjectSummary, backend: WorkspaceBackend = vercelWorkspaces): Promise<StartedSession> {
  const live = await liveSession(auth, project.id);
  const box = live ? await backend.get(workspaceName(live.sessionId)) : null;
  if (!live || !box) throw new ApiError("conflict", "This workspace has already stopped. Start it again.");
  const a = await workspaceAllowance(auth);
  precheck(a, false);
  const blockId = randomUUID();
  const r = await reserve(auth, a, blockId, project.id, live.sessionId);
  if (!r.ok) throw refusal(r.reason, { ...a, used: r.used });
  await recordBlock(auth, a.entitlement, blockId, a.blockMinutes);
  try {
    await box.extendTimeout(a.blockMinutes * 60_000);
  } catch (err) {
    // The block is recorded; the computer will stop at its old time. Report it so it can be looked into.
    reportError(err, { where: "code_workspace.extend" });
    throw new ApiError("upstream_error", "The workspace computer couldn't be given more time. Please start it again.");
  }
  const used = a.used + a.blockMinutes;
  return {
    sessionId: live.sessionId,
    endsAt: new Date(Date.parse(live.endsAt) + a.blockMinutes * 60_000).toISOString(),
    previewUrl: previewUrl(box),
    allowance: { ...allowanceOnly(a), used, left: a.limit === null ? null : Math.max(0, a.limit - used) },
  };
}

export async function stopSession(auth: Authed, projectId: string, backend: WorkspaceBackend = vercelWorkspaces): Promise<void> {
  const live = await liveSession(auth, projectId);
  if (!live) return;
  const box = await backend.get(workspaceName(live.sessionId));
  await box?.stop().catch((err) => reportError(err, { where: "code_workspace.stop" }));
}

/** The running computer for a project, or a clear message that it isn't running. Refuses in the last seconds so nothing restarts it. */
export async function requireBox(auth: Authed, projectId: string, backend: WorkspaceBackend = vercelWorkspaces): Promise<{ box: WorkspaceBox; session: LiveSession }> {
  const live = await liveSession(auth, projectId);
  if (!live || Date.parse(live.endsAt) - Date.now() < 10_000) throw new ApiError("conflict", "The workspace computer isn't running. Press Start to turn it on.", { scope: "workspace_stopped" });
  const box = await backend.get(workspaceName(live.sessionId));
  if (!box) throw new ApiError("conflict", "The workspace computer isn't running. Press Start to turn it on.", { scope: "workspace_stopped" });
  return { box, session: live };
}

/** Running computer if there is one, else null (for best-effort mirroring). */
export async function optionalBox(auth: Authed, projectId: string, backend: WorkspaceBackend = vercelWorkspaces): Promise<WorkspaceBox | null> {
  try {
    return (await requireBox(auth, projectId, backend)).box;
  } catch {
    return null;
  }
}

export function previewUrl(box: WorkspaceBox): string | null {
  try {
    return box.domain(3000);
  } catch {
    return null;
  }
}

export interface SyncResult {
  changed: string[];
  deleted: string[];
  /** Files left out: binary, over 200 KB, or over the project's limits. */
  skipped: string[];
}

/**
 * Copy back what a command did in the computer: files it created or changed
 * since `sinceMs`, and saved files the command removed.
 */
export async function syncBack(auth: Authed, projectId: string, box: WorkspaceBox, sinceMs: number, jobId?: string): Promise<SyncResult> {
  const [saved, collected] = await Promise.all([getFiles(auth, projectId), collectFiles(box, sinceMs - 1_000, jobId)]);
  const plan = syncPlan(saved, collected);
  const skipped = [...collected.skipped.filter((p) => !isIgnoredPath(p))];
  const changed: string[] = [];
  if (plan.deletes.length) await applyFileChanges(auth, projectId, plan.deletes.map((path) => ({ path, content: null })));
  // One at a time, so a file over the project's limits is skipped without losing the others.
  for (const f of plan.upserts) {
    if (!validProjectPath(f.path) || byteLength(f.content) > MAX_FILE_BYTES) {
      skipped.push(f.path);
      continue;
    }
    try {
      await applyFileChanges(auth, projectId, [f]);
      changed.push(f.path);
    } catch {
      skipped.push(f.path);
    }
  }
  return { changed, deleted: plan.deletes, skipped };
}
