"use client";
import type { FileChange, ProjectFile, ProjectSummary } from "@/lib/code/projects";
import { isSiteTemplateId, type SiteTemplateId } from "@/lib/code/site-templates";
import { statusMessage } from "@/hooks/use-ndjson";

/** An API error with its code and details, so the page can offer the right next step (sign in, start, upgrade). */
export class CodeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly details: Record<string, unknown> | null,
  ) {
    super(message);
  }
  get upgrade(): boolean {
    return this.code === "quota_exceeded" && !!this.details && "upgradeTo" in this.details;
  }
  get stopped(): boolean {
    return this.details?.scope === "workspace_stopped";
  }
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  } catch {
    throw new CodeApiError("Can't reach Orbis. Check your connection and try again.", 0, null, null);
  }
  if (!res.ok) {
    let body: { error?: { code?: string; message?: string; details?: Record<string, unknown> } } = {};
    try {
      body = await res.json();
    } catch {}
    throw new CodeApiError(body.error?.message ?? statusMessage(res.status), res.status, body.error?.code ?? null, body.error?.details ?? null);
  }
  return (await res.json()) as T;
}

export const post = <T>(url: string, body: unknown) => api<T>(url, { method: "POST", body: JSON.stringify(body) });

type ErrorBody = { error?: { code?: string; message?: string; details?: Record<string, unknown> } };
const toError = (status: number, body: ErrorBody) => new CodeApiError(body.error?.message ?? statusMessage(status), status, body.error?.code ?? null, body.error?.details ?? null);

/**
 * POST that asks for a stream of JSON lines (see the agent's step route): each line but the last goes to
 * `onMessage`; the last is `done` (its `result` is returned) or `error` (thrown like api() does). A server that
 * answers with plain JSON instead is read as the result.
 */
export async function postStream<T>(url: string, body: unknown, onMessage: (m: { t: string } & Record<string, unknown>) => void): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" }, body: JSON.stringify(body) });
  } catch {
    throw new CodeApiError("Can't reach Orbis. Check your connection and try again.", 0, null, null);
  }
  if (!res.ok) throw toError(res.status, await res.json().catch(() => ({})));
  if (!res.body || !res.headers.get("content-type")?.includes("ndjson")) return (await res.json()) as T;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch {
      break;
    }
    if (chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let m: { t: string } & Record<string, unknown>;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.t === "done") return m.result as T;
      if (m.t === "error") throw toError(Number(m.status) || 500, (m.body ?? {}) as ErrorBody);
      onMessage(m);
    }
  }
  // The stream ended without a result: the step may still be running on the server.
  throw new CodeApiError("The connection dropped before this step finished. It may still be running: the page will catch up.", 0, null, null);
}

export interface Allowance {
  used: number;
  limit: number | null;
  left: number | null;
  blockMinutes: number;
  resetsAt: string;
}
export interface Session {
  sessionId: string;
  endsAt: string;
  previewUrl: string | null;
}
export interface ProjectData {
  project: ProjectSummary;
  files: ProjectFile[];
  session: Session | null;
}
export interface JobRead {
  output: string;
  offset: number;
  done: boolean;
  exitCode: number | null;
  sync: { changed: string[]; deleted: string[]; skipped: string[]; error?: string } | null;
}
export interface AiResult {
  ok: boolean;
  model: string;
  summary?: string;
  message?: string;
  changes: FileChange[];
}

/** Terminal output without colour codes and carriage-return redraws. */
export function plainText(s: string): string {
  return s
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*\u0007/g, "")
    .replace(/[^\n]*\r(?!\n)/g, "");
}

export function languageOf(path: string): "javascript" | "typescript" | "jsx" | "tsx" | "python" | "html" | "css" | "json" | "markdown" | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (["js", "mjs", "cjs"].includes(ext)) return "javascript";
  if (["ts", "mts", "cts"].includes(ext)) return "typescript";
  if (ext === "jsx") return "jsx";
  if (ext === "tsx") return "tsx";
  if (ext === "py" || ext === "pyi") return "python";
  if (["html", "htm", "svg", "vue", "svelte"].includes(ext)) return "html";
  if (["css", "scss", "less"].includes(ext)) return "css";
  if (["json", "jsonc"].includes(ext)) return "json";
  if (["md", "mdx", "markdown"].includes(ext)) return "markdown";
  return null;
}

const BUILD_KEY = (projectId: string) => `orbis.code.build.${projectId}`;

/** A "Build website" request handed from the start screen to the project's page, with the attachments uploaded for it. */
export interface BuildRequest {
  request: string;
  attachments: string[];
  /** The model picked on the start screen ("auto:coding" when none was picked). */
  modelId?: string;
  /** The website template the project started from (Discover → Build a website). */
  siteTemplate?: SiteTemplateId;
}

/** Hand a "Build website" request from the start screen to the project's page (kept out of the URL: it can be long). */
export function putBuildRequest(projectId: string, request: string, attachments: string[] = [], modelId?: string, siteTemplate?: SiteTemplateId): void {
  try {
    sessionStorage.setItem(BUILD_KEY(projectId), JSON.stringify({ request, attachments, modelId, siteTemplate } satisfies BuildRequest));
  } catch {
    /* the page then shows the box with nothing filled in */
  }
}

/** The request handed over for this project, once (it's removed when read). */
export function takeBuildRequest(projectId: string): BuildRequest | undefined {
  try {
    const v = sessionStorage.getItem(BUILD_KEY(projectId));
    sessionStorage.removeItem(BUILD_KEY(projectId));
    if (!v) return undefined;
    const parsed = JSON.parse(v) as Partial<BuildRequest>;
    const request = typeof parsed.request === "string" ? parsed.request.trim() : "";
    const attachments = Array.isArray(parsed.attachments) ? parsed.attachments.filter((a): a is string => typeof a === "string").slice(0, 20) : [];
    // The server checks the model again; this only keeps out anything that isn't a model id.
    const modelId = typeof parsed.modelId === "string" && /^[\w.:/-]{1,120}$/.test(parsed.modelId) ? parsed.modelId : undefined;
    const siteTemplate = isSiteTemplateId(parsed.siteTemplate) ? parsed.siteTemplate : undefined;
    return request ? { request, attachments, ...(modelId && { modelId }), ...(siteTemplate && { siteTemplate }) } : undefined;
  } catch {
    return undefined;
  }
}
