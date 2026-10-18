"use client";
import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, CircleAlert, Info, Menu as MenuIcon, Moon, SquarePen, Sun } from "lucide-react";
import { defaultModelId, useModels } from "@/components/common/model-picker";
import { useApp } from "@/components/layout/app-context";
import { useLocalStorage } from "@/hooks/use-local-storage";
import type { ChatMode } from "@/lib/ai/modes";
import { cn } from "@/lib/utils";
import type { ChatAttachment } from "./chat-client";
import { Composer } from "./composer";
import { DeleteDialog, PromptsDialog, SaveToProjectDialog, SettingsDialog } from "./dialogs";
import { localHistory, serverHistory, type ConvSummary, type Msg } from "./history";
import { MessageView } from "./message";
import { useFeedback, useSavedPrompts, useSettings, useTheme } from "./prefs";
import { Sidebar } from "./sidebar";
import { IconButton } from "./ui";
import { useStudioChat } from "./use-chat";
import { Welcome } from "./welcome";

export function Studio() {
  const { user, integrations, refreshRecents } = useApp();
  const store = user ? serverHistory : localHistory;
  const accountsEnabled = integrations.supabase;
  const blockedGuest = accountsEnabled && !user;

  const theme = useTheme();
  const [settings, updateSettings] = useSettings();
  const { prompts, add: addPrompt, remove: removePrompt } = useSavedPrompts();
  const { feedback, give: giveFeedback } = useFeedback();

  // Models: remember the last choice if it is still available.
  const models = useModels();
  const [storedModel, setStoredModel] = useLocalStorage("nova:studio:model");
  const modelId = models?.some((m) => m.id === storedModel && m.available) ? storedModel! : defaultModelId(models);

  // History list
  const [conversations, setConversations] = useState<ConvSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const refreshList = useCallback(async () => {
    try {
      setConversations(await store.list());
      setListError(null);
    } catch (e) {
      setListError((e as Error).message);
    }
    if (store.kind === "server") void refreshRecents();
  }, [store, refreshRecents]);
  useEffect(() => {
    let alive = true;
    store
      .list()
      .then((c) => alive && setConversations(c))
      .catch((e: Error) => alive && setListError(e.message));
    return () => {
      alive = false;
    };
  }, [store]);

  const chat = useStudioChat({ store, defaultMode: settings.defaultMode, modelId, onHistoryChanged: refreshList });

  // Composer state
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);

  // Scrolling: follow new content only while the reader is at the bottom.
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  // Layout state
  const [railStored, setRailStored] = useLocalStorage("nova:studio:rail", "0");
  const collapsed = railStored === "1";
  const [mobileOpen, setMobileOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // Dialogs
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [promptsOpen, setPromptsOpen] = useState(false);
  const [toDelete, setToDelete] = useState<ConvSummary | null>(null);
  const [toSave, setToSave] = useState<Msg | null>(null);

  const focusInput = () => requestAnimationFrame(() => document.getElementById("studio-input")?.focus());

  const submit = () => {
    const text = input;
    if (!text.trim() || chat.busy) return;
    setInput("");
    setAttachments([]);
    stick.current = true;
    void chat.send(text, { attachments });
  };

  const newChat = useCallback(() => {
    chat.newChat();
    setInput("");
    setAttachments([]);
    setMobileOpen(false);
    focusInput();
  }, [chat]);

  // Keep the layout above the on-screen keyboard on mobile browsers.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const sync = () => {
      root.style.setProperty("--app-h", `${vv.height}px`);
      root.style.setProperty("--app-top", `${vv.offsetTop}px`);
    };
    sync();
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
      root.style.removeProperty("--app-h");
      root.style.removeProperty("--app-top");
    };
  }, []);

  // Global shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      const desktop = window.matchMedia("(min-width: 768px)").matches;
      if (k === "k" && !e.shiftKey) {
        e.preventDefault();
        if (desktop && !collapsed) return searchRef.current?.focus();
        if (desktop) setRailStored("0");
        else setMobileOpen(true);
        requestAnimationFrame(() => searchRef.current?.focus());
      } else if (k === "o" && e.shiftKey) {
        e.preventDefault();
        newChat();
      } else if (k === "b" && !e.shiftKey) {
        e.preventDefault();
        if (desktop) setRailStored(collapsed ? "0" : "1");
        else setMobileOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [collapsed, newChat, setRailStored]);

  // Close the drawer when resizing up to desktop.
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const on = () => mq.matches && setMobileOpen(false);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stick.current = bottom;
    setAtBottom(bottom);
  };
  // Opening another conversation always starts at its latest message.
  const shownConv = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (shownConv.current !== chat.conversationId) {
      shownConv.current = chat.conversationId;
      stick.current = true;
    }
    if (stick.current) el.scrollTop = el.scrollHeight;
  }, [chat.messages, chat.conversationId]);
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
  });

  const empty = chat.messages.length === 0 && chat.load.status === "idle";
  const lastAssistant = [...chat.messages].reverse().find((m) => m.role === "assistant")?.id;
  const demo = !integrations.openai && !integrations.huggingface;

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
      mode={chat.mode}
      onMode={chat.setMode}
      useWeb={chat.useWeb}
      onUseWeb={chat.setUseWeb}
      webAvailable={integrations.search}
      enterToSend={settings.enterToSend}
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
    <div className="studio fixed inset-x-0 top-[var(--app-top,0px)] flex h-[var(--app-h,100dvh)] overflow-hidden">
      <div className="studio-ambient" aria-hidden />

      <Sidebar
        collapsed={collapsed}
        onToggleCollapsed={() => setRailStored(collapsed ? "0" : "1")}
        mobileOpen={mobileOpen}
        onCloseMobile={() => setMobileOpen(false)}
        conversations={conversations}
        listError={listError}
        activeId={chat.conversationId}
        onNewChat={newChat}
        onRename={async (id, title) => {
          await store.rename(id, title);
          if (id === chat.conversationId) chat.setTitle(title);
          await refreshList();
        }}
        onRequestDelete={setToDelete}
        onOpenPrompts={() => {
          setMobileOpen(false);
          setPromptsOpen(true);
        }}
        onOpenSettings={() => {
          setMobileOpen(false);
          setSettingsOpen(true);
        }}
        user={user}
        accountsEnabled={accountsEnabled}
        historyKind={store.kind}
        theme={theme}
        searchRef={searchRef}
      />

      <main className="relative flex min-w-0 flex-1 flex-col">
        <header className="relative z-10 flex h-14 shrink-0 items-center gap-1 px-2 sm:px-4">
          <IconButton label="Open sidebar" onClick={() => setMobileOpen(true)} className="md:hidden">
            <MenuIcon />
          </IconButton>
          <h1 className="min-w-0 truncate px-2 text-[14px] font-medium text-s-ink-2">{empty ? "" : (chat.title ?? "New chat")}</h1>
          <div className="ml-auto flex items-center gap-0.5">
            <IconButton
              label={theme.resolved === "dark" ? "Switch to light theme" : "Switch to dark theme"}
              onClick={() => theme.setTheme(theme.resolved === "dark" ? "light" : "dark")}
            >
              {theme.resolved === "dark" ? <Sun /> : <Moon />}
            </IconButton>
            <IconButton label="New chat" onClick={newChat} className="md:hidden">
              <SquarePen />
            </IconButton>
          </div>
        </header>

        {empty ? (
          <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
            <Welcome
              name={user?.displayName?.split(" ")[0] ?? null}
              composer={composer("hero")}
              onPick={(prompt, mode: ChatMode) => {
                stick.current = true;
                void chat.send(prompt, { mode });
              }}
              notice={notice}
            />
          </div>
        ) : (
          <div className="relative min-h-0 flex-1">
            <div ref={scrollRef} onScroll={onScroll} className="s-scroll absolute inset-0 overflow-y-auto">
              <div className="mx-auto w-full max-w-[768px] px-4 pt-4 sm:px-8" style={{ paddingBottom: dockH + 32 }}>
                {chat.load.status === "loading" ? (
                  <ThreadSkeleton />
                ) : chat.load.status === "error" ? (
                  <div role="alert" className="s-in mx-auto mt-[12vh] flex max-w-sm flex-col items-center text-center">
                    <span className="grid h-11 w-11 place-items-center rounded-2xl border border-s-line text-s-danger">
                      <CircleAlert className="h-5 w-5" />
                    </span>
                    <h2 className="mt-4 text-[16px] font-semibold">This chat couldn’t be opened</h2>
                    <p className="mt-1.5 text-[14px] text-s-ink-2">{chat.load.message}</p>
                    <button
                      type="button"
                      onClick={newChat}
                      className="mt-5 rounded-xl border border-s-line-strong px-4 py-2 text-[13.5px] font-medium transition hover:bg-s-hover"
                    >
                      Start a new chat
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-10" aria-live="polite" aria-busy={chat.busy}>
                    {chat.messages.map((m) => (
                      <MessageView
                        key={m.id}
                        m={m}
                        isLast={m.id === lastAssistant}
                        busy={chat.busy}
                        feedback={feedback[m.id]}
                        thinkingLabel={chat.mode === "research" && chat.useWeb && integrations.search ? "Searching the web" : "Thinking"}
                        onRetry={chat.retry}
                        onFeedback={giveFeedback}
                        onSavePrompt={addPrompt}
                        onSaveToProject={user ? setToSave : undefined}
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
                  {composer("dock")}
                  <p className="mt-2 text-center text-[11.5px] text-s-ink-3">NOVA can make mistakes. Check important information.</p>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      <div id="studio-layer" />

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onSettings={updateSettings}
        theme={theme}
        historyKind={store.kind}
        signedIn={!!user}
        onClearLocal={() => {
          localHistory.clear?.();
          if (store.kind === "local") newChat();
          void refreshList();
        }}
      />
      <PromptsDialog
        open={promptsOpen}
        onClose={() => setPromptsOpen(false)}
        prompts={prompts}
        onAdd={addPrompt}
        onRemove={removePrompt}
        onUse={(text) => {
          setPromptsOpen(false);
          setInput(text);
          focusInput();
        }}
      />
      <DeleteDialog
        conv={toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={async (c) => {
          await store.remove(c.id);
          if (c.id === chat.conversationId) newChat();
          await refreshList();
        }}
      />
      <SaveToProjectDialog message={toSave} onClose={() => setToSave(null)} />
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
