"use client";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, CircleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Msg } from "./history";
import { MessageView } from "./message";
import type { Feedback } from "./prefs";
import type { LoadState } from "./use-chat";

/**
 * A conversation: scrolling message list plus the floating glass composer.
 * Used by the general chat and by agent workspaces.
 */
export function ConversationPane({
  messages,
  load,
  busy,
  conversationId,
  composer,
  footnote = "NOVA can make mistakes. Check important information.",
  thinkingLabel,
  feedback,
  onRetry,
  onFeedback,
  onSavePrompt,
  onSaveToProject,
  onStartOver,
  startOverLabel = "Start a new chat",
  assistantName,
  assistantAvatar,
}: {
  messages: Msg[];
  load: LoadState;
  busy: boolean;
  conversationId: string | null;
  composer: ReactNode;
  footnote?: string;
  thinkingLabel: string;
  feedback: Record<string, Feedback>;
  onRetry: (id: string) => void;
  onFeedback: (id: string, f: Feedback) => void;
  onSavePrompt: (text: string) => boolean;
  onSaveToProject?: (m: Msg) => void;
  onStartOver: () => void;
  startOverLabel?: string;
  assistantName?: string;
  assistantAvatar?: ReactNode;
}) {
  // Follow new content only while the reader is at the bottom.
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stick.current = bottom;
    setAtBottom(bottom);
  };
  // A new conversation, or a message the user just sent, always scrolls to the latest.
  const shown = useRef<{ id: string | null; count: number }>({ id: null, count: 0 });
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const justSent = messages.length > shown.current.count && messages.at(-1)?.status === "streaming";
    if (shown.current.id !== conversationId || justSent) stick.current = true;
    shown.current = { id: conversationId, count: messages.length };
    if (stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, conversationId]);
  const scrollToBottom = () => {
    stick.current = true;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  };

  // Reserve room under the thread for the floating composer.
  const dockRef = useRef<HTMLDivElement>(null);
  const [dockH, setDockH] = useState(140);
  useEffect(() => {
    const el = dockRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setDockH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant")?.id;

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} onScroll={onScroll} className="s-scroll absolute inset-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-[768px] px-4 pt-4 sm:px-8" style={{ paddingBottom: dockH + 32 }}>
          {load.status === "loading" ? (
            <ThreadSkeleton />
          ) : load.status === "error" ? (
            <div role="alert" className="s-in mx-auto mt-[12vh] flex max-w-sm flex-col items-center text-center">
              <span className="grid h-11 w-11 place-items-center rounded-2xl border border-s-line text-s-danger">
                <CircleAlert className="h-5 w-5" />
              </span>
              <h2 className="mt-4 text-[16px] font-semibold">This conversation couldn’t be opened</h2>
              <p className="mt-1.5 text-[14px] text-s-ink-2">{load.message}</p>
              <button
                type="button"
                onClick={onStartOver}
                className="mt-5 rounded-xl border border-s-line-strong px-4 py-2 text-[13.5px] font-medium transition hover:bg-s-hover"
              >
                {startOverLabel}
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-10" aria-live="polite" aria-busy={busy}>
              {messages.map((m, i) => (
                <MessageView
                  key={m.id}
                  m={m}
                  isLast={m.id === lastAssistant}
                  busy={busy}
                  feedback={feedback[m.id]}
                  thinkingLabel={thinkingLabel}
                  onRetry={onRetry}
                  onFeedback={onFeedback}
                  onSavePrompt={onSavePrompt}
                  onSaveToProject={onSaveToProject}
                  assistantName={assistantName}
                  assistantAvatar={assistantAvatar}
                  question={m.role === "assistant" ? questionBefore(messages, i) : undefined}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <div ref={dockRef} className="pointer-events-none absolute inset-x-0 bottom-0 z-10">
        <div className="h-8 bg-gradient-to-b from-transparent to-[var(--s-bg)] opacity-70" />
        <div className="pointer-events-auto relative px-3 pb-[max(12px,env(safe-area-inset-bottom))] sm:px-6">
          <button
            type="button"
            onClick={scrollToBottom}
            aria-label="Scroll to latest"
            tabIndex={atBottom ? -1 : 0}
            className={cn(
              "glass-strong absolute -top-12 left-1/2 grid h-9 w-9 -translate-x-1/2 place-items-center rounded-full text-s-ink-2 transition-all duration-300 hover:text-s-ink",
              atBottom ? "pointer-events-none translate-y-2 opacity-0" : "opacity-100",
            )}
          >
            <ArrowDown className="h-4 w-4" />
          </button>
          <div className="mx-auto max-w-[768px]">
            {composer}
            <p className="mt-2 text-center text-[11.5px] text-s-ink-3">{footnote}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function ThreadSkeleton() {
  return (
    <div className="flex flex-col gap-10 pt-2" aria-label="Loading conversation">
      <div className="ml-auto h-11 w-2/5 rounded-[22px] bg-s-user" />
      <div className="space-y-3">
        <div className="s-skeleton h-4 w-24" />
        <div className="s-skeleton h-4 w-full" />
        <div className="s-skeleton h-4 w-11/12" />
        <div className="s-skeleton h-4 w-3/5" />
      </div>
      <div className="ml-auto h-11 w-1/3 rounded-[22px] bg-s-user" />
      <div className="space-y-3">
        <div className="s-skeleton h-4 w-full" />
        <div className="s-skeleton h-4 w-4/5" />
      </div>
    </div>
  );
}

/** The closest user message before index i. */
function questionBefore(messages: { role: string; content: string }[], i: number): string {
  for (let j = i - 1; j >= 0; j--) if (messages[j].role === "user") return messages[j].content.slice(0, 4000);
  return "";
}
