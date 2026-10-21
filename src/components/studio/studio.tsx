"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Info } from "lucide-react";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { defaultModelId, useCatalog } from "@/components/common/model-picker";
import { AUTO_MODEL_ID, isAutoId } from "@/lib/ai/platform";
import { useModelChoice } from "./use-model-choice";
import { useApp } from "@/components/layout/app-context";
import type { HomeAction } from "@/lib/home";
import { PENDING_START_KEY, readPendingStart, starterModelId, starterTask, type StarterTask, type StarterTaskId } from "@/lib/starter";
import type { ChatAttachment } from "./chat-client";
import { Composer } from "./composer";
import { StudioHeader, useStudio } from "./frame";
import { Home } from "./home";
import type { ConvSummary } from "./history";
import { ProjectChip } from "./project-chip";
import { useReplyActions } from "./reply-actions";
import { ConversationPane } from "./thread";
import { useStudioChat } from "./use-chat";
import type { StarterEnv } from "./task-starter";
import { Welcome } from "./welcome";

/** The most recently active chat (pinned chats are listed first, so not always the first). */
const latestOf = (list: ConvSummary[] | null) => (list ?? []).reduce<ConvSummary | null>((a, c) => (!a || c.updated_at > a.updated_at ? c : a), null);

const focusInput = () => requestAnimationFrame(() => document.getElementById("studio-input")?.focus());

export const HOME_PLACEHOLDER = "What would you like to explore, create, or work on today?";

/**
 * The general chat page, and the home (`home`): the same conversation surface,
 * with the home's start screen instead of the chat welcome. A conversation
 * started on the home continues there (/home?c=…). The sidebar, dialogs and
 * theme come from StudioFrame.
 */
