import "server-only";
import { z } from "zod";
import { REPO_RE, safePath } from "@/lib/github/app";
import { connectorMeta, type ConnectorItem } from "../catalog";
import { call, callJson, clip, ConnectorError, type Fetch } from "../http";
import type { ActionDef, Connector, OAuthClient, TokenSet, ToolContext, ToolDef } from "../types";

/**
 * GitHub, signed in with Orbis's GitHub App (user access tokens). The person
 * signs in on GitHub and installs the app on the repositories they choose; the
 * token can reach only repositories that the person can access AND the app is
 * installed on, with only the permissions the app was given. Tokens expire
 * after 8 hours and are refreshed with the refresh token (GitHub's default for
 * apps); disconnecting revokes the grant at GitHub.
 *
 * Writes (branch, commit, pull request, issue) run only after the person
 * confirms them on a card. Commits never go to a repository's default branch:
 * changes land on a branch and reach the default branch through a pull request.
 */

const GH = "https://api.github.com";
const H = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
const SERVICE = "GitHub";
const BRANCH_RE = /^(?!\/|.*(?:\.\.|\/\/|@\{|\\|\.lock$|\/$))[A-Za-z0-9._\/-]{1,200}$/;
const MAX_FILE_BYTES = 1_000_000;

const enc = (path: string) => path.split("/").map(encodeURIComponent).join("/");
const get = <T>(ctx: ToolContext, path: string) => callJson<T>(`${GH}${path}`, { token: ctx.token, headers: H, service: SERVICE, signal: ctx.signal }, ctx.fetch);
const send = <T>(ctx: ToolContext, method: string, path: string, json: unknown) =>
  callJson<T>(`${GH}${path}`, { method, token: ctx.token, headers: H, json, service: SERVICE, signal: ctx.signal, retries: 0 }, ctx.fetch);

export interface Repo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  canPush: boolean;
}

/**
 * The repositories this connection can use: for each installation of the app the person can access, its
 * repositories (GitHub lists only those both the person and the app can reach). Capped to keep calls bounded.
 */
export async function accessibleRepos(ctx: ToolContext): Promise<Repo[]> {
  const inst = await get<{ installations?: { id: number }[] }>(ctx, "/user/installations?per_page=100");
  const repos: Repo[] = [];
  for (const i of (inst.installations ?? []).slice(0, 10)) {
    for (let page = 1; page <= 3; page++) {
      const r = await get<{ repositories?: { full_name: string; private: boolean; default_branch: string; permissions?: { push?: boolean } }[] }>(ctx, `/user/installations/${i.id}/repositories?per_page=100&page=${page}`);
      const batch = r.repositories ?? [];
      repos.push(...batch.map((x) => ({ fullName: x.full_name, private: x.private, defaultBranch: x.default_branch, canPush: !!x.permissions?.push })));
      if (batch.length < 100) break;
    }
  }
  return repos;
}

/** The repository, if this connection can use it; otherwise a message that says how to share it. */
export async function requireRepo(ctx: ToolContext, repo: string): Promise<Repo> {
  const found = (await accessibleRepos(ctx)).find((r) => r.fullName.toLowerCase() === repo.toLowerCase());
  if (!found) throw new ConnectorError("permission", `${repo} isn't one of the repositories you shared with Orbis on GitHub. Add it under “Choose repositories” on the Connectors page.`);
  return found;
}

/** Search text with repo: qualifiers for the shared repositories, within GitHub's 256-character limit. */
export function scopedQuery(query: string, repos: string[], kind?: "issue" | "pr", state?: "open" | "closed"): string {
  let q = query.replace(/\brepo:\S+/g, "").trim();
  if (kind) q += ` is:${kind}`;
  if (state) q += ` is:${state}`;
  for (const r of repos) {
    if ((q + ` repo:${r}`).length > 256) break;
    q += ` repo:${r}`;
  }
  return q.trim();
}

const looksBinary = (buf: Buffer) => buf.subarray(0, 8000).includes(0);

