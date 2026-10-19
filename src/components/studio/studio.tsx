"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import { defaultModelId, useCatalog } from "@/components/common/model-picker";
import { isAutoId } from "@/lib/ai/platform";
import { useApp } from "@/components/layout/app-context";
import { useLocalStorage } from "@/hooks/use-local-storage";
import type { ChatMode } from "@/lib/ai/modes";
import type { ChatAttachment } from "./chat-client";
import { Composer } from "./composer";
import { SaveToProjectDialog } from "./dialogs";
import { StudioHeader, useStudio } from "./frame";
import type { Msg } from "./history";
import { ConversationPane } from "./thread";
import { useStudioChat } from "./use-chat";
import { Welcome } from "./welcome";

const focusInput = () => requestAnimationFrame(() => document.getElementById("studio-input")?.focus());

/** The general chat page. The sidebar, dialogs and theme come from StudioFrame. */
export function Studio() {
  const { user, integrations } = useApp();
  const studio = useStudio();
  const { store, refresh } = studio.history;
  const blockedGuest = integrations.supabase && !user;

  // Models: remember the last choice if it is still available.
  const catalog = useCatalog();
  const models = catalog?.models ?? null;
  const [storedModel, setStoredModel] = useLocalStorage("nova:studio:model");
  const modelId =
    isAutoId(storedModel) && catalog?.auto.enabled
      ? storedModel!
      : models?.some((m) => m.id === storedModel && m.available)
        ? storedModel!
        : defaultModelId(models);

  const chat = useStudioChat({
    store,
    defaultMode: studio.settings.defaultMode,
    modelId,
    allowFallback: !!studio.settings.allowFallback,
    onHistoryChanged: refresh,
  });

  const [input, setInput] = useState(() => studio.takePendingPrompt() ?? "");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [toSave, setToSave] = useState<Msg | null>(null);

  const { on } = studio;
  const { setTitle } = chat;
  useEffect(() => {
    const offs = [
      on("new-chat", () => {
        setInput("");
        setAttachments([]);
        focusInput();
      }),
      on<string>("use-prompt", (text) => {
        setInput(text);
        focusInput();
      }),
      on<{ id: string; title: string }>("renamed", (r) => {
        if (r.id === chat.conversationId) setTitle(r.title);
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [on, setTitle, chat.conversationId]);

  const submit = () => {
    const text = input;
    if (!text.trim() || chat.busy) return;
    setInput("");
    setAttachments([]);
    void chat.send(text, { attachments });
  };

  const newChat = () => {
    chat.newChat();
    setInput("");
    setAttachments([]);
    focusInput();
  };

  const empty = chat.messages.length === 0 && chat.load.status === "idle";
  const demo = !integrations.anthropic && !integrations.openai && !integrations.google && !integrations.xai && !integrations.deepseek && !integrations.huggingface;

  const composer = (variant: "hero" | "dock") => (
    <Composer
      variant={variant}
      value={input}
      onChange={setInput}
      onSubmit={submit}
      busy={chat.busy}
      onStop={chat.stop}
      attachments={attachments}
      onAttachments={setAttachments}
      models={models}
      modelId={modelId}
      onModel={setStoredModel}
      auto={catalog?.auto ?? null}
      mode={chat.mode}
      onMode={chat.setMode}
      useWeb={chat.useWeb}
      onUseWeb={chat.setUseWeb}
      webAvailable={integrations.search}
      enterToSend={studio.settings.enterToSend}
    />
  );

  const notice = blockedGuest ? (
    <span>
      <Link href="/login?next=/chat" className="text-s-accent underline-offset-4 hover:underline">
        Sign in
      </Link>{" "}
      to start chatting and keep your history.
    </span>
  ) : demo ? (
    <span className="inline-flex items-start gap-2">
      <Info className="mt-px h-3.5 w-3.5 shrink-0" />
      Demo mode: replies are simulated until an AI provider key is added on the server.
    </span>
  ) : null;

  return (
    <>
      <StudioHeader onNewChat={newChat}>
        <h1 className="min-w-0 truncate text-[14px] font-medium text-s-ink-2">{empty ? "" : (chat.title ?? "New chat")}</h1>
      </StudioHeader>

      {empty ? (
        <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
          <Welcome
            name={user?.displayName?.split(" ")[0] ?? null}
            composer={composer("hero")}
            onPick={(prompt, mode: ChatMode) => void chat.send(prompt, { mode })}
            notice={notice}
          />
        </div>
      ) : (
        <ConversationPane
          messages={chat.messages}
          load={chat.load}
          busy={chat.busy}
          conversationId={chat.conversationId}
          composer={composer("dock")}
          thinkingLabel={chat.mode === "research" && chat.useWeb && integrations.search ? "Searching the web" : "Thinking"}
          feedback={studio.feedback}
          onRetry={chat.retry}
          onFeedback={studio.giveFeedback}
          onSavePrompt={studio.addPrompt}
          onSaveToProject={user ? setToSave : undefined}
          onStartOver={newChat}
        />
      )}

      <SaveToProjectDialog message={toSave} onClose={() => setToSave(null)} />
    </>
  );
}
