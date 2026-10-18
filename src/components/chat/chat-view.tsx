"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, FileText, Globe, MessageSquare, Paperclip, Pencil, Plus, RefreshCw, Send, Sparkles, Square, Trash2, X } from "lucide-react";
import { Markdown } from "@/components/common/markdown";
import { CopyButton } from "@/components/common/copy-button";
import { ModelPicker, defaultModelId, useModels } from "@/components/common/model-picker";
import { SaveToProject, saveNote } from "@/components/projects/save-to-project";
import { useApp } from "@/components/layout/app-context";
import { Badge, Button, Input, Notice, Spinner, Textarea } from "@/components/ui/primitives";
import { jsonFetch, postNdjson } from "@/hooks/use-ndjson";
import { CHAT_MODES, MODE_LABELS, type ChatMode } from "@/lib/ai/modes";
import type { SearchSource } from "@/lib/search/types";
import { cn, formatUsd, relativeTime } from "@/lib/utils";
import { ALLOWED_ATTACHMENT_EXT, MAX_ATTACHMENT_CHARS } from "@/lib/limits";

interface Msg {
  id: string;
  role: "user" | "assistant";
  content: string;
  modelName?: string;
  status?: "streaming" | "done" | "error";
  error?: string;
  simulated?: boolean;
  sources?: SearchSource[];
  notices?: string[];
  attachments?: string[];
  cost?: number | null;
}

interface Conv {
  id: string;
  title: string;
  mode: string;
  updated_at: string;
}

interface Attachment {
  name: string;
  content: string;
}

type Ev =
  | { type: "meta"; conversationId: string | null; model: { displayName: string } }
  | { type: "sources"; sources: SearchSource[] }
  | { type: "notice"; message: string }
  | { type: "delta"; text: string }
  | { type: "done"; text: string; simulated: boolean; assistantMessageId: string | null; estimatedCost: number | null }
  | { type: "error"; message: string };

