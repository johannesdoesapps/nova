import type { StepResult } from "./mission";

/**
 * Talking to the Orbis Desktop Agent on this computer (public/downloads/orbis-desktop-agent.mjs). It listens on
 * 127.0.0.1 only; the browser pairs with it once using the code the agent shows, and keeps the token in this
 * browser's storage. Every call is checked again by the agent (folders, no deleting, no overwriting).
 */

export const AGENT_URL = "http://127.0.0.1:47821";
const TOKEN_KEY = "orbis:jarvis:agent";

export type AgentPlatform = "darwin" | "win32" | "linux";

export interface AgentInfo {
  name: string;
  version: string;
  platform: AgentPlatform;
  folders: string[];
  tools: string[];
  halted: boolean;
}

/** absent: nothing answers; unpaired: the agent runs but this browser isn't paired; connected: ready. */
export type AgentState = { status: "checking" } | { status: "absent" } | { status: "unpaired"; platform?: AgentPlatform } | { status: "connected"; info: AgentInfo };

export class AgentError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function token(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function setToken(t: string | null) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* pairing then lasts only for this page */
  }
}

async function call<T>(path: string, init: { method?: "GET" | "POST"; body?: unknown; signal?: AbortSignal; auth?: boolean } = {}): Promise<T> {
  const t = token();
  let res: Response;
  try {
    res = await fetch(`${AGENT_URL}${path}`, {
      method: init.method ?? "GET",
      headers: { ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...(init.auth !== false && t ? { authorization: `Bearer ${t}` } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: init.signal,
      cache: "no-store",
    });
  } catch (err) {
    if (init.signal?.aborted) throw err;
    throw new AgentError("The Orbis Desktop Agent isn't reachable. Is it running on this computer?", 0);
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new AgentError(data.error ?? `The agent answered ${res.status}.`, res.status);
  return data;
}

/** Where the agent stands for this browser. */
export async function agentState(signal?: AbortSignal): Promise<AgentState> {
  let status: { paired: boolean; platform: AgentPlatform };
  try {
    status = await call("/status", { signal, auth: false });
  } catch (err) {
    if (signal?.aborted) throw err;
    return { status: "absent" };
  }
  if (!token()) return { status: "unpaired", platform: status.platform };
  try {
    return { status: "connected", info: await call<AgentInfo>("/info", { signal }) };
  } catch (err) {
    if (err instanceof AgentError && err.status === 401) setToken(null);
    return { status: "unpaired", platform: status.platform };
  }
}

export async function pairAgent(code: string): Promise<AgentInfo> {
  const r = await call<AgentInfo & { token: string }>("/pair", { method: "POST", body: { code: code.trim() }, auth: false });
  setToken(r.token);
  const { token: _t, ...info } = r;
  void _t;
  return info;
}

export async function unpairAgent(): Promise<void> {
  try {
    await call("/unpair", { method: "POST", body: {} });
  } finally {
    setToken(null);
  }
}

export const haltAgent = () => call<AgentInfo>("/halt", { method: "POST", body: {} });
export const resumeAgent = () => call<AgentInfo>("/resume", { method: "POST", body: {} });

/** Run one agent tool. Connection problems become a failed result (worth one retry for reads), never a success. */
export async function runAgentTool(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<StepResult> {
  try {
    const r = await call<StepResult>("/tool", { method: "POST", body: { tool, args }, signal });
    if (!r || typeof r.outcome !== "string" || typeof r.summary !== "string") return { outcome: "failure", summary: "The agent sent an unexpected answer.", verified: null };
    return r;
  } catch (err) {
    if (signal?.aborted) return { outcome: "cancelled", summary: "Stopped before the agent answered; it may already have acted.", verified: null };
    if (err instanceof AgentError && err.status === 401) {
      setToken(null);
      return { outcome: "permission_denied", summary: "The Desktop Agent no longer recognises this browser. Pair it again.", verified: null };
    }
    return { outcome: "failure", summary: err instanceof Error ? err.message : "The Desktop Agent didn't answer.", verified: null, retryable: true };
  }
}
