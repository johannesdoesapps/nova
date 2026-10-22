import "server-only";
import { createHash, createSign } from "node:crypto";
import { ApiError } from "@/lib/http";

/**
 * Orbis's GitHub App: users install it on the repositories they choose, and
 * Orbis reads files from those repositories with short-lived installation
 * tokens ("Contents: read"). The one exception is Code's "Push to GitHub",
 * which the user starts and confirms: it creates a new branch with one
 * commit (see push.ts) and only works if the app is also given
 * "Contents: Read and write". Existing branches are never written to.
 *
 * Configuration (Vercel, Sensitive): GITHUB_APP_ID, GITHUB_APP_SLUG and
 * GITHUB_APP_PRIVATE_KEY (the .pem, with real or "\n" line breaks).
 * See docs/GITHUB.md.
 *
 * Whose installation is it? Not something the browser says: on every request
 * the installation is looked up from the GitHub account linked to the user's
 * Orbis sign-in (verified by Supabase Auth) and its owner's id must match.
 */

const API = "https://api.github.com";

export interface GitHubAppConfig {
  appId: string;
  slug: string;
  privateKey: string;
}

export function githubAppConfig(env: Record<string, string | undefined> = process.env): GitHubAppConfig | null {
  const appId = env.GITHUB_APP_ID?.trim();
  const slug = env.GITHUB_APP_SLUG?.trim();
  const key = env.GITHUB_APP_PRIVATE_KEY?.trim().replace(/\\n/g, "\n");
  if (!appId || !slug || !key || !/^[a-z0-9-]{1,100}$/i.test(slug)) return null;
  return { appId, slug, privateKey: key };
}

/** Where users choose the repositories Orbis may read. */
export function installUrl(cfg: GitHubAppConfig): string {
  return `https://github.com/apps/${cfg.slug}/installations/new`;
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

/** A JWT that authenticates as the app itself (valid for 9 minutes; GitHub allows 10). */
export function appJwt(cfg: GitHubAppConfig, now = Date.now()): string {
  const iat = Math.floor(now / 1000) - 60;
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat, exp: iat + 540, iss: cfg.appId }));
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(cfg.privateKey);
  return `${head}.${body}.${b64url(sig)}`;
}

export type Fetch = typeof fetch;

async function gh<T>(path: string, token: string, init: RequestInit = {}, f: Fetch = fetch): Promise<{ status: number; data: T | null }> {
  const res = await f(`${API}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "orbis-ai",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  if (res.status === 404) return { status: 404, data: null };
  if (!res.ok) {
    // GitHub's error text isn't shown to users; it may name private repositories.
    throw new ApiError("upstream_error", `GitHub didn't respond as expected (${res.status}). Please try again.`);
  }
  return { status: res.status, data: (await res.json()) as T };
}

/** The user's GitHub account, as verified by Supabase Auth when they signed in with or linked GitHub. */
export interface GitHubIdentity {
  id: number;
  login: string;
}

type Identity = { provider: string; id?: string; identity_data?: Record<string, unknown> | null };

export function githubIdentity(identities: Identity[] | null | undefined): GitHubIdentity | null {
  const i = identities?.find((x) => x.provider === "github");
  if (!i) return null;
  const d = i.identity_data ?? {};
  const id = Number(d.provider_id ?? d.sub ?? i.id);
  const login = String(d.user_name ?? d.preferred_username ?? "");
  return Number.isSafeInteger(id) && id > 0 && /^[a-z0-9-]{1,39}$/i.test(login) ? { id, login } : null;
}

export interface Installation {
  id: number;
  accountId: number;
  accountLogin: string;
  /** "all" or "selected" repositories. */
  repositorySelection: string;
}

/**
 * The app's installation on the user's own GitHub account, or null. Checked by
 * account id, so a renamed or reused login can't pick up someone else's.
 */
export async function userInstallation(cfg: GitHubAppConfig, who: GitHubIdentity, f: Fetch = fetch): Promise<Installation | null> {
  const r = await gh<{ id: number; account: { id: number; login: string } | null; repository_selection: string }>(
    `/users/${encodeURIComponent(who.login)}/installation`,
    appJwt(cfg),
    {},
    f,
  );
  if (!r.data || !r.data.account || r.data.account.id !== who.id) return null;
  return { id: r.data.id, accountId: r.data.account.id, accountLogin: r.data.account.login, repositorySelection: r.data.repository_selection };
}

const tokens = new Map<number, { token: string; expires: number }>();

