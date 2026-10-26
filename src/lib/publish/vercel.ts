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
 */

export interface PublishConfig {
  token: string;
  teamId: string | null;
  api: string;
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
  return { token, teamId, api };
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
  private async call<T>(method: string, path: string, opts: { params?: Record<string, string | number | undefined>; json?: unknown; body?: BodyInit; headers?: Record<string, string>; allow404?: boolean; timeoutMs?: number } = {}): Promise<T | null> {
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
        console.warn(`[publish] Vercel refused the publishing token: HTTP ${res.status}${why ? ` (${why})` : ""}`);
        throw new ApiError(
          "not_configured",
          `The hosting account refused Orbis's publishing token${why ? ` (Vercel: ${why})` : ""}. Check that ORBIS_PUBLISH_VERCEL_TOKEN is a valid token with access to the ${this.cfg.teamId ? "team in ORBIS_PUBLISH_VERCEL_TEAM_ID" : "personal account"}, then replace it if needed.`,
        );
      }
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

  /** A production deployment of exactly these files. */
  async deploy(project: HostProject, files: { file: string; sha: string; size: number }[], meta: Record<string, string>, framework: string | null, buildCommand: string | null): Promise<HostDeployment> {
    const d = await this.call<RawDeployment>("POST", "/v13/deployments", {
      params: { skipAutoDetectionConfirmation: 1, forceNew: 1 },
      json: { name: project.name, project: project.id, target: "production", files, meta, projectSettings: { framework, ...(buildCommand ? { buildCommand } : {}) } },
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