async function fileAt(ctx: ToolContext, repo: string, path: string, ref?: string): Promise<{ text: string; sha: string; size: number } | null> {
  try {
    const f = await get<{ type: string; size: number; encoding?: string; content?: string; sha: string }>(ctx, `/repos/${repo}/contents/${enc(path)}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`);
    if (f.type !== "file") throw new ConnectorError("bad_request", `${path} is a folder, not a file.`);
    if (f.size > MAX_FILE_BYTES || f.encoding !== "base64" || f.content == null) throw new ConnectorError("bad_request", `${path} is too large to read here (over 1 MB).`);
    const buf = Buffer.from(f.content, "base64");
    if (looksBinary(buf)) throw new ConnectorError("bad_request", `${path} is a binary file, which Orbis doesn't read as text.`);
    return { text: buf.toString("utf8"), sha: f.sha, size: f.size };
  } catch (err) {
    if (err instanceof ConnectorError && err.kind === "not_found") return null;
    throw err;
  }
}

async function branchSha(ctx: ToolContext, repo: string, branch: string): Promise<string | null> {
  try {
    const r = await get<{ object: { sha: string } }>(ctx, `/repos/${repo}/git/ref/heads/${enc(branch)}`);
    return r.object.sha;
  } catch (err) {
    if (err instanceof ConnectorError && err.kind === "not_found") return null;
    throw err;
  }
}

/** Create `branch` from `from` (default branch when omitted). Returns whether it was created (false if it existed). */
async function ensureBranch(ctx: ToolContext, repo: Repo, branch: string, from?: string): Promise<boolean> {
  if (await branchSha(ctx, repo.fullName, branch)) return false;
  const base = from ?? repo.defaultBranch;
  const sha = await branchSha(ctx, repo.fullName, base);
  if (!sha) throw new ConnectorError("not_found", `The branch ${base} doesn't exist in ${repo.fullName}.`);
  await send(ctx, "POST", `/repos/${repo.fullName}/git/refs`, { ref: `refs/heads/${branch}`, sha });
  return true;
}

function notDefault(repo: Repo, branch: string) {
  if (branch === repo.defaultBranch)
    throw new ConnectorError("bad_request", `Orbis doesn't commit straight to ${repo.fullName}'s default branch (${branch}). Use a new branch and open a pull request.`);
}

// ---------------------------------------------------------------- read tools

const repoArg = z.string().regex(REPO_RE, "Use owner/name.");
const pathArg = z.string().max(500).refine(safePath, "Use a plain path like src/index.ts.");
const branchArg = z.string().regex(BRANCH_RE, "Use a plain branch name like orbis/fix-login.");

const listRepos: ToolDef<Record<string, never>> = {
  name: "github_list_repos",
  description: "List the GitHub repositories the user shared with Orbis (name, visibility, default branch).",
  access: "read",
  input: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  args: "{}",
  async run(ctx) {
    const repos = await accessibleRepos(ctx);
    return {
      summary: repos.length ? `${repos.length} repositor${repos.length === 1 ? "y" : "ies"}` : "No repositories shared yet",
      items: repos.slice(0, 40).map((r) => ({
        connectorId: "github",
        title: r.fullName,
        url: `https://github.com/${r.fullName}`,
        snippet: `${r.private ? "Private" : "Public"} · default branch ${r.defaultBranch}${r.canPush ? "" : " · read-only for you"}`,
        read: { tool: "github_list_files", args: { repo: r.fullName } },
      })),
      ...(repos.length ? {} : { text: "No repositories are shared with Orbis yet. The user can choose repositories under GitHub → Choose repositories on the Connectors page." }),
    };
  },
};

