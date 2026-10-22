"use client";
import type { FileChange, ProjectFile, ProjectSummary } from "@/lib/code/projects";

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
    throw new CodeApiError(body.error?.message ?? `Request failed (${res.status}).`, res.status, body.error?.code ?? null, body.error?.details ?? null);
  }
  return (await res.json()) as T;
}

export const post = <T>(url: string, body: unknown) => api<T>(url, { method: "POST", body: JSON.stringify(body) });

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
}

/** Hand a "Build website" request from the start screen to the project's page (kept out of the URL: it can be long). */
export function putBuildRequest(projectId: string, request: string, attachments: string[] = [], modelId?: string): void {
  try {
    sessionStorage.setItem(BUILD_KEY(projectId), JSON.stringify({ request, attachments, modelId } satisfies BuildRequest));
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
    return request ? { request, attachments, ...(modelId && { modelId }) } : undefined;
  } catch {
    return undefined;
  }
}
