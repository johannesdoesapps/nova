import "server-only";
import { requireUser } from "@/lib/auth";
import { ApiError } from "@/lib/http";
import { limiter } from "@/lib/rate-limit";
import { githubAppConfig, githubIdentity, installationToken, userInstallation, type GitHubAppConfig, type GitHubIdentity, type Installation } from "./app";

export interface GitHubContext {
  cfg: GitHubAppConfig | null;
  identity: GitHubIdentity | null;
  installation: Installation | null;
}

/** The signed-in user's GitHub link and Orbis installation, looked up from their verified sign-in. */
export async function githubContext(): Promise<GitHubContext & { userId: string }> {
  const auth = await requireUser();
  if (!limiter("github", 60, 60_000).check(`u:${auth.user.id}`, 1).ok) {
    throw new ApiError("rate_limited", "Too many GitHub requests. Please wait a moment.");
  }
  const cfg = githubAppConfig();
  const { data } = await auth.supabase.auth.getUser();
  const identity = githubIdentity(data.user?.identities as never);
  const installation = cfg && identity ? await userInstallation(cfg, identity) : null;
  return { cfg, identity, installation, userId: auth.user.id };
}

/** An installation token for the user's own installation, or a clear reason there isn't one. */
export async function requireRepoAccess(): Promise<string> {
  const ctx = await githubContext();
  if (!ctx.cfg) throw new ApiError("not_configured", "GitHub isn't set up on this site yet.");
  if (!ctx.identity) throw new ApiError("forbidden", "Connect your GitHub account first.");
  if (!ctx.installation) throw new ApiError("forbidden", "Choose which repositories Orbis may read first.");
  return installationToken(ctx.cfg, ctx.installation.id);
}