const listFiles: ToolDef<{ repo: string; ref?: string; path?: string }> = {
  name: "github_list_files",
  description: "List the files in a shared GitHub repository (optionally under a folder, on a branch).",
  access: "read",
  input: z.object({ repo: repoArg, ref: branchArg.optional(), path: pathArg.optional() }),
  args: '{"repo": "owner/name", "ref"?: branch, "path"?: folder}',
  async run(ctx, i) {
    const repo = await requireRepo(ctx, i.repo);
    const ref = i.ref ?? repo.defaultBranch;
    const t = await get<{ tree?: { path: string; type: string; size?: number }[]; truncated?: boolean }>(ctx, `/repos/${repo.fullName}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
    const prefix = i.path ? `${i.path.replace(/\/$/, "")}/` : "";
    const files = (t.tree ?? []).filter((x) => x.type === "blob" && x.path.startsWith(prefix));
    const shown = files.slice(0, 400);
    return {
      summary: `${files.length} file${files.length === 1 ? "" : "s"} in ${repo.fullName}${prefix ? `/${prefix}` : ""} (${ref})`,
      items: shown.slice(0, 20).map((f) => ({ connectorId: "github", title: `${repo.fullName}: ${f.path}`, url: `https://github.com/${repo.fullName}/blob/${encodeURIComponent(ref)}/${enc(f.path)}`, snippet: `${f.size ?? 0} bytes`, read: { tool: "github_read_file", args: { repo: repo.fullName, path: f.path, ref } } })),
      text: `Files in ${repo.fullName} on ${ref}${t.truncated || files.length > shown.length ? " (list shortened)" : ""}:\n${shown.map((f) => f.path).join("\n")}`,
    };
  },
};

const readFile: ToolDef<{ repo: string; path: string; ref?: string }> = {
  name: "github_read_file",
  description: "Read a text file from a shared GitHub repository (default branch unless a branch is given).",
  access: "read",
  input: z.object({ repo: repoArg, path: pathArg, ref: branchArg.optional() }),
  args: '{"repo": "owner/name", "path": file path, "ref"?: branch}',
  async run(ctx, i) {
    const repo = await requireRepo(ctx, i.repo);
    const ref = i.ref ?? repo.defaultBranch;
    const f = await fileAt(ctx, repo.fullName, i.path, ref);
    if (!f) throw new ConnectorError("not_found", `${i.path} isn't in ${repo.fullName} on ${ref}.`);
    return {
      summary: `Read ${repo.fullName}/${clip(i.path, 60)} (${ref})`,
      items: [{ connectorId: "github", title: `${repo.fullName}: ${i.path}`, url: `https://github.com/${repo.fullName}/blob/${encodeURIComponent(ref)}/${enc(i.path)}`, snippet: clip(f.text.replace(/\s+/g, " "), 240) }],
      text: clip(f.text, 40_000),
    };
  },
};

const listBranches: ToolDef<{ repo: string }> = {
  name: "github_list_branches",
  description: "List the branches of a shared GitHub repository.",
  access: "read",
  input: z.object({ repo: repoArg }),
  args: '{"repo": "owner/name"}',
  async run(ctx, i) {
    const repo = await requireRepo(ctx, i.repo);
    const b = await get<{ name: string; protected?: boolean; commit: { sha: string } }[]>(ctx, `/repos/${repo.fullName}/branches?per_page=100`);
    return {
      summary: `${b.length} branch${b.length === 1 ? "" : "es"} in ${repo.fullName}`,
      items: b.slice(0, 40).map((x) => ({ connectorId: "github", title: `${repo.fullName}: ${x.name}`, url: `https://github.com/${repo.fullName}/tree/${enc(x.name)}`, snippet: `${x.name === repo.defaultBranch ? "Default branch · " : ""}${x.protected ? "Protected · " : ""}${x.commit.sha.slice(0, 7)}` })),
    };
  },
};

const listPulls: ToolDef<{ repo: string; state?: "open" | "closed" | "all" }> = {
  name: "github_list_pull_requests",
  description: "List pull requests in a shared GitHub repository (open by default).",
  access: "read",
  input: z.object({ repo: repoArg, state: z.enum(["open", "closed", "all"]).optional() }),
  args: '{"repo": "owner/name", "state"?: "open" | "closed" | "all"}',
  async run(ctx, i) {
    const repo = await requireRepo(ctx, i.repo);
    const p = await get<{ number: number; title: string; html_url: string; state: string; draft?: boolean; user?: { login?: string }; head: { ref: string }; base: { ref: string }; updated_at: string }[]>(
      ctx,
      `/repos/${repo.fullName}/pulls?state=${i.state ?? "open"}&per_page=20&sort=updated&direction=desc`,
    );
    return {
      summary: `${p.length} pull request${p.length === 1 ? "" : "s"} in ${repo.fullName}`,
      items: p.map((x) => ({ connectorId: "github", title: `PR #${x.number}: ${x.title}`, url: x.html_url, snippet: `${x.draft ? "draft · " : ""}${x.state} · ${x.head.ref} → ${x.base.ref} · by ${x.user?.login ?? "?"} · updated ${x.updated_at.slice(0, 10)}` })),
    };
  },
};

