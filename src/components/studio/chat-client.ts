"use client";
/**
 * Chat integration layer — the only place the studio talks to the AI backend.
 *
 * The browser never sees a provider key. It POSTs to `/api/chat`, which picks
 * a provider on the server (src/lib/ai: OpenAI, Hugging Face, or the labelled
 * demo provider when no key is set) and streams NDJSON events back.
 *
 * Agents use the same event stream via `POST /api/agents/chat`.
 *
 * To connect another AI API, implement `AIProvider` in src/lib/ai/providers
 * and register it in src/lib/ai/index.ts; this file and the UI stay unchanged.
 */
import { postNdjson } from "@/hooks/use-ndjson";
import type { ChatMode } from "@/lib/ai/modes";
import type { SearchSource } from "@/lib/search/types";

export interface ChatAttachment {
  name: string;
  content: string;
}

export interface ChatRequest {
  conversationId?: string | null;
  message: string;
  mode: ChatMode;
  modelId?: string;
  useWeb?: boolean;
  allowFallback?: boolean;
  /** Guests only: prior turns, since the server keeps no guest history. */
  history?: { role: "user" | "assistant"; content: string }[];
  attachments?: ChatAttachment[];
}

type ModelRef = { id: string; displayName: string; provider: string };

export type ChatEvent =
  | { type: "meta"; conversationId: string | null; persisted: boolean; model: ModelRef; routing?: { auto: true; mode: string; reason: string } | null }
  | { type: "model"; model: ModelRef }
  | { type: "sources"; sources: SearchSource[] }
  | { type: "notice"; level?: string; message: string }
  | { type: "tool"; tool: ToolRecord }
  | { type: "delta"; text: string }
  | { type: "done"; text: string; simulated: boolean; assistantMessageId: string | null; estimatedCost: number | null }
  | { type: "error"; message: string };

/** A tool the server ran for this turn (e.g. web search, data analysis). */
export interface ToolRecord {
  name: string;
  label: string;
  status: "ok" | "error";
  detail?: string;
}

/** One turn as the chat hook describes it; each surface maps it to its endpoint. */
export interface TurnRequest {
  conversationId: string | null;
  message: string;
  mode: ChatMode;
  modelId?: string;
  useWeb: boolean;
  allowFallback: boolean;
  history?: { role: "user" | "assistant"; content: string }[];
  attachments: ChatAttachment[];
}
export type ChatTransport = (req: TurnRequest, signal: AbortSignal) => AsyncGenerator<ChatEvent>;

export interface AgentChatRequest {
  agentId: string;
  conversationId?: string | null;
  message: string;
  modelId?: string;
  useWeb?: boolean;
  allowFallback?: boolean;
  history?: { role: "user" | "assistant"; content: string }[];
  attachments?: ChatAttachment[];
  /** Guests only: a custom agent stored in this browser. */
  agent?: unknown;
}

/** One turn with an agent; the server runs it through the shared agent service. */
export function streamAgentChat(req: AgentChatRequest, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
  return postNdjson<ChatEvent>("/api/agents/chat", req, signal);
}

export function streamChat(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
  return postNdjson<ChatEvent>("/api/chat", req, signal);
}
