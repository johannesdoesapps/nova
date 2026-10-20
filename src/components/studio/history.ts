"use client";
/**
 * Conversation history behind one interface:
 * - signed in → the server (Supabase, via /api/conversations)
 * - guest     → this browser's localStorage (the server keeps no guest history)
 */
import { jsonFetch } from "@/hooks/use-ndjson";
import type { ChatMode } from "@/lib/ai/modes";
import type { ProposedAction } from "@/lib/connectors/catalog";
import type { SearchSource } from "@/lib/search/types";
import type { ChatAttachment, ToolRecord } from "./chat-client";

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
  /** Why Auto chose the model, when Auto answered. */
  routing?: string;
  error?: string;
  /** The reply failed because the visitor isn't signed in. */
  needsSignIn?: boolean;
  simulated?: boolean;
  sources?: SearchSource[];
  tools?: ToolRecord[];
  notices?: string[];
  /** Changes in connected apps the reply proposed, for the user to confirm. */
  actions?: ProposedAction[];
  attachments?: string[];
  /** User messages, this session only: the attached files, so a regenerate can resend them. */
  files?: ChatAttachment[];
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
  /** Server store only: every chat whose title contains `q`, beyond the recent ones `list` returns. */
  search?(q: string): Promise<ConvSummary[]>;
  /** Server store only: hide a chat from the list without deleting it, or bring it back. */
  archive?(id: string, archived: boolean): Promise<void>;
  /** Server store only: the archived chats. */
  listArchived?(): Promise<ConvSummary[]>;
  /** Local store only: persist a guest conversation after each turn. */
  save?(conv: ConvSummary, messages: Msg[]): void;
  clear?(): void;
}

type ServerMessage = {
  id: string;
  role: string;
  content: string;
  model_id: string | null;
  /** Display name for model_id, added by the conversation API. */
  model_name?: string | null;
  usage_metadata: { sources?: SearchSource[]; attachments?: string[]; tools?: ToolRecord[]; actions?: ProposedAction[] } | null;
};

/** Signed-in history. `listUrl` selects ordinary chats or one agent's conversations. */
export function makeServerHistory(listUrl: string): HistoryStore {
  return { ...serverHistory, search: undefined, archive: undefined, listArchived: undefined, list: async () => (await jsonFetch<{ conversations: ConvSummary[] }>(listUrl)).conversations };
}

export const serverHistory: HistoryStore = {
  kind: "server",
  async list() {
    return (await jsonFetch<{ conversations: ConvSummary[] }>("/api/conversations")).conversations;
  },
  async search(q) {
    return (await jsonFetch<{ conversations: ConvSummary[] }>(`/api/conversations?q=${encodeURIComponent(q.slice(0, 200))}`)).conversations;
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
          modelName: m.model_name ?? m.model_id ?? undefined,
          simulated: m.model_id?.startsWith("demo:"),
          sources: m.usage_metadata?.sources,
          tools: m.usage_metadata?.tools,
          actions: m.usage_metadata?.actions,
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
  async archive(id, archived) {
    await jsonFetch(`/api/conversations/${id}`, { method: "PATCH", body: JSON.stringify({ archived }) });
  },
  async listArchived() {
    return (await jsonFetch<{ conversations: ConvSummary[] }>("/api/conversations?archived=1")).conversations;
  },
};

const MAX_CONVERSATIONS = 40;
const MAX_STORED_CHARS = 1_500_000;

type LocalConv = ConvSummary & { messages: Msg[] };

function readLocal(KEY: string): LocalConv[] {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? (v as LocalConv[]) : [];
  } catch {
    return [];
  }
}

function writeLocal(KEY: string, convs: LocalConv[]) {
  let list = convs.slice(0, MAX_CONVERSATIONS);
  // Drop the oldest conversations until the payload fits comfortably in storage.
  while (list.length > 1 && JSON.stringify(list).length > MAX_STORED_CHARS) list = list.slice(0, -1);
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage full or unavailable — history simply isn't kept */
  }
}

/** Guest history in this browser, under its own storage key. */
export function makeLocalHistory(KEY: string): HistoryStore {
  return {
    kind: "local",
    async list() {
      return readLocal(KEY)
        .map(({ id, title, mode, updated_at }) => ({ id, title, mode, updated_at }))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    },
    async load(id) {
      const c = readLocal(KEY).find((x) => x.id === id);
      if (!c) throw new Error("This conversation is no longer stored on this device.");
      const { messages, ...conversation } = c;
      return { conversation, messages };
    },
    async rename(id, title) {
      writeLocal(KEY, readLocal(KEY).map((c) => (c.id === id ? { ...c, title } : c)));
    },
    async remove(id) {
      writeLocal(KEY, readLocal(KEY).filter((c) => c.id !== id));
    },
    save(conv, messages) {
      const done = messages
        .filter((m) => m.status !== "streaming")
        .map((m) => ({ ...m, files: undefined, content: m.content.slice(0, 40_000) }));
      const rest = readLocal(KEY).filter((c) => c.id !== conv.id);
      writeLocal(KEY, [{ ...conv, messages: done }, ...rest]);
    },
    clear() {
      try {
        localStorage.removeItem(KEY);
      } catch {
        /* ignore */
      }
    },
  };
}

export const localHistory = makeLocalHistory("orbis:studio:chats");

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