const searchIssues: ToolDef<{ query: string; repo?: string; kind?: "issue" | "pr"; state?: "open" | "closed"; limit?: number }> = {
  name: "github_search_issues",
  description: "Search issues and pull requests in the user's shared GitHub repositories. Returns titles, numbers, state, authors and links.",
  access: "read",
  input: z.object({ query: z.string().trim().max(200), repo: repoArg.optional(), kind: z.enum(["issue", "pr"]).optional(), state: z.enum(["open", "closed"]).optional(), limit: z.number().int().min(1).max(20).optional() }),
  args: '{"query": words, "repo"?: "owner/name", "kind"?: "issue" | "pr", "state"?: "open" | "closed", "limit"?: 1-20}',
  async run(ctx, i) {
    const shared = (await accessibleRepos(ctx)).map((r) => r.fullName);
    if (i.repo && !shared.some((r) => r.toLowerCase() === i.repo!.toLowerCase())) throw new ConnectorError("permission", `${i.repo} isn't one of the repositories you shared with Orbis.`);
    if (!shared.length) return { summary: "No repositories shared yet", items: [] };
    const q = scopedQuery(i.query, i.repo ? [i.repo] : shared, i.kind, i.state);
    const r = await get<{ items?: { title: string; number: number; html_url: string; state: string; user?: { login?: string }; pull_request?: unknown; updated_at?: string; repository_url?: string }[] }>(ctx, `/search/issues?${new URLSearchParams({ q, per_page: String(i.limit ?? 10), sort: "updated" })}`);
    const items: ConnectorItem[] = (r.items ?? []).map((x) => ({
      connectorId: "github",
      title: `${x.pull_request ? "PR" : "Issue"} #${x.number}: ${x.title}`,
      url: x.html_url,
      snippet: `${x.repository_url?.split("/repos/")[1] ?? ""} · ${x.state} · by ${x.user?.login ?? "?"} · updated ${x.updated_at?.slice(0, 10) ?? "?"}`,
    }));
    return { summary: `${items.length} issue${items.length === 1 ? "" : "s"} or pull request${items.length === 1 ? "" : "s"}`, items };
  },
};

// ---------------------------------------------------------------- confirmed actions

const createBranch: ActionDef<{ repo: string; branch: string; from?: string }> = {
  name: "github_create_branch",
  description: "Create a new branch in a shared GitHub repository (from the default branch unless another is given).",
  access: "write",
  scope: "contents:write",
  input: z.object({ repo: repoArg, branch: branchArg, from: branchArg.optional() }),
  args: '{"repo": "owner/name", "branch": new branch name, "from"?: existing branch}',
  fields: [
    { key: "repo", label: "Repository" },
    { key: "branch", label: "New branch" },
    { key: "from", label: "Start from (blank = default branch)" },
  ],
  describe: (i) => `Create the branch ${i.branch} in ${i.repo}${i.from ? ` from ${i.from}` : ""}. Nothing else changes.`,
  async run(ctx, i) {
    const repo = await requireRepo(ctx, i.repo);
    const created = await ensureBranch(ctx, repo, i.branch, i.from || undefined);
    if (!created) throw new ConnectorError("bad_request", `The branch ${i.branch} already exists in ${repo.fullName}.`);
    return { summary: `Created branch ${i.branch} in ${repo.fullName}.`, url: `https://github.com/${repo.fullName}/tree/${enc(i.branch)}` };
  },
};

