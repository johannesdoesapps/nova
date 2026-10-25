import "server-only";
import { z } from "zod";
import type { Authed } from "../code/server";
import { getRun, listChanges } from "../code/agent/runs";
import { unifiedDiff } from "../code/diff";
import { getFiles, getProjectRow } from "../code/server";
import { installationToken, repoFile, repoTree, safePath } from "../github/app";
import { githubContext } from "../github/server";
import { ApiError } from "../http";
import { githubReadToken } from "../security/connections";
import { fetchRepoFiles } from "../security/github";
import { parseUnifiedDiff, type ReviewFile } from "./review";
import { unzip } from "./unzip";

/**
 * Where the code for a review comes from. Every source ends up as the same snapshot of files (and, for a
 * change, its diff), stored with the review so findings can be checked and inspected later. GitHub is
 * read-only here: public repositories and pull requests without credentials, the user's own repositories
 * through the Orbis GitHub App they installed.
 */

export const LIMITS = { files: 400, fileBytes: 120_000, totalBytes: 1_500_000, zipBytes: 3_000_000, prFiles: 40 };

export const sourceInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("paste"),
    files: z
      .array(z.object({ path: z.string().trim().min(1).max(300), content: z.string().max(LIMITS.fileBytes) }))
      .min(1)
      .max(50),
  }),
  z.object({ kind: z.literal("diff"), diff: z.string().min(10).max(600_000) }),
  // Base64 of a .zip (Vercel accepts request bodies up to about 4.5 MB).
  z.object({ kind: z.literal("zip"), name: z.string().max(200).optional(), data: z.string().max(Math.ceil((LIMITS.zipBytes * 4) / 3) + 8) }),
  z.object({ kind: z.literal("github"), url: z.string().trim().min(3).max(400) }),
  z.object({ kind: z.literal("project"), projectId: z.string().uuid() }),
  // The changes agent tasks made in a project (a Bug Fixing patch, QA's tests): reviewed as a diff of the files now.
  z.object({ kind: z.literal("changes"), projectId: z.string().uuid(), taskIds: z.array(z.string().uuid()).min(1).max(5) }),
]);
export type SourceInput = z.infer<typeof sourceInput>;

export interface LoadedSource {
  title: string;
  source: { kind: string; label: string; url?: string; ref?: string; projectId?: string };
  files: ReviewFile[];
  diff: string | null;
  notes: string[];
}

const validPath = (p: string) => safePath(p) && !p.split("/").includes("..") && !p.startsWith("/");

function capFiles(files: { path: string; content: string; changed?: boolean }[], notes: string[]): ReviewFile[] {
  const out: ReviewFile[] = [];
  let total = 0;
  let dropped = 0;
  for (const f of files) {
    if (!validPath(f.path) || f.content.includes("\0")) {
      dropped++;
      continue;
    }
    if (out.length >= LIMITS.files || f.content.length > LIMITS.fileBytes || total + f.content.length > LIMITS.totalBytes) {
      dropped++;
      continue;
    }
    total += f.content.length;
    out.push(f);
  }
  if (dropped) notes.push(`${dropped} file${dropped === 1 ? " was" : "s were"} left out (binary, too large, or over the ${LIMITS.files}-file / 1.5 MB limit).`);
  return out;
}