export function Studio({ home = false }: { home?: boolean }) {
  const router = useRouter();
  const { user, integrations } = useApp();
  const studio = useStudio();
  const { store, refresh } = studio.history;
  const blockedGuest = integrations.supabase && !user;

  // Models: the user's choice while it's available; otherwise Auto (the lowest-cost
  // available model), or that model directly when the admin has turned Auto off.
  const catalog = useCatalog();
  const models = catalog?.models ?? null;
  const [storedModel, setStoredModel] = useModelChoice();
  const modelId =
    isAutoId(storedModel) && catalog?.auto.enabled
      ? storedModel!
      : models?.some((m) => m.id === storedModel && m.available)
        ? storedModel!
        : catalog?.auto.enabled
          ? AUTO_MODEL_ID
          : defaultModelId(models);

  const chat = useStudioChat({
    store,
    defaultMode: studio.settings.defaultMode,
    modelId,
    allowFallback: !!studio.settings.allowFallback,
    onHistoryChanged: refresh,
    basePath: home ? "/home" : "/chat",
    replyLength: studio.settings.replyLength,
    replyStyle: studio.settings.replyStyle,
  });

  const [input, setInput] = useState(() => studio.takePendingPrompt() ?? "");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);

  const { on } = studio;
  const { setTitle, moved } = chat;
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
      on<{ id: string; projectId: string | null }>("moved", (r) => moved(r.id, r.projectId)),
    ];
    return () => offs.forEach((off) => off());
  }, [on, setTitle, moved, chat.conversationId]);

  // A reply turned into a note, task, milestone, saved prompt or follow-up (in the same project).
  const replies = useReplyActions({
    signedIn: !!user,
    onFollowUp: (draft) => {
      chat.newChat(chat.projectId);
      setAttachments([]);
      setInput(draft);
      focusInput();
    },
  });

  // The starter: which task is chosen, and setting the box up for it.
  const [starterId, setStarterId] = useState<StarterTaskId | null>(null);
  const autoOn = !!catalog?.auto.enabled;
  const starterEnv: StarterEnv = { search: integrations.search, autoOn };
  const { setMode: setChatMode, setUseWeb: setChatWeb } = chat;
  const applyTask = useCallback(
    (task: StarterTask | null) => {
      setStarterId(task?.id ?? null);
      if (!task?.setup) return;
      setChatMode(task.setup.mode);
      setChatWeb(task.setup.web && integrations.search);
      const id = starterModelId(task);
      if (autoOn && id && id !== storedModel) setStoredModel(id);
    },
    [setChatMode, setChatWeb, integrations.search, autoOn, storedModel, setStoredModel],
  );

  /** A visitor without an account: keep what they asked, and take them to sign up (they come back to it). */
  const signUpWith = useCallback(
    (prompt: string) => {
      try {
        localStorage.setItem(PENDING_START_KEY, JSON.stringify({ prompt, task: starterId, at: Date.now() }));
      } catch {
        /* they'll type it again */
      }
      router.push(`/login?mode=signup&next=${encodeURIComponent(home ? "/home" : "/chat")}`);
    },
    [router, home, starterId],
  );

  // Back from signing up: the request is waiting in the box, set up as it was (not sent without them).
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    if (!user) return;
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(PENDING_START_KEY);
      localStorage.removeItem(PENDING_START_KEY);
    } catch {
      return;
    }
    const pending = readPendingStart(raw);
    if (!pending) return;
    const t = setTimeout(() => {
      applyTask(starterTask(pending.task) ?? null);
      setInput(pending.prompt);
      setRestored(true);
      focusInput();
    }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when signed in
  }, [user]);

  const submit = () => {
    const text = input;
    if (!text.trim() || chat.busy) return;
    if (blockedGuest) return signUpWith(text.trim());
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
  // After the first message, the welcome screen stops introducing Orbis.
  const [welcomed, setWelcomed] = useLocalStorage("orbis:welcomed");
  useEffect(() => {
    if (!empty && !welcomed) setWelcomed("1");
  }, [empty, welcomed, setWelcomed]);
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
      placeholder={home && variant === "hero" ? HOME_PLACEHOLDER : undefined}
    />
  );

  // Suggestions, tools and Discover on the home: send, fill the box (optionally opening the file picker), or open a page.
  const { send, setMode, setUseWeb } = chat;
  const runAction = useCallback(
    (a: HomeAction) => {
      if (a.kind === "link") return router.push(a.href);
      if (a.kind === "send" && blockedGuest) return signUpWith(a.prompt);
      if (a.kind === "send") return void send(a.prompt, { mode: a.mode, modelId: a.modelId, useWeb: a.web === undefined ? undefined : a.web && integrations.search });
      setMode(a.mode);
      setUseWeb(!!a.web && integrations.search);
      setInput(a.prompt);
      requestAnimationFrame(() => {
        const el = document.getElementById("studio-input") as HTMLTextAreaElement | null;
        el?.focus();
        el?.setSelectionRange(a.prompt.length, a.prompt.length);
        if (a.attach) document.getElementById("studio-file")?.click();
      });
    },
    [router, send, setMode, setUseWeb, integrations.search, blockedGuest, signUpWith],
  );

  const notice = blockedGuest ? (
    <span>
      <Link href={`/login?mode=signup&next=${home ? "/home" : "/chat"}`} className="text-s-accent underline-offset-4 hover:underline">
        Create a free account
      </Link>{" "}
      or{" "}
      <Link href={home ? "/login?next=/home" : "/login?next=/chat"} className="text-s-accent underline-offset-4 hover:underline">
        sign in
      </Link>{" "}
      to get answers. Whatever you ask first is kept for you.
    </span>
  ) : restored ? (
    <span>Your request is ready in the box. Press Enter to send it, or change it first.</span>
  ) : demo ? (
    <span className="inline-flex items-start gap-2">
      <Info className="mt-px h-3.5 w-3.5 shrink-0" />
      Demo mode: replies are simulated until an AI provider key is added on the server.
    </span>
  ) : null;

  return (
    <>
      <StudioHeader onNewChat={newChat} actions={user && chat.projectId ? <ProjectChip projectId={chat.projectId} use={chat.projectUse} notify={studio.notify} /> : undefined}>
        {!empty && <h1 className="min-w-0 truncate text-[14px] font-medium text-s-ink-2">{chat.title ?? "New chat"}</h1>}
      </StudioHeader>

      {empty && home ? (
        <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
          <Home
            name={user?.displayName?.split(" ")[0] ?? null}
            composer={composer("hero")}
            onAction={runAction}
            notice={notice}
            starter={{ active: starterId, onChoose: applyTask, env: starterEnv }}
          />
        </div>
      ) : empty ? (
        <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
          <Welcome
            name={user?.displayName?.split(" ")[0] ?? null}
            composer={composer("hero")}
            onAction={runAction}
            notice={notice}
            starter={{ active: starterId, onChoose: applyTask, env: starterEnv }}
            recent={latestOf(studio.conversations)}
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
          onEdit={chat.edit}
          onFeedback={studio.giveFeedback}
          onSavePrompt={studio.addPrompt}
          onReplyAction={replies.act}
          projectActions={replies.projectActions}
          onStartOver={newChat}
        />
      )}

      {replies.dialogs}
    </>
  );
}
