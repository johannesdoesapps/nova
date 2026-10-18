"use client";
/**
 * Client-side agent store. Signed-in users' custom agents live in Supabase
 * (via /api/agents); guests' custom agents live in this browser, the same way
 * guest chat history does. Built-ins always come from the server.
 */
import { useEffect, useSyncExternalStore } from "react";
import { jsonFetch } from "@/hooks/use-ndjson";
import type { AgentInput } from "@/lib/agents/schema";
import type { AgentConfig, CapabilityStatus } from "@/lib/agents/types";

export type AgentsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; builtins: AgentConfig[]; custom: AgentConfig[]; capabilities: CapabilityStatus; persistence: "server" | "local" };

const LOCAL_KEY = "nova:studio:agents";
export const agentChatsKey = (id: string) => `nova:studio:agent-chats:${id}`;

let state: AgentsState = { status: "loading" };
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();
const set = (s: AgentsState) => {
  state = s;
  listeners.forEach((l) => l());
};

function readLocal(): AgentConfig[] {
  try {
    const v = JSON.parse(localStorage.getItem(LOCAL_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? (v as AgentConfig[]) : [];
  } catch {
    return [];
  }
}
function writeLocal(agents: AgentConfig[]) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(agents));
  } catch {
    throw new Error("This browser couldn't save the agent (storage is full or blocked).");
  }
}

export function loadAgents(): Promise<void> {
  inflight ??= jsonFetch<{ builtins: AgentConfig[]; agents: AgentConfig[]; capabilities: CapabilityStatus; persistence: "server" | "local" }>("/api/agents")
    .then((r) =>
      set({
        status: "ready",
        builtins: r.builtins,
        custom: r.persistence === "local" ? readLocal() : r.agents,
        capabilities: r.capabilities,
        persistence: r.persistence,
      }),
    )
    .catch((e: Error) => set({ status: "error", message: e.message || "Agents couldn't be loaded." }))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function useAgents(): AgentsState {
  const s = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => state,
  );
  useEffect(() => {
    if (state.status !== "ready") void loadAgents();
  }, []);
  return s;
}

export function findAgent(s: AgentsState, id: string): AgentConfig | null {
  if (s.status !== "ready") return null;
  return s.builtins.find((a) => a.id === id) ?? s.custom.find((a) => a.id === id) ?? null;
}

export function toInput(a: AgentConfig): AgentInput {
  return {
    name: a.name,
    description: a.description,
    instructions: a.instructions,
    icon: a.icon,
    accent: a.accent,
    modelId: a.modelId,
    responseStyle: a.responseStyle,
    historyLimit: a.historyLimit,
    capabilities: a.capabilities,
    starters: a.starters,
  };
}

/** Create (no id) or update a custom agent. Resolves only once it is saved. */
export async function saveAgent(input: AgentInput, id?: string): Promise<AgentConfig> {
  if (state.status !== "ready") throw new Error("Agents are still loading.");
  const s = state;
  let saved: AgentConfig;
  if (s.persistence === "server") {
    const r = id
      ? await jsonFetch<{ agent: AgentConfig }>(`/api/agents/${id}`, { method: "PATCH", body: JSON.stringify(input) })
      : await jsonFetch<{ agent: AgentConfig }>("/api/agents", { method: "POST", body: JSON.stringify(input) });
    saved = r.agent;
  } else {
    const unavailable = input.capabilities.filter((c) => !s.capabilities[c].available);
    if (unavailable.length) throw new Error(s.capabilities[unavailable[0]!].reason ?? "That capability isn't available here.");
    const now = new Date().toISOString();
    const existing = readLocal();
    const prev = id ? existing.find((a) => a.id === id) : undefined;
    saved = {
      ...input,
      id: prev?.id ?? crypto.randomUUID(),
      kind: "custom",
      category: "Custom",
      modelPreference: null,
      temperature: null,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    };
    writeLocal([saved, ...existing.filter((a) => a.id !== saved.id)]);
  }
  const current = state.status === "ready" ? state : s;
  set({ ...current, custom: [saved, ...current.custom.filter((a) => a.id !== saved.id)] });
  return saved;
}

/** Delete a custom agent and its conversations. */
export async function deleteAgent(id: string): Promise<void> {
  if (state.status !== "ready") throw new Error("Agents are still loading.");
  if (state.persistence === "server") await jsonFetch(`/api/agents/${id}`, { method: "DELETE" });
  else {
    writeLocal(readLocal().filter((a) => a.id !== id));
    try {
      localStorage.removeItem(agentChatsKey(id));
    } catch {
      /* ignore */
    }
  }
  if (state.status === "ready") set({ ...state, custom: state.custom.filter((a) => a.id !== id) });
}

export type AgentStatus = { tone: "ok" | "warn" | "muted"; label: string; detail: string };

/** Honest readiness: a short label for cards, and the specific reason. */
export function agentStatus(
  agent: AgentConfig,
  caps: CapabilityStatus,
  models: { id: string; available: boolean }[] | null,
  demo: boolean,
): AgentStatus {
  const missing = agent.capabilities.find((c) => !caps[c].available);
  if (missing) {
    const name = missing === "web_search" ? "Web search" : missing === "code_execution" ? "Code execution" : "A tool";
    return { tone: "warn", label: "Setup needed", detail: `${name} needs setup` };
  }
  if (agent.modelId && models && !models.some((m) => m.id === agent.modelId && m.available))
    return { tone: "warn", label: "Setup needed", detail: "Preferred model unavailable; the best available model answers instead" };
  if (demo) return { tone: "muted", label: "Demo replies", detail: "Replies are simulated until an AI provider key is added" };
  return { tone: "ok", label: "Ready", detail: "Ready" };
}