const commitFile: ActionDef<{ repo: string; branch: string; path: string; content: string; message: string }> = {
  name: "github_commit_file",
  description:
    "Create or replace one file on a branch of a shared GitHub repository, as one commit (the branch is created from the default branch if it doesn't exist). Never the default branch: use a new branch, then propose a pull request. content is the complete new file.",
  access: "write",
  scope: "contents:write",
  input: z.object({ repo: repoArg, branch: branchArg, path: pathArg, content: z.string().max(400_000), message: z.string().trim().min(1).max(300) }),
  args: '{"repo": "owner/name", "branch": branch (not the default), "path": file path, "content": the complete file, "message": commit message}',
  fields: [
    { key: "repo", label: "Repository" },
    { key: "branch", label: "Branch" },
    { key: "path", label: "File" },
    { key: "message", label: "Commit message" },
    { key: "content", label: "New file content", multiline: true },
  ],
  describe: (i) => `Commit ${i.path} to the branch ${i.branch} in ${i.repo} (creating the branch if needed). The default branch isn't touched.`,
  async run(ctx, i) {
    const repo = await requireRepo(ctx, i.repo);
    notDefault(repo, i.branch);
    if (Buffer.byteLength(i.content, "utf8") > MAX_FILE_BYTES) throw new ConnectorError("bad_request", "That file is too large to commit from here (over 1 MB).");
    const createdBranch = await ensureBranch(ctx, repo, i.branch);
    const existing = await fileAt(ctx, repo.fullName, i.path, i.branch);
    if (existing && existing.text === i.content) return { summary: `${i.path} on ${i.branch} already has this content; nothing to commit.`, url: `https://github.com/${repo.fullName}/blob/${enc(i.branch)}/${enc(i.path)}` };
    const r = await send<{ commit: { sha: string; html_url: string } }>(ctx, "PUT", `/repos/${repo.fullName}/contents/${enc(i.path)}`, {
      message: i.message,
      content: Buffer.from(i.content, "utf8").toString("base64"),
      branch: i.branch,
      ...(existing ? { sha: existing.sha } : {}),
    });
    return {
      summary: `${existing ? "Updated" : "Added"} ${i.path} on ${i.branch} in ${repo.fullName}${createdBranch ? " (new branch)" : ""} — commit ${r.commit.sha.slice(0, 7)}.`,
      url: r.commit.html_url,
    };
  },
};

const createPull: ActionDef<{ repo: string; head: string; base?: string; title: string; body: string; draft?: boolean }> = {
  name: "github_create_pull_request",
  description: "Open a pull request in a shared GitHub repository from a branch into the default branch (or another base).",
  access: "write",
  scope: "pull_requests:write",
  input: z.object({ repo: repoArg, head: branchArg, base: branchArg.optional(), title: z.string().trim().min(1).max(250), body: z.string().max(20_000), draft: z.boolean().optional() }),
  args: '{"repo": "owner/name", "head": branch with the changes, "base"?: target branch (default branch), "title": text, "body": Markdown}',
  fields: [
    { key: "repo", label: "Repository" },
    { key: "head", label: "From branch" },
    { key: "base", label: "Into (blank = default branch)" },
    { key: "title", label: "Title" },
    { key: "body", label: "Description", multiline: true },
  ],
  describe: (i) => `Open a pull request in ${i.repo} from ${i.head} into ${i.base || "the default branch"}. Everyone with access to the repository will see it; nothing is merged.`,
  async run(ctx, i) {
    const repo = await requireRepo(ctx, i.repo);
    const base = i.base || repo.defaultBranch;
    if (base === i.head) throw new ConnectorError("bad_request", "The pull request's branch and target are the same.");
    const r = await send<{ number: number; html_url: string }>(ctx, "POST", `/repos/${repo.fullName}/pulls`, { title: i.title, body: i.body, head: i.head, base, draft: i.draft ?? false }).catch((err) => {
      if (err instanceof ConnectorError && err.status === 422) throw new ConnectorError("bad_request", `GitHub couldn't open it: the branch ${i.head} may have no changes against ${base}, or a pull request for it already exists.`, 422);
      throw err;
    });
    return { summary: `Opened pull request #${r.number} in ${repo.fullName} (${i.head} → ${base}).`, url: r.html_url };
  },
};