export function ChatView() {
  const { user, integrations, refreshRecents } = useApp();
  const params = useSearchParams();
  const router = useRouter();
  const models = useModels();
  const [pickedModel, setModelId] = useState<string | undefined>();
  const modelId = pickedModel ?? defaultModelId(models);
  const [mode, setMode] = useState<ChatMode>("research");
  const [useWeb, setUseWeb] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conv[] | null>(user ? null : []);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [loadingConv, setLoadingConv] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadList = useCallback(async () => {
    if (!user) return;
    try {
      const r = await jsonFetch<{ conversations: Conv[] }>("/api/conversations");
      setConversations(r.conversations);
    } catch {
      setConversations([]);
    }
  }, [user]);
  useEffect(() => void loadList(), [loadList]);

  // Load a conversation from ?c=
  const cParam = params.get("c");
  const newParam = params.get("new");
  useEffect(() => {
    if (newParam) {
      abortRef.current?.abort();
      setMessages([]);
      setConversationId(null);
      return;
    }
    if (!cParam || !user || cParam === conversationId) return;
    setLoadingConv(true);
    setLoadError(null);
    jsonFetch<{ conversation: Conv; messages: { id: string; role: string; content: string; model_id: string | null; usage_metadata: { sources?: SearchSource[]; attachments?: string[] } }[] }>(
      `/api/conversations/${cParam}`,
    )
      .then((r) => {
        setConversationId(r.conversation.id);
        if ((CHAT_MODES as readonly string[]).includes(r.conversation.mode)) setMode(r.conversation.mode as ChatMode);
        setMessages(
          r.messages
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => ({
              id: m.id,
              role: m.role as "user" | "assistant",
              content: m.content,
              status: "done",
              modelName: m.model_id ?? undefined,
              simulated: m.model_id?.startsWith("demo:"),
              sources: m.usage_metadata?.sources as SearchSource[] | undefined,
              attachments: m.usage_metadata?.attachments,
            })),
        );
      })
      .catch((e: Error) => setLoadError(e.message))
      .finally(() => setLoadingConv(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cParam, newParam, user]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const busy = messages.some((m) => m.status === "streaming");

  const send = async (text: string, opts: { retryOf?: string } = {}) => {
    const content = text.trim();
    if (!content || busy) return;
    const ac = new AbortController();
    abortRef.current = ac;
    const files = opts.retryOf ? [] : attachments;
    const priorMessages = opts.retryOf ? messages.filter((m) => m.id !== opts.retryOf) : messages;
    const userMsg: Msg = { id: crypto.randomUUID(), role: "user", content, status: "done", attachments: files.map((f) => f.name) };
    const asst: Msg = { id: crypto.randomUUID(), role: "assistant", content: "", status: "streaming", notices: [] };
    setMessages(opts.retryOf ? [...priorMessages, asst] : [...priorMessages, userMsg, asst]);
    setInput("");
    setAttachments([]);
    const patch = (fn: (m: Msg) => Msg) => setMessages((ms) => ms.map((m) => (m.id === asst.id ? fn(m) : m)));
    const history = user
      ? undefined
      : priorMessages
          .filter((m) => m.status === "done" && m.content)
          .slice(-20)
          .map((m) => ({ role: m.role, content: m.content.slice(0, 20000) }))
          .slice(0, opts.retryOf ? -1 : undefined);
    try {
      for await (const ev of postNdjson<Ev>(
        "/api/chat",
        { conversationId, message: content, mode, modelId, useWeb: mode === "research" && useWeb, history, attachments: files },
        ac.signal,
      )) {
        if (ev.type === "meta") {
          patch((m) => ({ ...m, modelName: ev.model.displayName }));
          if (ev.conversationId && ev.conversationId !== conversationId) {
            setConversationId(ev.conversationId);
            router.replace(`/chat?c=${ev.conversationId}`, { scroll: false });
          }
        } else if (ev.type === "sources") patch((m) => ({ ...m, sources: ev.sources }));
        else if (ev.type === "notice") patch((m) => ({ ...m, notices: [...(m.notices ?? []), ev.message] }));
        else if (ev.type === "delta") patch((m) => ({ ...m, content: m.content + ev.text }));
        else if (ev.type === "done")
          patch((m) => ({ ...m, content: ev.text, status: "done", simulated: ev.simulated, cost: ev.estimatedCost, id: ev.assistantMessageId ?? m.id }));
        else if (ev.type === "error") patch((m) => ({ ...m, status: "error", error: ev.message }));
      }
      if (user) {
        void loadList();
        void refreshRecents();
      }
    } catch (e) {
      const aborted = (e as Error).name === "AbortError";
      patch((m) => ({ ...m, status: aborted && m.content ? "done" : "error", error: aborted ? "Stopped." : (e as Error).message }));
    }
  };

  const retry = (assistantId: string) => {
    const idx = messages.findIndex((m) => m.id === assistantId);
    const prevUser = [...messages.slice(0, idx)].reverse().find((m) => m.role === "user");
    if (prevUser) void send(prevUser.content, { retryOf: assistantId });
  };

  const onFiles = async (list: FileList | null) => {
    setFileError(null);
    if (!list) return;
    const next: Attachment[] = [...attachments];
    for (const f of Array.from(list)) {
      if (next.length >= 3) {
        setFileError("Up to 3 files per message.");
        break;
      }
      if (!ALLOWED_ATTACHMENT_EXT.some((ext) => f.name.toLowerCase().endsWith(ext))) {
        setFileError(`${f.name}: only ${ALLOWED_ATTACHMENT_EXT.join(", ")} files are supported for now.`);
        continue;
      }
      if (f.size > 512_000) {
        setFileError(`${f.name} is larger than 500 KB.`);
        continue;
      }
      let text = await f.text();
      if (text.length > MAX_ATTACHMENT_CHARS) {
        text = text.slice(0, MAX_ATTACHMENT_CHARS);
        setFileError(`${f.name} was truncated to the first ${MAX_ATTACHMENT_CHARS.toLocaleString()} characters.`);
      }
      next.push({ name: f.name, content: text });
    }
    setAttachments(next);
    if (fileRef.current) fileRef.current.value = "";
  };

  const newChat = () => {
    abortRef.current?.abort();
    setMessages([]);
    setConversationId(null);
    router.replace("/chat?new=1", { scroll: false });
  };

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] lg:h-dvh">
      {/* Conversation list */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-bg-elev/50 md:flex">
        <div className="flex items-center justify-between p-3">
          <span className="text-sm font-medium">Conversations</span>
          <Button size="icon" variant="ghost" onClick={newChat} aria-label="New chat"><Plus className="h-4 w-4" /></Button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-3">
          {!user ? (
            <p className="px-2 text-xs text-faint">
              {integrations.supabase ? <><Link href="/login" className="text-accent hover:underline">Sign in</Link> to keep history.</> : "History is off in demo mode (Supabase not configured)."}
            </p>
          ) : conversations === null ? (
            <div className="p-3"><Spinner /></div>
          ) : conversations.length === 0 ? (
            <p className="px-2 text-xs text-faint">No conversations yet.</p>
          ) : (
            conversations.map((c) => (
              <ConversationItem
                key={c.id}
                conv={c}
                active={c.id === conversationId}
                onChanged={loadList}
                onDeleted={() => {
                  if (c.id === conversationId) newChat();
                  void loadList();
                  void refreshRecents();
                }}
              />
            ))
          )}
        </div>
      </aside>

      {/* Thread */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
            {loadError && <Notice tone="danger" title="Could not load conversation">{loadError}</Notice>}
            {loadingConv ? (
              <div className="grid place-items-center py-24"><Spinner /></div>
            ) : messages.length === 0 ? (
              <EmptyChat mode={mode} onPick={(p) => void send(p)} noProvider={!integrations.openai && !integrations.huggingface} />
            ) : (
              <div className="space-y-6">
                {messages.map((m) => (
                  <MessageView key={m.id} m={m} onRetry={() => retry(m.id)} busy={busy} />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Composer */}
        <div className="border-t border-border bg-bg/85 px-4 py-3 backdrop-blur sm:px-6">
          <div className="mx-auto max-w-3xl">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <div className="flex rounded-lg border border-border bg-panel p-0.5" role="radiogroup" aria-label="Mode">
                {CHAT_MODES.map((md) => (
                  <button
                    key={md}
                    role="radio"
                    aria-checked={mode === md}
                    title={MODE_LABELS[md].blurb}
                    onClick={() => setMode(md)}
                    className={cn("rounded-md px-2.5 py-1 text-xs font-medium", mode === md ? "bg-accent-soft text-accent" : "text-muted hover:text-fg")}
                  >
                    {MODE_LABELS[md].label}
                  </button>
                ))}
              </div>
              {mode === "research" && (
                <button
                  onClick={() => setUseWeb((v) => !v)}
                  aria-pressed={useWeb}
                  disabled={!integrations.search}
                  title={integrations.search ? "Include live web sources" : "Set SEARCH_API_KEY to enable web sources"}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs disabled:opacity-40",
                    useWeb ? "border-accent/40 bg-accent-soft text-accent" : "border-border text-muted hover:text-fg",
                  )}
                >
                  <Globe className="h-3.5 w-3.5" /> Web
                </button>
              )}
              <ModelPicker value={modelId} onChange={setModelId} models={models} className="ml-auto h-8 max-w-[200px] text-xs" />
            </div>

            {attachments.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {attachments.map((a) => (
                  <span key={a.name} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-panel px-2 py-1 text-xs">
                    <FileText className="h-3.5 w-3.5 text-faint" /> {a.name}
                    <button onClick={() => setAttachments((as) => as.filter((x) => x.name !== a.name))} aria-label={`Remove ${a.name}`}><X className="h-3 w-3 text-faint hover:text-fg" /></button>
                  </span>
                ))}
              </div>
            )}
            {fileError && <p className="mb-2 text-xs text-warning">{fileError}</p>}

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send(input);
              }}
              className="flex items-end gap-2 rounded-2xl border border-border-strong bg-panel p-2 focus-within:border-accent/60"
            >
              <input ref={fileRef} type="file" multiple hidden accept={ALLOWED_ATTACHMENT_EXT.join(",")} onChange={(e) => void onFiles(e.target.files)} />
              <Button type="button" variant="ghost" size="icon" onClick={() => fileRef.current?.click()} aria-label="Attach text file" title="Attach .txt, .md, .csv or .json">
                <Paperclip className="h-4 w-4" />
              </Button>
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send(input);
                  }
                }}
                rows={1}
                maxLength={12000}
                placeholder={`Message NOVA in ${MODE_LABELS[mode].label} mode…`}
                className="max-h-48 min-h-9 flex-1 border-0 bg-transparent px-1 py-2 focus:border-0 focus-visible:outline-none"
                aria-label="Message"
              />
              {busy ? (
                <Button type="button" variant="secondary" size="icon" onClick={() => abortRef.current?.abort()} aria-label="Stop"><Square className="h-4 w-4" /></Button>
              ) : (
                <Button type="submit" size="icon" disabled={!input.trim()} aria-label="Send"><Send className="h-4 w-4" /></Button>
              )}
            </form>
            <p className="mt-1.5 text-center text-[11px] text-faint">Modes change instructions for one assistant — they are not separate agents. AI can be wrong; check important facts.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function EmptyChat({ mode, onPick, noProvider }: { mode: ChatMode; onPick: (p: string) => void; noProvider: boolean }) {
  const prompts: Record<ChatMode, string[]> = {
    research: ["What is retrieval-augmented generation and when does it help?", "Summarise the main approaches to AI model evaluation."],
    analyst: ["Compare Supabase and Firebase for a small SaaS.", "What are the trade-offs of a modular monolith vs microservices?"],
    critic: ["Challenge this idea: an AI research tool for students.", "What could go wrong launching a SaaS with CHF 10,000?"],
    coding: ["Write a TypeScript debounce function with tests.", "Explain this error: 'Cannot read properties of undefined'."],
  };
  return (
    <div className="py-16 text-center">
      <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-accent-soft text-accent"><MessageSquare className="h-6 w-6" /></span>
      <h1 className="mt-4 text-xl font-semibold">{MODE_LABELS[mode].label} mode</h1>
      <p className="mt-1 text-sm text-muted">{MODE_LABELS[mode].blurb}</p>
      {noProvider && (
        <Notice tone="warning" className="mx-auto mt-6 max-w-lg text-left" title="Demo mode">
          No AI provider key is set, so replies are simulated templates. Add <code>OPENAI_API_KEY</code> or <code>HUGGINGFACE_API_KEY</code>.
        </Notice>
      )}
      <div className="mx-auto mt-6 grid max-w-xl gap-2 sm:grid-cols-2">
        {prompts[mode].map((p) => (
          <button key={p} onClick={() => onPick(p)} className="rounded-xl border border-border bg-panel/60 px-3.5 py-3 text-left text-sm text-muted hover:border-accent/40 hover:text-fg">
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageView({ m, onRetry, busy }: { m: Msg; onRetry: () => void; busy: boolean }) {
  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-panel-2 px-4 py-2.5 text-[15px]">
          {m.attachments?.length ? (
            <div className="mb-1.5 flex flex-wrap gap-1">
              {m.attachments.map((a) => <Badge key={a}><FileText className="h-3 w-3" /> {a}</Badge>)}
            </div>
          ) : null}
          <p className="whitespace-pre-wrap">{m.content}</p>
        </div>
      </div>
    );
  }
  const valid = new Set((m.sources ?? []).map((s) => s.index));
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent"><Sparkles className="h-4 w-4" /></span>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2 text-xs text-faint">
          {m.modelName ?? "NOVA"}
          {m.simulated && <Badge tone="warning">Simulated</Badge>}
        </div>
        {m.notices?.map((n, i) => <Notice key={i} tone="warning" className="mb-2">{n}</Notice>)}
        {m.content ? (
          <Markdown
            text={m.content}
            validCitations={valid}
            onCitation={(n) => {
              const s = m.sources?.find((x) => x.index === n);
              if (s) window.open(s.url, "_blank", "noopener,noreferrer");
            }}
          />
        ) : m.status === "streaming" ? (
          <div className="flex gap-1 py-2"><span className="nova-dot h-1.5 w-1.5 rounded-full bg-accent" /><span className="nova-dot h-1.5 w-1.5 rounded-full bg-accent [animation-delay:150ms]" /><span className="nova-dot h-1.5 w-1.5 rounded-full bg-accent [animation-delay:300ms]" /></div>
        ) : null}
        {m.sources && m.sources.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {m.sources.map((s) => (
              <a key={s.index} href={s.url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex max-w-[220px] items-center gap-1 rounded-md border border-border bg-panel px-1.5 py-0.5 text-[11px] text-muted hover:text-fg">
                <span className="font-semibold text-accent">{s.index}</span> <span className="truncate">{s.domain}</span>
              </a>
            ))}
          </div>
        )}
        {m.status === "error" && (
          <Notice tone="danger" className="mt-2" title="Response failed">
            {m.error}
          </Notice>
        )}
        {(m.status === "done" || m.status === "error") && (
          <div className="mt-1.5 flex flex-wrap items-center gap-0.5">
            {m.content && <CopyButton text={m.content} />}
            <Button variant="ghost" size="sm" onClick={onRetry} disabled={busy}><RefreshCw className="h-3.5 w-3.5" /> Retry</Button>
            {m.content && m.status === "done" && (
              <SaveToProject onSave={(pid) => saveNote(pid, { title: m.content.replace(/[#*`>\n]+/g, " ").trim().slice(0, 80) || "Saved answer", content: m.content, sourceType: "chat", sourceRef: m.id })} />
            )}
            {m.cost !== undefined && <span className="ml-auto text-[11px] text-faint">cost {formatUsd(m.cost)}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

function ConversationItem({ conv, active, onChanged, onDeleted }: { conv: Conv; active: boolean; onChanged: () => void; onDeleted: () => void }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(conv.title);
  const [confirm, setConfirm] = useState(false);
  const save = async () => {
    const t = title.trim();
    setEditing(false);
    if (!t || t === conv.title) return setTitle(conv.title);
    try {
      await jsonFetch(`/api/conversations/${conv.id}`, { method: "PATCH", body: JSON.stringify({ title: t }) });
      onChanged();
    } catch {
      setTitle(conv.title);
    }
  };
  if (editing) {
    return (
      <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="flex items-center gap-1 px-1 py-0.5">
        <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => void save()} maxLength={200} className="h-8 text-xs" />
        <Button size="icon" variant="ghost" type="submit" className="h-8 w-8" aria-label="Save title"><Check className="h-3.5 w-3.5" /></Button>
      </form>
    );
  }
  return (
    <div className={cn("group flex items-center rounded-lg", active ? "bg-accent-soft" : "hover:bg-panel-2")}>
      <Link href={`/chat?c=${conv.id}`} className="min-w-0 flex-1 px-2.5 py-2">
        <span className={cn("block truncate text-[13px]", active ? "text-fg" : "text-muted")}>{conv.title}</span>
        <span className="block text-[11px] text-faint">{relativeTime(conv.updated_at)}</span>
      </Link>
      {confirm ? (
        <div className="flex pr-1">
          <button className="rounded px-1.5 py-1 text-[11px] text-danger hover:bg-danger/10" onClick={async () => { await jsonFetch(`/api/conversations/${conv.id}`, { method: "DELETE" }).catch(() => null); onDeleted(); }}>Delete</button>
          <button className="rounded px-1.5 py-1 text-[11px] text-faint" onClick={() => setConfirm(false)}>Cancel</button>
        </div>
      ) : (
        <div className="flex pr-1 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
          <button className="grid h-7 w-7 place-items-center rounded text-faint hover:text-fg" onClick={() => setEditing(true)} aria-label="Rename"><Pencil className="h-3.5 w-3.5" /></button>
          <button className="grid h-7 w-7 place-items-center rounded text-faint hover:text-danger" onClick={() => setConfirm(true)} aria-label="Delete"><Trash2 className="h-3.5 w-3.5" /></button>
        </div>
      )}
    </div>
  );
}
