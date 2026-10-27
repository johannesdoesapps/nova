import "server-only";
import { ApiError } from "@/lib/http";
import type { Fetch } from "./app";

/**
 * Push a Code project to a NEW branch of one of the user's repositories, as
 * one commit on top of the repository's default branch. Never writes to an
 * existing branch, so nothing already on GitHub is overwritten; the user
 * opens a pull request from the branch if they want the changes.
 *
 * Needs Orbis's GitHub App to have "Contents: Read and write" on the
 * repository. Without it GitHub refuses, and the user is told why.
 */

const API = "https://api.github.com";

export const BRANCH_RE = /^(?!.*\.\.)(?!.*\/\/)(?!\/)(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9._/-]{1,100}$/;

export interface PushFile {
  path: string;
  content: string;
}

export interface PushResult {
  branch: string;
  /** The repository's default branch (what the branch was made from). */
  base: string;
  commitSha: string;
  commitUrl: string;
  compareUrl: string;
}

async function call<T>(f: Fetch, token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; data: T | null }> {
  const res = await f(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "orbis-ai",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(30_000),
    cache: "no-store",
  });
  if (res.status === 404) return { status: 404, data: null };
  if (res.status === 422 && path.endsWith("/git/refs")) return { status: 422, data: null };
  if (res.status === 403 || res.status === 401) {
    throw new ApiError("forbidden", "GitHub refused the push. Orbis's GitHub App needs “Contents: Read and write” permission on this repository (GitHub → Settings → Applications → Orbis → Configure).");
  }
  if (!res.ok) throw new ApiError("upstream_error", `GitHub didn't accept the push (${res.status}). Nothing was changed on GitHub.`);
  return { status: res.status, data: (await res.json()) as T };
}

export async function pushBranch(
  token: string,
  input: { repo: string; branch: string; message: string; files: PushFile[]; deleted: string[] },
  f: Fetch = fetch,
): Promise<PushResult> {
  const { repo, branch } = input;
  if (!BRANCH_RE.test(branch)) throw new ApiError("bad_request", "Use a branch name like orbis/my-change.");
  const meta = await call<{ default_branch: string; html_url: string }>(f, token, `/repos/${repo}`);
  if (!meta.data) throw new ApiError("not_found", "That repository isn't available to Orbis. Check which repositories you gave Orbis access to on GitHub.");
  const base = meta.data.default_branch;
  const exists = await call(f, token, `/repos/${repo}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`);
  if (exists.data) throw new ApiError("conflict", `The branch “${branch}” already exists on GitHub. Choose a new branch name; Orbis never overwrites an existing branch.`);
  const head = await call<{ object: { sha: string } }>(f, token, `/repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`);
  if (!head.data) throw new ApiError("not_found", "The repository's main branch couldn't be found.");
  const parent = head.data.object.sha;
  const commit = await call<{ tree: { sha: string } }>(f, token, `/repos/${repo}/git/commits/${parent}`);
  if (!commit.data) throw new ApiError("not_found", "The repository's latest commit couldn't be read.");

  // Only delete files the repository actually has (GitHub rejects the rest).
  let deletes: string[] = [];
  if (input.deleted.length) {
    const t = await call<{ tree: { path: string; type: string }[] }>(f, token, `/repos/${repo}/git/trees/${commit.data.tree.sha}?recursive=1`);
    const present = new Set((t.data?.tree ?? []).filter((x) => x.type === "blob").map((x) => x.path));
    deletes = input.deleted.filter((p) => present.has(p));
  }
  // On top of the existing tree: files the project has are written; files the agent deleted are removed. Others stay as they are.
  const tree = [
    ...input.files.map((x) => ({ path: x.path, mode: "100644", type: "blob", content: x.content })),
    ...deletes.filter((p) => !input.files.some((x) => x.path === p)).map((p) => ({ path: p, mode: "100644", type: "blob", sha: null })),
  ];
  const newTree = await call<{ sha: string }>(f, token, `/repos/${repo}/git/trees`, { method: "POST", body: { base_tree: commit.data.tree.sha, tree } });
  if (!newTree.data) throw new ApiError("upstream_error", "GitHub didn't accept the files.");
  const newCommit = await call<{ sha: string; html_url: string }>(f, token, `/repos/${repo}/git/commits`, { method: "POST", body: { message: input.message, tree: newTree.data.sha, parents: [parent] } });
  if (!newCommit.data) throw new ApiError("upstream_error", "GitHub didn't accept the commit.");
  const ref = await call(f, token, `/repos/${repo}/git/refs`, { method: "POST", body: { ref: `refs/heads/${branch}`, sha: newCommit.data.sha } });
  if (ref.status === 422) throw new ApiError("conflict", `The branch “${branch}” couldn't be created (it may already exist). Choose another name.`);
  return {
    branch,
    base,
    commitSha: newCommit.data.sha,
    commitUrl: newCommit.data.html_url,
    compareUrl: `${meta.data.html_url}/compare/${encodeURIComponent(base)}...${branch.split("/").map(encodeURIComponent).join("/")}?expand=1`,
  };
}

/**
 * Open a pull request from a branch Orbis just pushed into the repository's default branch. Nothing is merged.
 * Its own errors: the push itself has already succeeded when this runs.
 */
export async function openPullRequest(
  token: string,
  input: { repo: string; head: string; base: string; title: string; body: string; draft?: boolean },
  f: Fetch = fetch,
): Promise<{ number: number; url: string }> {
  const res = await f(`${API}/repos/${input.repo}/pulls`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28", "user-agent": "orbis-ai", "content-type": "application/json" },
    body: JSON.stringify({ title: input.title, body: input.body, head: input.head, base: input.base, draft: input.draft ?? false }),
    signal: AbortSignal.timeout(30_000),
    cache: "no-store",
  });
  if (res.status === 401 || res.status === 403 || res.status === 404)
    throw new ApiError("forbidden", "GitHub didn't let Orbis open the pull request. Orbis's GitHub App needs “Pull requests: Read and write” on this repository (GitHub → Settings → Applications → Orbis → Configure).");
  if (res.status === 422) throw new ApiError("conflict", "GitHub couldn't open the pull request: one may already exist for this branch, or it has no changes.");
  if (!res.ok) throw new ApiError("upstream_error", `GitHub didn't open the pull request (${res.status}).`);
  const pr = (await res.json()) as { number: number; html_url: string };
  return { number: pr.number, url: pr.html_url };
}
