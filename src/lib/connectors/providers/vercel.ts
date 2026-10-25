import "server-only";
import { z } from "zod";
import { connectorMeta, type ConnectorItem } from "../catalog";
import { call, callJson, clip, ConnectorError, type Fetch } from "../http";
import type { ActionDef, Connector, OAuthClient, TokenSet, ToolContext, ToolDef } from "../types";

/**
 * Vercel, signed in with "Sign in with Vercel" (a Vercel App: OAuth 2.0 with PKCE, short-lived access tokens and a
 * refresh token). What the token may touch is decided on Vercel: the person installs Orbis's app on their personal
 * account or team and chooses its permissions (projects and deployments) there. Orbis lists projects, deployments,
 * their status and build logs, and redeploys only after the person confirms it on a card.
 */

const API = "https://api.vercel.com";
const SERVICE = "Vercel";

const TEAM_RE = /^team_[A-Za-z0-9]{1,64}$/;
const PROJECT_RE = /^[A-Za-z0-9._-]{1,100}$/;
const DEPLOYMENT_RE = /^(dpl_[A-Za-z0-9]{1,64}|[a-z0-9-]{1,200}\.vercel\.app)$/;

const q = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : "";
};

/** A refused call means Orbis's app isn't installed on that scope or lacks the permission: say how to fix it. */
function explain(err: unknown): never {
  if (err instanceof ConnectorError && err.kind === "permission")
    throw new ConnectorError("permission", "Vercel refused: Orbis isn't installed on that team, or wasn't given access to projects and deployments there. Allow it in Vercel, then try again.", err.status);
  throw err;
}

const get = <T>(ctx: ToolContext, path: string) => callJson<T>(`${API}${path}`, { token: ctx.token, service: SERVICE, signal: ctx.signal }, ctx.fetch).catch(explain);

export interface Scope {
  teamId: string | null;
  name: string;
}

/** The personal account plus up to 10 teams the person belongs to. */
export async function scopes(ctx: ToolContext): Promise<Scope[]> {
  const t = await get<{ teams?: { id: string; name?: string; slug: string }[] }>(ctx, "/v2/teams?limit=10").catch(() => ({ teams: [] }));
  return [{ teamId: null, name: "Personal account" }, ...(t.teams ?? []).map((x) => ({ teamId: x.id, name: x.name || x.slug }))];
}

interface Project {
  id: string;
  name: string;
  framework?: string | null;
  updatedAt?: number;
  targets?: { production?: { url?: string; readyState?: string; alias?: string[] } };
}

const when = (ms?: number) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "?");

const listProjects: ToolDef<{ query?: string; teamId?: string }> = {
  name: "vercel_list_projects",
  description: "List the user's Vercel projects (across their personal account and teams), optionally filtered by name, with the production URL and status.",
  access: "read",
  input: z.object({ query: z.string().trim().max(100).optional(), teamId: z.string().regex(TEAM_RE).optional() }),
  args: '{"query"?: project name words, "teamId"?: "team_…"}',
  async run(ctx, i) {
    const all = i.teamId ? [{ teamId: i.teamId, name: i.teamId }] : await scopes(ctx);
    const items: ConnectorItem[] = [];
    const refused: string[] = [];
    for (const s of all) {
      try {
        const r = await get<{ projects?: Project[] }>(ctx, `/v10/projects${q({ limit: 20, search: i.query?.split(/\s+/)[0], teamId: s.teamId ?? undefined })}`);
        for (const p of r.projects ?? []) {
          const prod = p.targets?.production;
          items.push({
            connectorId: "vercel",
            title: p.name,
            url: prod?.alias?.[0] ? `https://${prod.alias[0]}` : prod?.url ? `https://${prod.url}` : null,
            snippet: `${s.name}${p.framework ? ` · ${p.framework}` : ""} · production ${prod?.readyState?.toLowerCase() ?? "not deployed"} · updated ${when(p.updatedAt)}`,
            meta: s.teamId ?? "personal",
            read: { tool: "vercel_list_deployments", args: { project: p.id, ...(s.teamId ? { teamId: s.teamId } : {}) } },
          });
        }
      } catch (err) {
        // A team Orbis isn't installed on: skip it, and say so if nothing else worked.
        if (err instanceof ConnectorError && (err.kind === "permission" || err.kind === "not_found")) refused.push(s.name);
        else throw err;
      }
    }
    if (!items.length && refused.length === all.length) explain(new ConnectorError("permission", "refused", 403));
    return {
      summary: `${items.length} project${items.length === 1 ? "" : "s"}${refused.length ? ` (no access to ${refused.length} account${refused.length === 1 ? "" : "s"})` : ""}`,
      items: items.slice(0, 40),
    };
  },
};

