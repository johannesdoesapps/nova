import "server-only";
import { createHash } from "node:crypto";
import { ApiError } from "@/lib/http";
import type { SiteFile } from "./site";

/**
 * Publishing to Vercel with Orbis's own hosting account: each Code project becomes one Vercel project (named after
 * the project, with a key from its id, so its address never changes), every publish is a production deployment of
 * the project's saved files, and the address is the project's *.vercel.app domain. Sites are public (Vercel
 * Authentication is turned off on these projects) and each one is served from its own domain, never tryorbis.app.
 *
 * Set ORBIS_PUBLISH_VERCEL_TOKEN (a Vercel access token for the account or team that hosts the sites) and, for a
 * team, ORBIS_PUBLISH_VERCEL_TEAM_ID. The token stays on the server.
 *
 * Shared mode: some accounts can't create projects through the API (Vercel answers 403 "You don't have permission to
 * create the project" even for the owner). With ORBIS_PUBLISH_VERCEL_PROJECT set to an existing project (its name or
 * id), every site is a deployment in that one project instead, and its address is a *.vercel.app alias named like
 * a dedicated project would be (<name>-<key>.vercel.app). See src/lib/publish/sites.ts.
 */

export interface PublishConfig {
  token: string;
  teamId: string | null;
  api: string;
  /** The existing project every site is deployed into (shared mode), or null for one project per site. */
  sharedProject: string | null;
}

const DEFAULT_API = "https://api.vercel.com";
/** The API address can only point elsewhere for local testing (a loopback mock). */
const ALLOWED_API = /^(https:\/\/api\.vercel\.com|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?)$/;

export function publishConfig(): PublishConfig | null {
  const token = process.env.ORBIS_PUBLISH_VERCEL_TOKEN?.trim();
  if (!token) return null;
  const api = (process.env.ORBIS_PUBLISH_VERCEL_API?.trim() || DEFAULT_API).replace(/\/$/, "");
  if (!ALLOWED_API.test(api)) return null;
  const teamId = process.env.ORBIS_PUBLISH_VERCEL_TEAM_ID?.trim() || null;
  const shared = process.env.ORBIS_PUBLISH_VERCEL_PROJECT?.trim() || null;
  // A project name or id goes into a URL path, so only Vercel's own characters are accepted.
  if (shared && !/^(prj_[A-Za-z0-9]{1,64}|[a-z0-9][a-z0-9._-]{0,99})$/.test(shared)) return null;
  return { token, teamId, api, sharedProject: shared };
}

export type ReadyState = "QUEUED" | "INITIALIZING" | "BUILDING" | "READY" | "ERROR" | "CANCELED" | "BLOCKED";

export interface HostDeployment {
  id: string;
  url: string;
  readyState: ReadyState;
  projectId: string | null;
  alias: string[];
  aliasAssigned: boolean;
  createdAt: number | null;
  meta: Record<string, string>;
  errorMessage: string | null;
}

export interface HostProject {
  id: string;
  name: string;
}

type Fetch = typeof fetch;

interface RawDeployment {
  id?: string;
  uid?: string;
  url?: string;
  readyState?: string;
  state?: string;
  projectId?: string;
  alias?: string[];
  aliasAssigned?: boolean | number | null;
  createdAt?: number;
  created?: number;
  meta?: Record<string, unknown>;
  errorMessage?: string | null;
}

function toDeployment(d: RawDeployment): HostDeployment {
  const meta: Record<string, string> = {};
  for (const [k, v] of Object.entries(d.meta ?? {})) if (typeof v === "string") meta[k] = v;
  return {
    id: d.id ?? d.uid ?? "",
    url: d.url ?? "",
    readyState: (d.readyState ?? d.state ?? "QUEUED") as ReadyState,
    projectId: d.projectId ?? null,
    alias: d.alias ?? [],
    aliasAssigned: !!d.aliasAssigned,
    createdAt: d.createdAt ?? d.created ?? null,
    meta,
    errorMessage: d.errorMessage ?? null,
  };
}

const sha1 = (s: string) => createHash("sha1").update(s, "utf8").digest("hex");

export class VercelHost {
  constructor(
    private cfg: PublishConfig,
    private f: Fetch = fetch,
  ) {}

  private url(path: string, params: Record<string, string | number | undefined> = {}) {
    const q = new URLSearchParams();
    if (this.cfg.teamId) q.set("teamId", this.cfg.teamId);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
    const s = q.toString();
    return `${this.cfg.api}${path}${s ? `?${s}` : ""}`;
  }