/** A short-lived token for one installation (cached until 5 minutes before it expires). */
export async function installationToken(cfg: GitHubAppConfig, installationId: number, f: Fetch = fetch, now = Date.now()): Promise<string> {
  const hit = tokens.get(installationId);
  if (hit && hit.expires - 5 * 60_000 > now) return hit.token;
  const r = await gh<{ token: string; expires_at: string }>(`/app/installations/${installationId}/access_tokens`, appJwt(cfg, now), { method: "POST" }, f);
  if (!r.data) throw new ApiError("not_found", "Orbis isn't installed on that GitHub account any more.");
  tokens.set(installationId, { token: r.data.token, expires: Date.parse(r.data.expires_at) || now + 30 * 60_000 });
  return r.data.token;
}

/** For tests: forget cached installation tokens. */
export function clearTokenCache() {
  tokens.clear();
}

export interface Repo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
}

export async function listRepos(token: string, f: Fetch = fetch): Promise<Repo[]> {
  const out: Repo[] = [];
  for (let page = 1; page <= 5; page++) {
    const r = await gh<{ repositories: { full_name: string; private: boolean; default_branch: string }[] }>(`/installation/repositories?per_page=100&page=${page}`, token, {}, f);
    const list = r.data?.repositories ?? [];
    out.push(...list.map((x) => ({ fullName: x.full_name, private: x.private, defaultBranch: x.default_branch })));
    if (list.length < 100) break;
  }
  return out.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

/** "owner/name", as GitHub allows it. */
export const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

export interface TreeFile {
  path: string;
  size: number;
  /** Git's blob id for the file's content (see gitBlobSha). */
  sha: string;
}

/** Git's blob id for some text: sha1 of "blob <bytes>\0<content>", the same id GitHub lists in a tree. */
export function gitBlobSha(content: string): string {
  const buf = Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

/** Files we can show as text (by extension or well-known name), skipping vendored and build folders. */
const TEXT_EXT = /\.(md|mdx|txt|rst|json|jsonc|ya?ml|toml|ini|cfg|conf|env\.example|csv|tsv|xml|html?|css|scss|sass|less|js|mjs|cjs|jsx|ts|mts|cts|tsx|vue|svelte|astro|py|pyi|rb|go|rs|java|kt|kts|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|fish|ps1|sql|graphql|gql|proto|lua|r|dart|ex|exs|erl|hs|scala|clj|tf|hcl|dockerfile|gradle|lock)$/i;
const TEXT_NAMES = /(^|\/)(Dockerfile|Makefile|Procfile|Gemfile|Rakefile|LICENSE|README|CHANGELOG|\.gitignore|\.editorconfig|\.nvmrc|\.prettierrc|\.eslintrc)$/;
const SKIP_DIRS = /(^|\/)(node_modules|\.git|dist|build|out|\.next|vendor|target|coverage|__pycache__|\.venv|venv)\//;

export const MAX_FILE_BYTES = 100_000;

export async function repoTree(token: string, repo: string, f: Fetch = fetch): Promise<{ branch: string; files: TreeFile[]; truncated: boolean }> {
  const meta = await gh<{ default_branch: string }>(`/repos/${repo}`, token, {}, f);
  if (!meta.data) throw new ApiError("not_found", "That repository isn't available to Orbis. Check which repositories you gave Orbis access to on GitHub.");
  const branch = meta.data.default_branch;
  const t = await gh<{ tree: { path: string; type: string; size?: number; sha: string }[]; truncated: boolean }>(`/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, token, {}, f);
  const files = (t.data?.tree ?? [])
    .filter((x) => x.type === "blob" && (x.size ?? 0) <= MAX_FILE_BYTES && !SKIP_DIRS.test(x.path) && (TEXT_EXT.test(x.path) || TEXT_NAMES.test(x.path)))
    .map((x) => ({ path: x.path, size: x.size ?? 0, sha: x.sha }))
    .slice(0, 5000);
  return { branch, files, truncated: Boolean(t.data?.truncated) || files.length === 5000 };
}

/** A safe repository-relative path (no traversal, no absolute paths). */
export function safePath(p: string): boolean {
  return p.length > 0 && p.length <= 500 && !p.startsWith("/") && !p.split("/").some((s) => s === "" || s === "." || s === "..") && !/[\0\\]/.test(p);
}

export async function repoFile(token: string, repo: string, path: string, f: Fetch = fetch): Promise<{ path: string; content: string; size: number }> {
  const r = await gh<{ type: string; size: number; encoding: string; content: string }>(`/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`, token, {}, f);
  if (!r.data || r.data.type !== "file") throw new ApiError("not_found", "That file isn't in the repository.");
  if (r.data.size > MAX_FILE_BYTES) throw new ApiError("bad_request", "That file is too large to add (over 100 KB).");
  const buf = Buffer.from(r.data.content ?? "", r.data.encoding === "base64" ? "base64" : "utf8");
  if (buf.includes(0)) throw new ApiError("bad_request", "That file isn't text, so it can't be added to a message.");
  return { path, content: buf.toString("utf8"), size: buf.length };
}