interface Deployment {
  uid: string;
  name: string;
  url: string | null;
  state?: string;
  readyState?: string;
  created: number;
  target?: string | null;
  inspectorUrl?: string | null;
  meta?: { githubCommitRef?: string; githubCommitMessage?: string; githubCommitSha?: string };
}

const listDeployments: ToolDef<{ project: string; teamId?: string; target?: "production" | "preview"; state?: "READY" | "ERROR" | "BUILDING" | "QUEUED" | "CANCELED"; limit?: number }> = {
  name: "vercel_list_deployments",
  description: "List recent deployments of a Vercel project: id, status, target, branch, commit and URL.",
  access: "read",
  input: z.object({
    project: z.string().regex(PROJECT_RE, "Use the project's id or name."),
    teamId: z.string().regex(TEAM_RE).optional(),
    target: z.enum(["production", "preview"]).optional(),
    state: z.enum(["READY", "ERROR", "BUILDING", "QUEUED", "CANCELED"]).optional(),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  args: '{"project": project id or name, "teamId"?: "team_…", "target"?: "production" | "preview", "state"?: "READY" | "ERROR" | "BUILDING" | "QUEUED" | "CANCELED", "limit"?: 1-20}',
  async run(ctx, i) {
    const p = await get<{ id: string; name: string }>(ctx, `/v9/projects/${encodeURIComponent(i.project)}${q({ teamId: i.teamId })}`);
    const r = await get<{ deployments?: Deployment[] }>(ctx, `/v6/deployments${q({ projectId: p.id, teamId: i.teamId, target: i.target, state: i.state, limit: i.limit ?? 10 })}`);
    const deps = r.deployments ?? [];
    return {
      summary: `${deps.length} deployment${deps.length === 1 ? "" : "s"} of ${p.name}`,
      items: deps.map((d) => ({
        connectorId: "vercel",
        title: `${p.name} · ${(d.state ?? d.readyState ?? "?").toLowerCase()} · ${d.target ?? "preview"} · ${when(d.created)}`,
        url: d.url ? `https://${d.url}` : (d.inspectorUrl ?? null),
        snippet: `${d.uid}${d.meta?.githubCommitRef ? ` · ${d.meta.githubCommitRef}` : ""}${d.meta?.githubCommitSha ? ` @ ${d.meta.githubCommitSha.slice(0, 7)}` : ""}${d.meta?.githubCommitMessage ? ` · ${clip(d.meta.githubCommitMessage.split("\n")[0]!, 80)}` : ""}`,
        read: { tool: "vercel_get_deployment", args: { deployment: d.uid, ...(i.teamId ? { teamId: i.teamId } : {}) } },
      })),
    };
  },
};

interface DeploymentDetail {
  id: string;
  name: string;
  url: string;
  readyState: string;
  target?: string | null;
  alias?: string[];
  errorMessage?: string | null;
  errorCode?: string | null;
  createdAt: number;
  ready?: number;
  inspectorUrl?: string | null;
  projectId?: string;
  meta?: { githubCommitRef?: string; githubCommitMessage?: string; githubCommitSha?: string };
}

const getDeployment: ToolDef<{ deployment: string; teamId?: string }> = {
  name: "vercel_get_deployment",
  description: "Get one Vercel deployment's status, URL and aliases, any error, and the end of its build log.",
  access: "read",
  input: z.object({ deployment: z.string().regex(DEPLOYMENT_RE, "Use a deployment id (dpl_…) or its .vercel.app address."), teamId: z.string().regex(TEAM_RE).optional() }),
  args: '{"deployment": "dpl_…" or "name-hash.vercel.app", "teamId"?: "team_…"}',
  async run(ctx, i) {
    const d = await get<DeploymentDetail>(ctx, `/v13/deployments/${encodeURIComponent(i.deployment)}${q({ teamId: i.teamId })}`);
    const log = await buildLog(ctx, d.id, i.teamId).catch(() => null);
    const lines = [
      `Deployment ${d.id} of ${d.name}`,
      `Status: ${d.readyState}${d.errorMessage ? ` — ${d.errorMessage}` : ""}`,
      `Target: ${d.target ?? "preview"}`,
      `URL: https://${d.url}`,
      d.alias?.length ? `Aliases: ${d.alias.map((a) => `https://${a}`).join(", ")}` : "",
      d.meta?.githubCommitRef ? `Branch: ${d.meta.githubCommitRef}${d.meta.githubCommitSha ? ` @ ${d.meta.githubCommitSha.slice(0, 7)}` : ""}` : "",
      `Created: ${when(d.createdAt)}${d.ready ? ` · ready ${when(d.ready)}` : ""}`,
      log ? `\nBuild log (last lines):\n${log}` : "",
    ].filter(Boolean);
    return {
      summary: `${d.name}: ${d.readyState.toLowerCase()}`,
      items: [{ connectorId: "vercel", title: `${d.name} · ${d.readyState.toLowerCase()} · ${d.target ?? "preview"}`, url: d.inspectorUrl ?? `https://${d.url}`, snippet: `${d.id} · https://${d.url}${d.errorMessage ? ` · ${clip(d.errorMessage, 120)}` : ""}` }],
      text: lines.join("\n"),
    };
  },
};

/** The last ~150 lines of a deployment's build output. */
export async function buildLog(ctx: ToolContext, id: string, teamId?: string): Promise<string> {
  const events = await get<{ type?: string; text?: string; payload?: { text?: string } }[]>(ctx, `/v3/deployments/${encodeURIComponent(id)}/events${q({ builds: 1, limit: 400, teamId })}`);
  const lines = (Array.isArray(events) ? events : [])
    .filter((e) => e.type === "stdout" || e.type === "stderr" || e.type === "command" || !e.type)
    .map((e) => (e.payload?.text ?? e.text ?? "").replace(/\x1b\[[0-9;]*m/g, "").trimEnd())
    .filter(Boolean);
  return clip(lines.slice(-150).join("\n"), 15_000);
}

const buildLogs: ToolDef<{ deployment: string; teamId?: string }> = {
  name: "vercel_build_logs",
  description: "Read the build log of a Vercel deployment (the last 150 lines), for example to find why a build failed.",
  access: "read",
  input: z.object({ deployment: z.string().regex(DEPLOYMENT_RE, "Use a deployment id (dpl_…) or its .vercel.app address."), teamId: z.string().regex(TEAM_RE).optional() }),
  args: '{"deployment": "dpl_…", "teamId"?: "team_…"}',
  async run(ctx, i) {
    const d = await get<DeploymentDetail>(ctx, `/v13/deployments/${encodeURIComponent(i.deployment)}${q({ teamId: i.teamId })}`);
    const log = await buildLog(ctx, d.id, i.teamId);
    return {
      summary: `Build log of ${d.name} (${d.readyState.toLowerCase()})`,
      items: [{ connectorId: "vercel", title: `Build log · ${d.name} · ${d.readyState.toLowerCase()}`, url: d.inspectorUrl ?? `https://${d.url}`, snippet: clip(log.split("\n").slice(-3).join(" · "), 240) }],
      text: log || "The build log is empty.",
    };
  },
};

const redeploy: ActionDef<{ deployment: string; teamId?: string; target: "production" | "preview" }> = {
  name: "vercel_redeploy",
  description: "Redeploy an existing Vercel deployment (same code and settings) to production or as a new preview.",
  access: "write",
  scope: "write:deployment",
  input: z.object({ deployment: z.string().regex(DEPLOYMENT_RE, "Use a deployment id (dpl_…)."), teamId: z.string().regex(TEAM_RE).optional(), target: z.enum(["production", "preview"]) }),
  args: '{"deployment": "dpl_…" to rebuild, "teamId"?: "team_…", "target": "production" | "preview"}',
  fields: [
    { key: "deployment", label: "Deployment to rebuild" },
    { key: "target", label: "Target (production or preview)" },
  ],
  describe: (i) =>
    i.target === "production"
      ? `Rebuild ${i.deployment} and make it the live production deployment. Visitors will see it once it's ready.`
      : `Rebuild ${i.deployment} as a new preview deployment. Production isn't changed.`,
  async run(ctx, i) {
    const d = await get<DeploymentDetail>(ctx, `/v13/deployments/${encodeURIComponent(i.deployment)}${q({ teamId: i.teamId })}`);
    const r = await callJson<{ id: string; url: string; readyState?: string; inspectorUrl?: string | null }>(
      `${API}/v13/deployments${q({ teamId: i.teamId, forceNew: 1 })}`,
      { method: "POST", token: ctx.token, json: { name: d.name, deploymentId: d.id, ...(i.target === "production" ? { target: "production" } : {}) }, service: SERVICE, signal: ctx.signal, retries: 0 },
      ctx.fetch,
    ).catch(explain);
    return { summary: `Started a ${i.target} redeploy of ${d.name} (${r.id}). It's building now; ask Orbis for its status.`, url: r.inspectorUrl ?? `https://${r.url}` };
  },
};

async function revokeToken(tokens: TokenSet, client: OAuthClient, f: Fetch) {
  // RFC 7009: revoking the refresh token ends the grant; the access token expires within the hour anyway.
  for (const token of [tokens.refreshToken, tokens.accessToken].filter((t): t is string => !!t)) {
    await call(`${API}/login/oauth/token/revoke`, { method: "POST", form: { token, client_id: client.id, client_secret: client.secret }, service: SERVICE, retries: 1 }, f);
  }
}

export const vercel: Connector = {
  meta: connectorMeta("vercel")!,
  oauth: {
    authorizeUrl: "https://vercel.com/oauth/authorize",
    tokenUrl: "https://api.vercel.com/login/oauth/token",
    clientIdEnv: "ORBIS_VERCEL_CLIENT_ID",
    clientSecretEnv: "ORBIS_VERCEL_CLIENT_SECRET",
    // Identity plus a refresh token; what Orbis may do on Vercel is the app's installed permissions, not URL scopes.
    baseScopes: ["openid", "email", "profile", "offline_access"],
    urlScopes: "base",
    pkce: true,
    clientAuth: "body",
    tokenBody: "form",
    revoke: revokeToken,
  },
  async account(ctx) {
    const u = await callJson<{ preferred_username?: string; email?: string; name?: string }>(`${API}/login/oauth/userinfo`, { method: "POST", token: ctx.token, service: SERVICE, signal: ctx.signal }, ctx.fetch);
    return { label: u.preferred_username ? `@${u.preferred_username}` : (u.email ?? u.name ?? "Vercel account") };
  },
  async health(ctx) {
    await callJson(`${API}/login/oauth/userinfo`, { method: "POST", token: ctx.token, service: SERVICE, signal: ctx.signal }, ctx.fetch);
  },
  tools: [listProjects as ToolDef, listDeployments as ToolDef, getDeployment as ToolDef, buildLogs as ToolDef],
  actions: [redeploy as unknown as ActionDef],
  defaultSearch: "vercel_list_projects",
};
