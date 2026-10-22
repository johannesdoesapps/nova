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
import type { ReplyLength, ReplyStyle } from "@/lib/ai/reply-settings";
import type { ChatMode } from "@/lib/ai/modes";
import type { ProposedAction } from "@/lib/connectors/catalog";
import type { SearchSource } from "@/lib/search/types";

export interface ChatAttachment {
  name: string;
  content: string;
}

/**
 * Most a message's attachments may add to the request, as sent (JSON-escaped,
 * UTF-8). The chat endpoints cap the whole body, so this leaves room for the
 * message itself.
 */
export const MAX_ATTACHMENTS_BYTES = 150_000;

/** Bytes these attachment contents take up in the request body. */
export function attachmentBytes(files: Pick<ChatAttachment, "content">[]): number {
  const enc = new TextEncoder();
  return files.reduce((n, f) => n + enc.encode(JSON.stringify(f.content)).length, 0);
}

export interface ChatRequest {
  conversationId?: string | null;
  /** A new conversation starts in this project (signed in). */
  projectId?: string | null;
  message: string;
  mode: ChatMode;
  modelId?: string;
  useWeb?: boolean;
  allowFallback?: boolean;
  /** Guests only: prior turns, since the server keeps no guest history. */
  history?: { role: "user" | "assistant"; content: string }[];
  attachments?: ChatAttachment[];
  /** Signed in: this replaces the conversation's last reply (same question, new answer). */
  regenerate?: boolean;
  /** Signed in: this rewrites a saved question; it and everything after it are replaced. */
  editOf?: string;
  replyLength?: ReplyLength;
  replyStyle?: ReplyStyle;
}

type ModelRef = { id: string; displayName: string; provider: string };

export type ProjectUse = { id: string; name: string; instructions: boolean; notes: number };

export type ChatEvent =
  | { type: "meta"; conversationId: string | null; persisted: boolean; model: ModelRef; routing?: { auto: true; mode: string; reason: string } | null }
  | { type: "model"; model: ModelRef }
  | { type: "sources"; sources: SearchSource[] }
  | { type: "actions"; actions: ProposedAction[] }
  | { type: "notice"; level?: string; message: string }
  /** The chat's project, and what of its saved information this reply used. */
  | { type: "project"; project: ProjectUse }
  | { type: "tool"; tool: ToolRecord }
  | { type: "delta"; text: string }
  | { type: "done"; text: string; simulated: boolean; assistantMessageId: string | null; userMessageId?: string | null; estimatedCost: number | null; truncated?: boolean }
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
  /** The turn regenerates the last reply rather than asking something new. */
  regenerate?: boolean;
  /** The turn rewrites an earlier question (the general chat only). */
  editOf?: string;
  replyLength?: ReplyLength;
  replyStyle?: ReplyStyle;
  /** The general chat only: a new conversation starts in this project. */
  projectId?: string | null;
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
  /** Regenerates the last reply (the server replaces it instead of saving the question again). */
  regenerate?: boolean;
  /** Guests only: a custom agent stored in this browser. */
  agent?: unknown;
}

/** One turn with an agent; the server runs it through the shared agent service. */
export function streamAgentChat(req: AgentChatRequest, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
  return postNdjson<ChatEvent>("/api/agents/chat", { ...req, timeZone: browserTimeZone(), requestId: newRequestId() }, signal);
}

export function streamChat(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
  return postNdjson<ChatEvent>("/api/chat", { ...req, timeZone: browserTimeZone(), requestId: newRequestId() }, signal);
}

/** One id per submission: the server refuses to run or charge the same id twice. */
function newRequestId(): string | undefined {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : undefined;
}

/** Sent with each turn so the model knows the user's local time. */
function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}
