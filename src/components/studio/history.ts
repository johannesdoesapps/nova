"use client";
/**
 * Conversation history behind one interface:
 * - signed in → the server (Supabase, via /api/conversations)
 * - guest     → this browser's localStorage (the server keeps no guest history)
 */
import { jsonFetch } from "@/hooks/use-ndjson";
import type { ChatMode } from "@/lib/ai/modes";
import type { SearchSource } from "@/lib/search/types";

export interface ConvSummary {
  id: string;
  title: string;
  mode: string;
  updated_at: string;
}

export interface Msg {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "streaming" | "done" | "error";
  modelName?: string;
  error?: string;
  simulated?: boolean;
  sources?: SearchSource[];
  notices?: string[];
  attachments?: string[];
  cost?: number | null;
}

export interface LoadedConversation {
  conversation: ConvSummary;
  messages: Msg[];
}

export interface HistoryStore {
  kind: "server" | "local";
  list(): Promise<ConvSummary[]>;
  load(id: string): Promise<LoadedConversation>;
  rename(id: string, title: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** Local store only: persist a guest conversation after each turn. */
  save?(conv: ConvSummary, messages: Msg[]): void;
  clear?(): void;
}

type ServerMessage = {
  id: string;
  role: string;
  content: string;
  model_id: string | null;
  usage_metadata: { sources?: SearchSource[]; attachments?: string[] } | null;
};

export const serverHistory: HistoryStore = {
  kind: "server",
  async list() {
    return (await jsonFetch<{ conversations: ConvSummary[] }>("/api/conversations")).conversations;
  },
  async load(id) {
    const r = await jsonFetch<{ conversation: ConvSummary; messages: ServerMessage[] }>(`/api/conversations/${id}`);
    return {
      conversation: r.conversation,
      messages: r.messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({
          id: m.id,
          role: m.role as Msg["role"],
          content: m.content,
          status: "done",
          modelName: m.model_id ?? undefined,
          simulated: m.model_id?.startsWith("demo:"),
          sources: m.usage_metadata?.sources,
          attachments: m.usage_metadata?.attachments,
        })),
    };
  },
  async rename(id, title) {
    await jsonFetch(`/api/conversations/${id}`, { method: "PATCH", body: JSON.stringify({ title }) });
  },
  async remove(id) {
    await jsonFetch(`/api/conversations/${id}`, { method: "DELETE" });
  },
};

const KEY = "nova:studio:chats";
const MAX_CONVERSATIONS = 40;
const MAX_STORED_CHARS = 1_500_000;

type LocalConv = ConvSummary & { messages: Msg[] };

function readLocal(): LocalConv[] {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? (v as LocalConv[]) : [];
  } catch {
    return [];
  }
}

function writeLocal(convs: LocalConv[]) {
  let list = convs.slice(0, MAX_CONVERSATIONS);
  // Drop the oldest conversations until the payload fits comfortably in storage.
  while (list.length > 1 && JSON.stringify(list).length > MAX_STORED_CHARS) list = list.slice(0, -1);
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage full or unavailable — history simply isn't kept */
  }
}

export const localHistory: HistoryStore = {
  kind: "local",
  async list() {
    return readLocal()
      .map(({ id, title, mode, updated_at }) => ({ id, title, mode, updated_at }))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  },
  async load(id) {
    const c = readLocal().find((x) => x.id === id);
    if (!c) throw new Error("This conversation is no longer stored on this device.");
    const { messages, ...conversation } = c;
    return { conversation, messages };
  },
  async rename(id, title) {
    writeLocal(readLocal().map((c) => (c.id === id ? { ...c, title } : c)));
  },
  async remove(id) {
    writeLocal(readLocal().filter((c) => c.id !== id));
  },
  save(conv, messages) {
    const done = messages
      .filter((m) => m.status !== "streaming")
      .map((m) => ({ ...m, content: m.content.slice(0, 40_000) }));
    const rest = readLocal().filter((c) => c.id !== conv.id);
    writeLocal([{ ...conv, messages: done }, ...rest]);
  },
  clear() {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  },
};

export function titleFrom(message: string): string {
  const t = message.replace(/\s+/g, " ").trim();
  return t.length > 60 ? `${t.slice(0, 57)}…` : t || "New conversation";
}

export type DateGroup = { label: string; items: ConvSummary[] };

/** Group conversations into Today / Yesterday / Previous 7 days / Previous 30 days / Month Year. */
export function groupByDate(convs: ConvSummary[], now = new Date()): DateGroup[] {
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86_400_000;
  const groups = new Map<string, ConvSummary[]>();
  for (const c of convs) {
    const t = new Date(c.updated_at).getTime();
    let label: string;
    if (t >= startOfDay) label = "Today";
    else if (t >= startOfDay - day) label = "Yesterday";
    else if (t >= startOfDay - 7 * day) label = "Previous 7 days";
    else if (t >= startOfDay - 30 * day) label = "Previous 30 days";
    else label = new Date(t).toLocaleDateString(undefined, { month: "long", year: "numeric" });
    groups.set(label, [...(groups.get(label) ?? []), c]);
  }
  return [...groups].map(([label, items]) => ({ label, items }));
}

export const DEFAULT_MODE: ChatMode = "research";