/** owner/name/pull/123 or a github.com pull request URL. */
export function parsePullUrl(s: string): { owner: string; repo: string; number: number } | null {
  const m = /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/pull\/(\d{1,7})(?:[/?#].*)?$/.exec(s.trim());
  return m ? { owner: m[1]!, repo: m[2]!, number: Number(m[3]) } : null;
}

async function gh(url: string, accept: string, token: string | null, signal?: AbortSignal): Promise<Response> {
  return fetch(url, { headers: { accept, "user-agent": "orbis-code-review", ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal });
}

/** The user's installation token, or null when GitHub isn't linked or installed (never throws for that). */
async function userToken(): Promise<string | null> {
  try {
    const ctx = await githubContext();
    return ctx.cfg && ctx.installation ? await installationToken(ctx.cfg, ctx.installation.id) : null;
  } catch {
    return null;
  }
}

async function loadPull(pr: { owner: string; repo: string; number: number }, signal: AbortSignal): Promise<LoadedSource> {
  const api = `https://api.github.com/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`;
  let token: string | null = null;
  let meta = await gh(api, "application/vnd.github+json", null, signal);
  if (meta.status === 404 || meta.status === 403) {
    token = await userToken();
    if (token) meta = await gh(api, "application/vnd.github+json", token, signal);
  }
  if (meta.status === 403 && token)
    throw new ApiError("forbidden", "Orbis's GitHub App can't read pull requests in that repository: it needs the “Pull requests: read” permission. Until then, paste the diff instead.");
  if (meta.status === 404)
    throw new ApiError("not_found", "Pull request not found. If the repository is private, install the Orbis GitHub App on it (Connectors → GitHub), or paste the diff instead.");
  if (meta.status === 403 || meta.status === 429) throw new ApiError("rate_limited", "GitHub's rate limit for anonymous requests was reached. Try again later, or paste the diff.");
  if (!meta.ok) throw new ApiError("upstream_error", `GitHub returned HTTP ${meta.status}.`);
  const j = (await meta.json()) as { title?: string; html_url?: string; head?: { sha?: string; repo?: { full_name?: string } | null }; changed_files?: number };
  const diffRes = await gh(api, "application/vnd.github.diff", token, signal);
  if (!diffRes.ok) throw new ApiError("upstream_error", `GitHub returned HTTP ${diffRes.status} for the diff.`);
  const diff = await diffRes.text();
  if (diff.length > 600_000) throw new ApiError("bad_request", "That pull request's diff is too large to review here (over 600 KB).");
  const notes: string[] = [];
  const parts = parseUnifiedDiff(diff);
  const headRepo = j.head?.repo?.full_name ?? `${pr.owner}/${pr.repo}`;
  const sha = j.head?.sha;
  // The full new version of each changed file gives the reviewer the surrounding code; the hunks are the fallback.
  const files: ReviewFile[] = [];
  for (const p of parts.slice(0, LIMITS.prFiles)) {
    let full: string | null = null;
    if (sha && validPath(p.path)) {
      const raw = token
        ? await gh(`https://api.github.com/repos/${headRepo}/contents/${p.path.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`, "application/vnd.github.raw", token, signal).catch(() => null)
        : await fetch(`https://raw.githubusercontent.com/${headRepo}/${sha}/${p.path.split("/").map(encodeURIComponent).join("/")}`, { signal }).catch(() => null);
      if (raw?.ok) {
        const t = await raw.text();
        if (t.length <= LIMITS.fileBytes && !t.includes("\0")) full = t;
      }
    }
    files.push(full !== null ? { path: p.path, content: full, changed: true } : p);
  }
  if (parts.length > LIMITS.prFiles) notes.push(`Only the first ${LIMITS.prFiles} of ${parts.length} changed files were included.`);
  if (files.some((f) => f.lineNos)) notes.push("Some changed files could only be read as diff hunks, so less surrounding code was available.");
  return {
    title: `PR #${pr.number}: ${(j.title ?? "").slice(0, 150) || `${pr.owner}/${pr.repo}`}`,
    source: { kind: "github_pr", label: `${pr.owner}/${pr.repo}#${pr.number}`, url: j.html_url ?? `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`, ref: sha },
    files: capFiles(files, notes),
    diff,
    notes,
  };
}

async function loadRepo(auth: Authed, url: string, signal: AbortSignal): Promise<LoadedSource> {
  const notes: string[] = [];
  try {
    const r = await fetchRepoFiles(url, { token: (await githubReadToken(auth, signal)).token, signal });
    if (r.truncated) notes.push("The repository was larger than the snapshot limit; some files were skipped.");
    return { title: r.label, source: { kind: "github_repo", label: r.label, url: `https://github.com/${r.label}`, ref: r.ref }, files: capFiles(r.files, notes), diff: null, notes };
  } catch (err) {
    // Not public: try the user's own Orbis GitHub App installation.
    const m = /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})(?:\/.*)?$/.exec(url.trim().replace(/\.git$/, ""));
    const token = m ? await userToken() : null;
    if (!m || !token) throw new ApiError("bad_request", (err as Error).message || "Couldn't read that repository.");
    const repo = m[1]!;
    const tree = await repoTree(token, repo).catch(() => {
      throw new ApiError("not_found", "Repository not found, or Orbis's GitHub App can't read it. Add it under Connectors → GitHub.");
    });
    let total = 0;
    const picked = tree.files.filter((f) => f.size <= LIMITS.fileBytes && (total += f.size) <= LIMITS.totalBytes).slice(0, LIMITS.files);
    const read: { path: string; content: string }[] = [];
    for (let i = 0; i < picked.length; i += 8) {
      const batch = await Promise.all(picked.slice(i, i + 8).map((f) => repoFile(token, repo, f.path).catch(() => null)));
      for (const b of batch) if (b) read.push({ path: b.path, content: b.content });
    }
    if (tree.truncated || picked.length < tree.files.length) notes.push("Not every file fit in the snapshot limit.");
    return { title: repo, source: { kind: "github_repo", label: repo, url: `https://github.com/${repo}`, ref: tree.branch }, files: capFiles(read, notes), diff: null, notes };
  }
}

/**
 * What one or more agent tasks changed in a project: each changed file as it is now (marked changed), and
 * a diff from before the first task touched it, so findings on the new lines are flagged as in the change.
 * The tasks must be the user's (row-level security) and in this project.
 */
async function loadChanges(auth: Authed, projectId: string, taskIds: string[]): Promise<LoadedSource> {
  const project = await getProjectRow(auth, projectId);
  const before = new Map<string, string | null>();
  for (const id of taskIds) {
    const run = await getRun(auth, id);
    if (run.project_id !== project.id) throw new ApiError("bad_request", "That task belongs to another project.");
    for (const c of await listChanges(auth, id)) if (!before.has(c.path)) before.set(c.path, c.before);
  }
  const now = new Map((await getFiles(auth, project.id)).map((f) => [f.path, f.content]));
  const changed = [...before.entries()].filter(([path, was]) => (now.get(path) ?? null) !== was);
  if (!changed.length) throw new ApiError("bad_request", "Those tasks left no changes to review (nothing changed, or the changes were undone).");
  const notes: string[] = [];
  const files = capFiles(
    changed.filter(([path]) => now.has(path)).map(([path]) => ({ path, content: now.get(path)!, changed: true })),
    notes,
  );
  const diff = changed.map(([path, was]) => unifiedDiff(path, was, now.get(path) ?? null)).join("\n");
  const deleted = changed.filter(([path]) => !now.has(path)).length;
  if (deleted) notes.push(`${deleted} deleted file${deleted === 1 ? " is" : "s are"} only in the diff.`);
  return {
    title: `Changes in ${project.name}`.slice(0, 200),
    source: { kind: "changes", label: `${project.name}: ${changed.length} changed file${changed.length === 1 ? "" : "s"}`, projectId: project.id },
    files,
    diff: diff.slice(0, 600_000),
    notes,
  };
}

export async function loadSource(auth: Authed, input: SourceInput, signal: AbortSignal): Promise<LoadedSource> {
  const notes: string[] = [];
  switch (input.kind) {
    case "paste": {
      const files = capFiles(
        input.files.map((f) => ({ path: f.path.replace(/^\.?\/+/, ""), content: f.content })),
        notes,
      );
      if (!files.length) throw new ApiError("bad_request", "Add at least one file with code in it.");
      return { title: files.length === 1 ? files[0]!.path : `${files.length} files`, source: { kind: "paste", label: "Pasted code" }, files, diff: null, notes };
    }
    case "diff": {
      const files = parseUnifiedDiff(input.diff);
      if (!files.length) throw new ApiError("bad_request", "That doesn't look like a unified diff (from git diff or a .diff/.patch file).");
      return {
        title: `Diff: ${files.length} file${files.length === 1 ? "" : "s"}`,
        source: { kind: "diff", label: "Pasted diff" },
        files: capFiles(files, notes),
        diff: input.diff,
        notes: [...notes, "A pasted diff only shows the changed hunks, so the reviewer sees less surrounding code than in a full project."],
      };
    }
    case "zip": {
      const buf = Buffer.from(input.data, "base64");
      if (buf.length > LIMITS.zipBytes) throw new ApiError("bad_request", "The ZIP is over 3 MB. Remove dependencies and build output, or review a GitHub repository instead.");
      let r;
      try {
        r = unzip(buf, { maxFiles: LIMITS.files, maxFileBytes: LIMITS.fileBytes, maxTotalBytes: LIMITS.totalBytes });
      } catch (e) {
        throw new ApiError("bad_request", (e as Error).message);
      }
      if (!r.files.length) throw new ApiError("bad_request", "The ZIP has no text files Orbis can review.");
      if (r.skipped) notes.push(`${r.skipped} entr${r.skipped === 1 ? "y was" : "ies were"} skipped (binary, dependency or build folders, too large, or unsafe paths).`);
      const name = (input.name ?? "Upload.zip").replace(/[^\w.\- ]/g, "").slice(0, 120) || "Upload.zip";
      return { title: name, source: { kind: "zip", label: name }, files: capFiles(r.files, notes), diff: null, notes };
    }
    case "github": {
      const pr = parsePullUrl(input.url);
      return pr ? loadPull(pr, signal) : loadRepo(auth, input.url, signal);
    }
    case "changes":
      return loadChanges(auth, input.projectId, input.taskIds);
    case "project": {
      const project = await getProjectRow(auth, input.projectId);
      const files = capFiles(await getFiles(auth, input.projectId), notes);
      if (!files.length) throw new ApiError("bad_request", "That project has no files yet.");
      return { title: project.name, source: { kind: "project", label: project.name, projectId: project.id }, files, diff: null, notes };
    }
  }
}
