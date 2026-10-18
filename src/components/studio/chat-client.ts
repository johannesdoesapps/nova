"use client";
/**
 * Chat integration layer — the only place the studio talks to the AI backend.
 *
 * The browser never sees a provider key. It POSTs to `/api/chat`, which picks
 * a provider on the server (src/lib/ai: OpenAI, Hugging Face, or the labelled
 * demo provider when no key is set) and streams NDJSON events back.
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
  /** Guests only: prior turns, since the server keeps no guest history. */
  history?: { role: "user" | "assistant"; content: string }[];
  attachments?: ChatAttachment[];
}

export type ChatEvent =
  | { type: "meta"; conversationId: string | null; persisted: boolean; model: { id: string; displayName: string; provider: string } }
  | { type: "sources"; sources: SearchSource[] }
  | { type: "notice"; level?: string; message: string }
  | { type: "delta"; text: string }
  | { type: "done"; text: string; simulated: boolean; assistantMessageId: string | null; estimatedCost: number | null }
  | { type: "error"; message: string };

export function streamChat(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
  return postNdjson<ChatEvent>("/api/chat", req, signal);
}