const createIssue: ActionDef<{ repo: string; title: string; body: string }> = {
  name: "github_create_issue",
  description: "Open an issue in one of the user's shared GitHub repositories.",
  access: "write",
  scope: "issues:write",
  input: z.object({ repo: repoArg, title: z.string().trim().min(1).max(250), body: z.string().max(20_000) }),
  args: '{"repo": "owner/name", "title": text, "body": Markdown}',
  fields: [
    { key: "repo", label: "Repository" },
    { key: "title", label: "Title" },
    { key: "body", label: "Description", multiline: true },
  ],
  describe: (i) => `Open a new issue in ${i.repo}. Everyone with access to the repository will see it.`,
  async run(ctx, i) {
    const repo = await requireRepo(ctx, i.repo);
    const r = await send<{ html_url: string; number: number }>(ctx, "POST", `/repos/${repo.fullName}/issues`, { title: i.title, body: i.body });
    return { summary: `Opened issue #${r.number} in ${repo.fullName}.`, url: r.html_url };
  },
};

// ---------------------------------------------------------------- the connector

/** GitHub answers a bad code or refresh token with 200 and an "error" field. */
export function parseGitHubToken(json: Record<string, unknown>, now = Date.now()): TokenSet {
  if (typeof json.error === "string") throw new ConnectorError("auth", "GitHub didn't accept the sign-in. Please connect again.");
  const access = json.access_token;
  if (typeof access !== "string" || !access) throw new ConnectorError("auth", "GitHub didn't return an access token.");
  const expiresIn = Number(json.expires_in);
  return {
    accessToken: access,
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : null,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : null,
    // GitHub Apps have permissions, not OAuth scopes; the app's permissions apply.
    scopes: null,
  };
}

async function revoke(tokens: TokenSet, client: OAuthClient, f: Fetch) {
  // Deletes the whole authorization (every token Orbis holds for this person). 204 when done.
  await call(`${GH}/applications/${encodeURIComponent(client.id)}/grant`, {
    method: "DELETE",
    headers: { ...H, authorization: `Basic ${Buffer.from(`${client.id}:${client.secret}`).toString("base64")}` },
    json: { access_token: tokens.accessToken },
    service: SERVICE,
    retries: 1,
  }, f);
}

export const github: Connector = {
  meta: connectorMeta("github")!,
  oauth: {
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    clientIdEnv: "GITHUB_APP_CLIENT_ID",
    clientSecretEnv: "GITHUB_APP_CLIENT_SECRET",
    // A GitHub App's permissions are set on the app (and the repositories chosen at install), not in the URL.
    urlScopes: "base",
    pkce: true,
    clientAuth: "body",
    tokenBody: "form",
    parseToken: parseGitHubToken,
    revoke,
  },
  async account(ctx) {
    const u = await callJson<{ login: string; name?: string | null }>(`${GH}/user`, { token: ctx.token, headers: H, service: SERVICE, signal: ctx.signal }, ctx.fetch);
    return { label: `@${u.login}`, extra: { login: u.login } };
  },
  async health(ctx) {
    await callJson(`${GH}/user`, { token: ctx.token, headers: H, service: SERVICE, signal: ctx.signal }, ctx.fetch);
  },
  tools: [listRepos as ToolDef, listFiles as ToolDef, readFile as ToolDef, listBranches as ToolDef, listPulls as ToolDef, searchIssues as ToolDef],
  actions: [commitFile as unknown as ActionDef, createPull as unknown as ActionDef, createBranch as unknown as ActionDef, createIssue as unknown as ActionDef],
  defaultSearch: "github_search_issues",
};

/** Where people choose (or change) the repositories Orbis's GitHub App may use. */
export function githubInstallUrl(env: Record<string, string | undefined> = process.env): string | null {
  const slug = env.GITHUB_APP_SLUG?.trim();
  return slug && /^[a-z0-9-]{1,100}$/i.test(slug) ? `https://github.com/apps/${slug}/installations/new` : null;
}
