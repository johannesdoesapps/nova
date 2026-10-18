"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMode } from "@/lib/ai/modes";
import { CHAT_MODES } from "@/lib/ai/modes";
import { streamChat, type ChatAttachment } from "./chat-client";
import { titleFrom, type HistoryStore, type Msg } from "./history";

export type LoadState = { status: "idle" } | { status: "loading" } | { status: "error"; message: string };

export function useStudioChat({
  store,
  defaultMode,
  modelId,
  onHistoryChanged,
}: {
  store: HistoryStore;
  defaultMode: ChatMode;
  modelId: string | undefined;
  onHistoryChanged: () => void;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [mode, setMode] = useState<ChatMode>(defaultMode);
  const [useWeb, setUseWeb] = useState(false);
  const [load, setLoad] = useState<LoadState>({ status: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  const dirty = useRef(false);
  // Mirrors conversationId synchronously, so our own URL updates aren't mistaken for navigation.
  const idRef = useRef<string | null>(null);
  const setId = useCallback((id: string | null) => {
    idRef.current = id;
    setConversationId(id);
  }, []);

  const busy = messages.some((m) => m.status === "streaming");

  // Follow the default mode until the user starts a conversation.
  useEffect(() => {
    if (!conversationId && messages.length === 0) setMode(defaultMode);
  }, [defaultMode, conversationId, messages.length]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setId(null);
    setTitle(null);
    setLoad({ status: "idle" });
  }, [setId]);

  // Open the conversation named in ?c=, or start fresh on ?new.
  const cParam = params.get("c");
  const newParam = params.has("new");
  useEffect(() => {
    if (newParam) {
      reset();
      router.replace("/chat", { scroll: false });
      return;
    }
    if (!cParam) {
      if (idRef.current) reset();
      return;
    }
    if (cParam === idRef.current) return;
    let alive = true;
    abortRef.current?.abort();
    setLoad({ status: "loading" });
    setMessages([]);
    store
      .load(cParam)
      .then((r) => {
        if (!alive) return;
        setId(r.conversation.id);
        setTitle(r.conversation.title);
        if ((CHAT_MODES as readonly string[]).includes(r.conversation.mode)) setMode(r.conversation.mode as ChatMode);
        setMessages(r.messages);
        setLoad({ status: "idle" });
      })
      .catch((e: Error) => alive && setLoad({ status: "error", message: e.message }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cParam, newParam, store]);

  // Guests: persist the conversation locally once a turn settles.
  useEffect(() => {
    if (!dirty.current || busy || !conversationId || store.kind !== "local" || !store.save) return;
    dirty.current = false;
    const firstUser = messages.find((m) => m.role === "user");
    store.save({ id: conversationId, title: title ?? titleFrom(firstUser?.content ?? ""), mode, updated_at: new Date().toISOString() }, messages);
    onHistoryChanged();
  }, [busy, messages, conversationId, store, title, mode, onHistoryChanged]);

  const send = useCallback(
    async (text: string, opts: { attachments?: ChatAttachment[]; retryOf?: string; mode?: ChatMode } = {}) => {
      const content = text.trim();
      if (!content || busy) return false;
      const turnMode = opts.mode ?? mode;
      if (opts.mode) setMode(opts.mode);
      const ac = new AbortController();
      abortRef.current = ac;
      const files = opts.retryOf ? [] : (opts.attachments ?? []);
      const prior = opts.retryOf ? messages.filter((m) => m.id !== opts.retryOf) : messages;
      const userMsg: Msg = { id: crypto.randomUUID(), role: "user", content, status: "done", attachments: files.map((f) => f.name) };
      const asst: Msg = { id: crypto.randomUUID(), role: "assistant", content: "", status: "streaming", notices: [] };
      setMessages(opts.retryOf ? [...prior, asst] : [...prior, userMsg, asst]);
      const patch = (fn: (m: Msg) => Msg) => setMessages((ms) => ms.map((m) => (m.id === asst.id ? fn(m) : m)));

      const local = store.kind === "local";
      let convId = conversationId;
      if (local && !convId) {
        convId = crypto.randomUUID();
        setId(convId);
        setTitle(titleFrom(content));
        router.replace(`/chat?c=${convId}`, { scroll: false });
      }
      dirty.current = local;
      if (local && convId && store.save) {
        // Show a guest's new chat in history right away; the reply is saved when it settles.
        const firstUser = (opts.retryOf ? prior : [...prior, userMsg]).find((m) => m.role === "user");
        store.save({ id: convId, title: title ?? titleFrom(firstUser?.content ?? content), mode: turnMode, updated_at: new Date().toISOString() }, opts.retryOf ? prior : [...prior, userMsg]);
        onHistoryChanged();
      }

      // Guests send their own history; signed-in history is loaded on the server.
      const history = local
        ? prior
            .filter((m) => m.status === "done" && m.content)
            .slice(opts.retryOf ? -21 : -20)
            .slice(0, opts.retryOf ? -1 : undefined)
            .map((m) => ({ role: m.role, content: m.content.slice(0, 20_000) }))
        : undefined;

      try {
        for await (const ev of streamChat(
          {
            conversationId: local ? null : convId,
            message: content,
            mode: turnMode,
            modelId,
            useWeb: turnMode === "research" && useWeb,
            history,
            attachments: files,
          },
          ac.signal,
        )) {
          if (ev.type === "meta") {
            patch((m) => ({ ...m, modelName: ev.model.displayName }));
            if (!local && ev.conversationId && ev.conversationId !== convId) {
              convId = ev.conversationId;
              setId(convId);
              setTitle(titleFrom(content));
              router.replace(`/chat?c=${convId}`, { scroll: false });
            }
          } else if (ev.type === "sources") patch((m) => ({ ...m, sources: ev.sources }));
          else if (ev.type === "notice") patch((m) => ({ ...m, notices: [...(m.notices ?? []), ev.message] }));
          else if (ev.type === "delta") patch((m) => ({ ...m, content: m.content + ev.text }));
          else if (ev.type === "done")
            patch((m) => ({ ...m, content: ev.text, status: "done", simulated: ev.simulated, cost: ev.estimatedCost, id: ev.assistantMessageId ?? m.id }));
          else if (ev.type === "error") patch((m) => ({ ...m, status: "error", error: ev.message }));
        }
        // A stream that ends without "done" (dropped connection) is an error, not a silent stop.
        patch((m) => (m.status === "streaming" ? { ...m, status: "error", error: "The response ended unexpectedly." } : m));
        if (!local) onHistoryChanged();
      } catch (e) {
        const aborted = (e as Error).name === "AbortError";
        patch((m) =>
          m.status !== "streaming"
            ? m
            : aborted
              ? { ...m, status: m.content ? "done" : "error", error: m.content ? undefined : "Stopped before a reply arrived." }
              : { ...m, status: "error", error: (e as Error).message || "Something went wrong." },
        );
      }
      return true;
    },
    [busy, mode, messages, store, conversationId, title, router, modelId, useWeb, onHistoryChanged, setId],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const retry = useCallback(
    (assistantId: string) => {
      const idx = messages.findIndex((m) => m.id === assistantId);
      const prevUser = messages.slice(0, idx).reverse().find((m) => m.role === "user");
      if (prevUser) void send(prevUser.content, { retryOf: assistantId });
    },
    [messages, send],
  );

  const newChat = useCallback(() => {
    reset();
    router.replace("/chat", { scroll: false });
  }, [reset, router]);

  return { messages, conversationId, title, setTitle, mode, setMode, useWeb, setUseWeb, load, busy, send, stop, retry, newChat };
}
