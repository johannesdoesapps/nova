import "server-only";
import { createHash } from "node:crypto";
import { ApiError, requireUuid } from "@/lib/http";
import { reportError } from "@/lib/observability";
import { applyFileChanges, createProject, dbError, getFiles, getProjectRow, optionalBox, type Authed } from "./server";
import type { ProjectSummary } from "./projects";
import { removeFromWorkspace, writeToWorkspace } from "./workspace";

/**
 * Parallel copies of a project, so separate tasks can run at the same time without touching each other's files
 * (each project has one session working at a time). A copy remembers each file's hash when it was made; merging it
 * back applies what changed in the copy to the original, and stops at files changed in both since (conflicts),
 * unless the user chooses the copy's version for them.
 */

export type Hashes = Record<string, string>;

export const contentHash = (s: string) => createHash("sha256").update(s).digest("base64url").slice(0, 32);

export interface MergePlan {
  /** Files to write in the original (null content: delete it). */
  apply: { path: string; content: string | null }[];
  /** Changed in the copy and, differently, in the original since the copy was made. */
  conflicts: string[];
  /** Changed in the copy and already the same in the original. */
  same: number;
}

/** Pure: what merging the copy back would do. `copy` maps paths to content; base and original are hashes. */
export function planMerge(base: Hashes, copy: Record<string, string>, original: Hashes): MergePlan {
  const plan: MergePlan = { apply: [], conflicts: [], same: 0 };
  const paths = new Set([...Object.keys(base), ...Object.keys(copy)]);
  for (const p of [...paths].sort()) {
    const b = base[p];
    const c = copy[p] !== undefined ? contentHash(copy[p]!) : undefined;
    if (c === b) continue; // the copy didn't change it
    const o = original[p];
    if (o === c) {
      plan.same++;
      continue;
    }
    if (o === b) plan.apply.push({ path: p, content: copy[p] ?? null });
    else plan.conflicts.push(p);
  }
  return plan;
}

const hashes = (files: { path: string; content: string }[]): Hashes => Object.fromEntries(files.map((f) => [f.path, contentHash(f.content)]));

/** Make a copy of a project for one task. It counts as a project on the plan, like any other. */
export async function createCopy(auth: Authed, projectId: string, task: string): Promise<ProjectSummary> {
  const parent = await getProjectRow(auth, projectId);
  if (parent.parentProjectId) throw new ApiError("bad_request", "This is already a copy. Make copies of the original project.");
  const files = await getFiles(auth, projectId);
  const label = task.trim().replace(/\s+/g, " ").slice(0, 60) || "parallel task";
  return createProject(auth, {
    name: `${parent.name.slice(0, 40)} · ${label}`.slice(0, 80),
    template: parent.template,
    runCommand: parent.runCommand,
    sourceRepo: parent.sourceRepo,
    files,
    copyOf: { parentId: projectId, task: label, base: hashes(files) },
  });
}

/** The project's copies (newest first). */
export async function listCopies(auth: Authed, projectId: string): Promise<{ id: string; name: string; task: string | null; updatedAt: string }[]> {
  requireUuid(projectId);
  const { data, error } = await auth.supabase.from("code_projects").select("id, name, copy_task, updated_at").eq("parent_project_id", projectId).order("updated_at", { ascending: false }).limit(20);
  if (error) throw dbError(error, "code.copies.list");
  return ((data ?? []) as { id: string; name: string; copy_task: string | null; updated_at: string }[]).map((r) => ({ id: r.id, name: r.name, task: r.copy_task, updatedAt: r.updated_at }));
}

export interface MergeResult {
  ok: boolean;
  applied: string[];
  conflicts: string[];
  /** The original project merged into. */
  into: string;
}

/** Merge a copy's changes back into its original. With `force`, the copy's version wins in conflicts too. */
export async function mergeCopy(auth: Authed, copyId: string, opts: { force?: boolean } = {}): Promise<MergeResult> {
  requireUuid(copyId);
  const { data, error } = await auth.supabase.from("code_projects").select("parent_project_id, copy_base").eq("id", copyId).maybeSingle();
  if (error) throw dbError(error, "code.copies.get");
  const row = data as { parent_project_id: string | null; copy_base: Hashes | null } | null;
  if (!row) throw new ApiError("not_found", "Project not found.");
  if (!row.parent_project_id || !row.copy_base) throw new ApiError("bad_request", "This project isn't a copy of another one.");
  const parentId = row.parent_project_id;
  await getProjectRow(auth, parentId).catch(() => {
    throw new ApiError("not_found", "The original project no longer exists, so there's nothing to merge into.");
  });
  const { data: open } = await auth.supabase.from("code_agent_runs").select("id").eq("project_id", parentId).in("status", ["planning", "awaiting_approval", "running", "needs_input"]).limit(1);
  if ((open ?? []).length) throw new ApiError("conflict", "A session is working on the original project. Let it finish (or stop it) before merging.");
  const [copyFiles, originalFiles] = await Promise.all([getFiles(auth, copyId), getFiles(auth, parentId)]);
  const copy = Object.fromEntries(copyFiles.map((f) => [f.path, f.content]));
  const plan = planMerge(row.copy_base, copy, hashes(originalFiles));
  if (plan.conflicts.length && !opts.force) return { ok: false, applied: [], conflicts: plan.conflicts, into: parentId };
  const apply = [...plan.apply, ...(opts.force ? plan.conflicts.map((p) => ({ path: p, content: copy[p] ?? null })) : [])];
  if (apply.length) {
    await applyFileChanges(auth, parentId, apply);
    const box = await optionalBox(auth, parentId);
    if (box) {
      try {
        await removeFromWorkspace(
          box,
          apply.filter((a) => a.content === null).map((a) => a.path),
        );
        await writeToWorkspace(
          box,
          apply.filter((a): a is { path: string; content: string } => a.content !== null),
        );
      } catch (err) {
        reportError(err, { where: "code.copies.mirror" });
      }
    }
  }
  // The copy now matches what was merged: a later merge only brings what changes after this one.
  const { error: baseError } = await auth.supabase.from("code_projects").update({ copy_base: hashes(copyFiles) }).eq("id", copyId);
  if (baseError) throw dbError(baseError, "code.copies.base");
  return { ok: true, applied: apply.map((a) => a.path), conflicts: opts.force ? plan.conflicts : [], into: parentId };
}