  /** One call to Vercel, with a short retry on network errors and 5xx; failures become plain-English API errors. */
  private async call<T>(
    method: string,
    path: string,
    opts: { params?: Record<string, string | number | undefined>; json?: unknown; body?: BodyInit; headers?: Record<string, string>; allow404?: boolean; timeoutMs?: number; refused?: (why: string) => ApiError } = {},
  ): Promise<T | null> {
    let last: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      let res: Response;
      try {
        res = await this.f(this.url(path, opts.params), {
          method,
          headers: { Authorization: `Bearer ${this.cfg.token}`, ...(opts.json !== undefined ? { "Content-Type": "application/json" } : {}), ...opts.headers },
          body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body,
          signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
          cache: "no-store",
        });
      } catch (e) {
        last = e;
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        continue;
      }
      if (res.status === 404 && opts.allow404) return null;
      if (res.ok) return res.status === 204 ? null : ((await res.json().catch(() => null)) as T | null);
      const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
      const msg = (body?.error?.message ?? "").replace(/\s+/g, " ").slice(0, 300);
      if (res.status >= 500 && attempt < 2) {
        last = new Error(msg || `HTTP ${res.status}`);
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        // Vercel's own reason (e.g. an invalid token vs. a token without access to the team) — never the token itself.
        const code = (body?.error?.code ?? "").replace(/[^\w.-]/g, "").slice(0, 60);
        const why = [code, msg.split(this.cfg.token).join("[token]")].filter(Boolean).join(": ");
        // A call that can be refused for its own reasons (e.g. an address someone else owns) says so instead.
        if (res.status === 403 && opts.refused) throw opts.refused(why);
        console.warn(`[publish] Vercel refused the publishing token: HTTP ${res.status}${why ? ` (${why})` : ""}`);
        throw new ApiError(
          "not_configured",
          `The hosting account refused Orbis's publishing token${why ? ` (Vercel: ${why})` : ""}. Check that ORBIS_PUBLISH_VERCEL_TOKEN is a valid token with access to the ${this.cfg.teamId ? "team in ORBIS_PUBLISH_VERCEL_TEAM_ID" : "personal account"}, then replace it if needed.`,
        );
      }
      if (res.status === 409 && opts.refused) throw opts.refused([body?.error?.code, msg].filter(Boolean).join(": "));
      if (res.status === 429 || res.status === 402) throw new ApiError("provider_unavailable", `The hosting provider is limiting new publishes right now${msg ? ` (${msg})` : ""}. Try again in a few minutes.`);
      throw new ApiError("upstream_error", `The hosting provider couldn't ${method === "GET" ? "answer" : "do that"}${msg ? `: ${msg}` : ` (HTTP ${res.status})`}.`);
    }
    throw new ApiError("upstream_error", `Couldn't reach the hosting provider${last instanceof Error && last.message ? ` (${last.message.slice(0, 120)})` : ""}. Check the connection and try again.`);
  }

  /** The project for a site key (its name ends with -<key>), or null before the first publish. */
  async findProject(key: string): Promise<HostProject | null> {
    const r = await this.call<{ projects?: { id: string; name: string }[] }>("GET", "/v10/projects", { params: { search: key, limit: 20 } });
    const p = (r?.projects ?? []).find((x) => x.name.endsWith(`-${key}`));
    return p ? { id: p.id, name: p.name } : null;
  }

  /** A public project (no Vercel login in front of it). */
  async createProject(name: string, framework: string | null, buildCommand: string | null): Promise<HostProject> {
    const p = await this.call<{ id: string; name: string }>("POST", "/v11/projects", { json: { name, framework, ...(buildCommand ? { buildCommand } : {}), ssoProtection: null } });
    if (!p?.id) throw new ApiError("upstream_error", "The hosting provider didn't create the site's project.");
    return { id: p.id, name: p.name };
  }

  /** Keep the build settings in step with the project, and the site public. */
  async updateProject(id: string, framework: string | null, buildCommand: string | null): Promise<void> {
    await this.call("PATCH", `/v9/projects/${encodeURIComponent(id)}`, { json: { framework, buildCommand, ssoProtection: null } });
  }

  async deleteProject(id: string): Promise<void> {
    await this.call("DELETE", `/v9/projects/${encodeURIComponent(id)}`, { allow404: true });
  }

  /** Upload each file once (Vercel keeps files by their SHA-1), a few at a time. */
  async upload(files: SiteFile[]): Promise<{ file: string; sha: string; size: number }[]> {
    const out = files.map((f) => {
      const bytes = Buffer.from(f.content, "utf8");
      return { f, bytes, sha: sha1(f.content), size: bytes.length };
    });
    let i = 0;
    const worker = async () => {
      while (i < out.length) {
        const x = out[i++];
        await this.call("POST", "/v2/files", { body: new Uint8Array(x.bytes), headers: { "Content-Type": "application/octet-stream", "x-vercel-digest": x.sha, "Content-Length": String(x.size) }, timeoutMs: 30_000 });
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, out.length) }, worker));
    return out.map((x) => ({ file: x.f.path, sha: x.sha, size: x.size }));
  }

  /**
   * A deployment of exactly these files: to production in a site's own project, or (shared mode) a preview
   * deployment in the shared project, with every build setting given so nothing is inherited from another site.
   */
  async deploy(project: HostProject, files: { file: string; sha: string; size: number }[], meta: Record<string, string>, framework: string | null, buildCommand: string | null, opts: { shared?: boolean } = {}): Promise<HostDeployment> {
    const projectSettings = opts.shared ? { framework, buildCommand, installCommand: null, outputDirectory: null, devCommand: null } : { framework, ...(buildCommand ? { buildCommand } : {}) };
    const d = await this.call<RawDeployment>("POST", "/v13/deployments", {
      params: { skipAutoDetectionConfirmation: 1, forceNew: 1 },
      json: { name: project.name, project: project.id, ...(opts.shared ? {} : { target: "production" }), files, meta, projectSettings },
      timeoutMs: 30_000,
    });
    if (!d) throw new ApiError("upstream_error", "The hosting provider didn't start the deployment.");
    return toDeployment(d);
  }

  async deployment(id: string): Promise<HostDeployment | null> {
    const d = await this.call<RawDeployment>("GET", `/v13/deployments/${encodeURIComponent(id)}`, { allow404: true });
    return d ? toDeployment(d) : null;
  }

  /** The newest production deployment in a state (READY = what's live). */
  async latestProduction(projectId: string, state?: ReadyState): Promise<HostDeployment | null> {
    const r = await this.call<{ deployments?: RawDeployment[] }>("GET", "/v7/deployments", { params: { projectId, target: "production", limit: 1, state } });
    const d = r?.deployments?.[0];
    return d ? toDeployment(d) : null;
  }

  /** An existing project by name or id (shared mode), or null if there's none. */
  async getProject(idOrName: string): Promise<HostProject | null> {
    const p = await this.call<{ id: string; name: string }>("GET", `/v9/projects/${encodeURIComponent(idOrName)}`, { allow404: true });
    return p?.id ? { id: p.id, name: p.name } : null;
  }

  /** Ask for the project to stay public (no Vercel login). Best effort: the account may not allow changing it. */
  async keepPublic(id: string): Promise<boolean> {
    try {
      await this.call("PATCH", `/v9/projects/${encodeURIComponent(id)}`, { json: { ssoProtection: null }, refused: (why) => new ApiError("forbidden", why) });
      return true;
    } catch (e) {
      if (e instanceof ApiError) return false;
      throw e;
    }
  }

  /** A project's newest deployments carrying these meta values (Vercel filters by meta-<key>=<value>). */
  async deployments(projectId: string, meta: Record<string, string>, limit = 20): Promise<HostDeployment[]> {
    const params: Record<string, string | number> = { projectId, limit };
    for (const [k, v] of Object.entries(meta)) params[`meta-${k}`] = v;
    const r = await this.call<{ deployments?: RawDeployment[] }>("GET", "/v6/deployments", { params });
    // Filtered again here, in case the host ignores a filter.
    return (r?.deployments ?? []).map(toDeployment).filter((d) => Object.entries(meta).every(([k, v]) => d.meta[k] === v));
  }

  /** The deployment an alias (a hostname) points at, or null if the alias doesn't exist. */
  async aliasTarget(alias: string): Promise<{ deploymentId: string; projectId: string | null } | null> {
    const a = await this.call<{ deploymentId?: string | null; projectId?: string | null }>("GET", `/v4/aliases/${encodeURIComponent(alias)}`, { allow404: true });
    return a?.deploymentId ? { deploymentId: a.deploymentId, projectId: a.projectId ?? null } : null;
  }

  /** Point an alias at a deployment (creating the alias the first time). */
  async assignAlias(deploymentId: string, alias: string): Promise<void> {
    await this.call("POST", `/v2/deployments/${encodeURIComponent(deploymentId)}/aliases`, {
      json: { alias },
      refused: (why) => new ApiError("conflict", `The address ${alias} couldn't be given to the site${why ? ` (Vercel: ${why})` : ""}. It may belong to another Vercel account.`),
    });
  }

  async removeAlias(alias: string): Promise<void> {
    await this.call("DELETE", `/v2/aliases/${encodeURIComponent(alias)}`, { allow404: true });
  }

  async deleteDeployment(id: string): Promise<void> {
    await this.call("DELETE", `/v13/deployments/${encodeURIComponent(id)}`, { allow404: true });
  }
}

/** Whether the live address answers like a website, from outside (no Orbis cookies or credentials). */
export async function checkReachable(url: string, f: Fetch = fetch): Promise<{ ok: boolean; status: number | null; detail: string }> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await f(url, { redirect: "follow", signal: AbortSignal.timeout(12_000), cache: "no-store", headers: { "User-Agent": "OrbisPublishCheck/1.0" } });
      const type = res.headers.get("content-type") ?? "";
      await res.body?.cancel().catch(() => {});
      if (res.ok) return { ok: true, status: res.status, detail: type };
      // A brand-new domain can answer 404 for a moment while the alias settles.
      if (res.status !== 404 || attempt === 3) return { ok: false, status: res.status, detail: `answered HTTP ${res.status}` };
    } catch (e) {
      if (attempt === 3) return { ok: false, status: null, detail: e instanceof Error ? e.message.slice(0, 120) : "unreachable" };
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { ok: false, status: null, detail: "unreachable" };
}
