"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMode } from "@/lib/ai/modes";
import type { ReplyLength, ReplyStyle } from "@/lib/ai/reply-settings";
import { CHAT_MODES } from "@/lib/ai/modes";
import { streamChat, type ChatAttachment, type ChatTransport, type ProjectUse } from "./chat-client";
import { titleFrom, type HistoryStore, type Msg } from "./history";

/** Sent by the Continue button under a reply that was cut off at its length limit. */
export const CONTINUE_PROMPT = "Please continue exactly where your last reply stopped, without repeating what you already wrote.";

export type LoadState = { status: "idle" } | { status: "loading" } | { status: "error"; message: string };

const chatTransport: ChatTransport = (req, signal) =>
  streamChat({ ...req, useWeb: req.mode === "research" && req.useWeb }, signal);

/**
 * Conversation state for one chat surface: the general chat (default) or an
 * agent workspace (`basePath` + agent `transport`). Handles streaming, stop,
 * retry, URL sync (?c=, ?new) and guest history in the browser.
 */
export function useStudioChat({
  store,
  defaultMode,
  modelId,
  allowFallback = false,
  onHistoryChanged,
  basePath = "/chat",
  transport = chatTransport,
  replyLength,
  replyStyle,
  useMemory = true,
}: {
  store: HistoryStore;
  defaultMode: ChatMode;
  modelId: string | undefined;
  /** The user lets another compatible model answer if the chosen one fails. */
  allowFallback?: boolean;
  onHistoryChanged: () => void;
  basePath?: string;
  transport?: ChatTransport;
  replyLength?: ReplyLength;
  replyStyle?: ReplyStyle;
  /** Signed in: replies may use the facts the user asked Orbis to remember. */
  useMemory?: boolean;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [mode, setMode] = useState<ChatMode>(defaultMode);
  const [useWeb, setUseWeb] = useState(false);
  const [load, setLoad] = useState<LoadState>({ status: "idle" });
  // The project this chat is in (signed in): from the loaded chat, ?project= for a new one, or the server's reply.
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectUse, setProjectUse] = useState<ProjectUse | null>(null);
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
    setProjectId(null);
    setProjectUse(null);
  }, [setId]);

  // Open the conversation named in ?c=, or start fresh on ?new.
  const cParam = params.get("c");
  const newParam = params.has("new");
  const projectParam = params.get("project");
  useEffect(() => {
    if (newParam) {
      reset();
      router.replace(basePath, { scroll: false });
      return;
    }
    // A new chat inside a project: /chat?project=<id>.
    if (!cParam && projectParam && store.kind === "server" && /^[0-9a-f-]{36}$/i.test(projectParam)) {
      if (idRef.current) reset();
      setProjectId(projectParam);
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
        setProjectId(r.conversation.project_id ?? null);
        setProjectUse(null);
        if ((CHAT_MODES as readonly string[]).includes(r.conversation.mode)) setMode(r.conversation.mode as ChatMode);
        setMessages(r.messages);
        setLoad({ status: "idle" });
      })
      .catch((e: Error) => alive && setLoad({ status: "error", message: e.message }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cParam, newParam, projectParam, store]);

  // Guests: persist the conversation locally once a turn settles.
  useEffect(() => {
    if (!dirty.current || busy || !conversationId || store.kind !== "local" || !store.save) return;
    dirty.current = false;
    const firstUser = messages.find((m) => m.role === "user");
    store.save({ id: conversationId, title: title ?? titleFrom(firstUser?.content ?? ""), mode, updated_at: new Date().toISOString() }, messages);
    onHistoryChanged();
  }, [busy, messages, conversationId, store, title, mode, onHistoryChanged]);

  const send = useCallback(
    async (text: string, opts: { attachments?: ChatAttachment[]; retryOf?: string; editOf?: string; mode?: ChatMode; modelId?: string; useWeb?: boolean } = {}) => {
      const content = text.trim();
      if (!content || busy) return false;
      // An edit rewrites an earlier question: it and everything after it are replaced.
      const editIdx = opts.editOf ? messages.findIndex((m) => m.id === opts.editOf && m.role === "user") : -1;
      if (opts.editOf && editIdx < 0) return false;
      const turnMode = opts.mode ?? mode;
      if (opts.mode) setMode(opts.mode);
      // A regenerate replaces the last reply: everything before it stays, in place.
      const retryIdx = opts.retryOf ? messages.findIndex((m) => m.id === opts.retryOf) : -1;
      if (opts.retryOf && (retryIdx < 0 || retryIdx !== messages.length - 1)) return false;
      const ac = new AbortController();
      abortRef.current = ac;
      const files = opts.attachments ?? [];
      const prior = opts.retryOf ? messages.slice(0, retryIdx) : opts.editOf ? messages.slice(0, editIdx) : messages;
      const userMsg: Msg = { id: crypto.randomUUID(), role: "user", content, status: "done", attachments: files.map((f) => f.name), files };
      const asst: Msg = { id: crypto.randomUUID(), role: "assistant", content: "", status: "streaming", notices: [] };
      setMessages(opts.retryOf ? [...prior, asst] : [...prior, userMsg, asst]);
      const patch = (fn: (m: Msg) => Msg) => setMessages((ms) => ms.map((m) => (m.id === asst.id ? fn(m) : m)));

      const local = store.kind === "local";
      let convId = conversationId;
      if (local && !convId) {
        convId = crypto.randomUUID();
        setId(convId);
        setTitle(titleFrom(content));
        router.replace(`${basePath}?c=${convId}`, { scroll: false });
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
        for await (const ev of transport(
          {
            conversationId: local ? null : convId,
            projectId: !local && !convId ? projectId : undefined,
            message: content,
            mode: turnMode,
            modelId: opts.modelId ?? modelId,
            useWeb: opts.useWeb ?? useWeb,
            allowFallback,
            history,
            attachments: files,
            regenerate: opts.retryOf ? true : undefined,
            editOf: opts.editOf && !local ? opts.editOf : undefined,
            replyLength,
            replyStyle,
            useMemory,
          },
          ac.signal,
        )) {
          if (ev.type === "meta") {
            patch((m) => ({ ...m, modelName: ev.model.displayName, routing: ev.routing?.reason }));
            if (!local && ev.conversationId && ev.conversationId !== convId) {
              convId = ev.conversationId;
              setId(convId);
              setTitle(titleFrom(content));
              router.replace(`${basePath}?c=${convId}`, { scroll: false });
            }
          } else if (ev.type === "model") patch((m) => ({ ...m, modelName: ev.model.displayName, routing: undefined }));
          else if (ev.type === "tool") patch((m) => ({ ...m, tools: [...(m.tools ?? []), ev.tool] }));
          else if (ev.type === "sources") patch((m) => ({ ...m, sources: ev.sources }));
          else if (ev.type === "actions") patch((m) => ({ ...m, actions: ev.actions }));
          else if (ev.type === "notice") patch((m) => ({ ...m, notices: [...(m.notices ?? []), ev.message] }));
          else if (ev.type === "project") {
            setProjectId(ev.project.id);
            setProjectUse(ev.project);
          }
          else if (ev.type === "delta") patch((m) => ({ ...m, content: m.content + ev.text }));
          else if (ev.type === "done") {
            patch((m) => ({ ...m, content: ev.text, status: "done", simulated: ev.simulated, cost: ev.estimatedCost, id: ev.assistantMessageId ?? m.id, truncated: ev.truncated || undefined }));
            // The saved question's id, so it can be edited later.
            const savedId = ev.userMessageId;
            if (savedId) setMessages((ms) => ms.map((m) => (m.id === userMsg.id ? { ...m, id: savedId } : m)));
          }
          else if (ev.type === "error") patch((m) => ({ ...m, status: "error", error: ev.message }));
        }
        // A stream that ends without "done" (dropped connection) is an error, not a silent stop.
        patch((m) => (m.status === "streaming" ? { ...m, status: "error", error: "The response ended unexpectedly." } : m));
      } catch (e) {
        const aborted = (e as Error).name === "AbortError";
        patch((m) =>
          m.status !== "streaming"
            ? m
            : aborted
              ? { ...m, status: m.content ? "done" : "error", error: m.content ? undefined : "Stopped before a reply arrived.", stopped: !m.content }
              : { ...m, status: "error", error: (e as Error).message || "Something went wrong.", needsSignIn: (e as { status?: number }).status === 401 },
        );
      } finally {
        // Signed in: the server may have created or touched the conversation even if the turn was stopped or failed.
        if (!local) onHistoryChanged();
      }
      return true;
    },
    [busy, mode, messages, store, conversationId, title, router, modelId, allowFallback, useWeb, onHistoryChanged, setId, basePath, transport, replyLength, replyStyle, projectId, useMemory],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  // Only the latest reply can be regenerated: an earlier one would need the turns after it rewritten.
  const retry = useCallback(
    (assistantId: string) => {
      const idx = messages.findIndex((m) => m.id === assistantId);
      if (idx < 0 || idx !== messages.length - 1) return;
      const prevUser = messages.slice(0, idx).reverse().find((m) => m.role === "user");
      if (prevUser) void send(prevUser.content, { retryOf: assistantId, attachments: prevUser.files });
    },
    [messages, send],
  );

  /** Rewrite an earlier question and get a new answer; the turns after it are replaced. */
  const edit = useCallback(
    (userId: string, text: string) => {
      const m = messages.find((x) => x.id === userId && x.role === "user");
      if (m) void send(text, { editOf: userId, attachments: m.files });
    },
    [messages, send],
  );

  /** A fresh chat; `inProject` starts it in that project. */
  const newChat = useCallback(
    (inProject?: string | null) => {
      reset();
      router.replace(inProject ? `${basePath}?project=${inProject}` : basePath, { scroll: false });
    },
    [reset, router, basePath],
  );

  // The chat was moved into (or out of) a project from the sidebar.
  const moved = useCallback((id: string, to: string | null) => {
    if (id !== idRef.current) return;
    setProjectId(to);
    setProjectUse(null);
  }, []);

  return { messages, conversationId, title, setTitle, mode, setMode, useWeb, setUseWeb, load, busy, send, stop, retry, edit, newChat, projectId, projectUse, moved };
}
