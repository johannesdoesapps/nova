"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Menu as MenuIcon, Moon, SquarePen, Sun } from "lucide-react";
import { useApp } from "@/components/layout/app-context";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { cn } from "@/lib/utils";
import { CommandPalette } from "./command-palette";
import { ArchivedDialog, DeleteDialog, PromptsDialog, SettingsDialog } from "./dialogs";
import { localHistory, serverHistory, type ConvSummary, type HistoryStore } from "./history";
import { useFeedback, useSavedPrompts, useSettings, useTheme, type Feedback, type StudioSettings } from "./prefs";
import { sectionFor } from "./nav";
import { Sidebar } from "./sidebar";
import { IconButton } from "./ui";

type FrameEvent = "new-chat" | "use-prompt" | "renamed";

interface StudioContext {
  theme: ReturnType<typeof useTheme>;
  settings: StudioSettings;
  /** General chat history (agent conversations are kept separately). */
  history: { store: HistoryStore; refresh: () => Promise<void> };
  addPrompt: (text: string) => boolean;
  feedback: Record<string, Feedback>;
  giveFeedback: (id: string, f: Feedback) => void;
  openSidebar: () => void;
  notify: (text: string) => void;
  /** Subscribe to frame events (new chat, saved prompt chosen, chat renamed). */
  on: <T = unknown>(event: FrameEvent, cb: (detail: T) => void) => () => void;
  /** A saved prompt chosen while no composer was on screen. */
  takePendingPrompt: () => string | null;
}

const Ctx = createContext<StudioContext | null>(null);

export function useStudio(): StudioContext {
  const v = useContext(Ctx);
  if (!v) throw new Error("useStudio must be used inside StudioFrame");
  return v;
}

/**
 * The persistent studio shell: sidebar, theme, dialogs, shortcuts and toasts.
 * Chat and Agents pages render inside it, so navigating between them keeps
 * the sidebar, its scroll position and its state.
 */
export function StudioFrame({ children }: { children: ReactNode }) {
  const { user, integrations, refreshRecents } = useApp();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const store = user ? serverHistory : localHistory;

  const theme = useTheme();
  const [settings, updateSettings] = useSettings();
  const { prompts, add: addPrompt, remove: removePrompt } = useSavedPrompts();
  const { feedback, give: giveFeedback } = useFeedback();

  // Events between the frame and the page inside it.
  const bus = useRef<EventTarget | null>(null);
  const getBus = () => (bus.current ??= new EventTarget());
  const on = useCallback(<T,>(event: FrameEvent, cb: (detail: T) => void) => {
    const handler = (e: Event) => cb((e as CustomEvent<T>).detail);
    const b = (bus.current ??= new EventTarget());
    b.addEventListener(event, handler);
    return () => b.removeEventListener(event, handler);
  }, []);
  const emit = (event: FrameEvent, detail?: unknown) => getBus().dispatchEvent(new CustomEvent(event, { detail }));
  const pendingPrompt = useRef<string | null>(null);
  const takePendingPrompt = useCallback(() => {
    const p = pendingPrompt.current;
    pendingPrompt.current = null;
    return p;
  }, []);

  // History list
  const [conversations, setConversations] = useState<ConvSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
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

  // Layout
  const [railStored, setRailStored] = useLocalStorage("orbis:studio:rail", "0");
  const collapsed = railStored === "1";
  const [mobileOpen, setMobileOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // Dialogs and toasts
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [promptsOpen, setPromptsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [toDelete, setToDelete] = useState<ConvSummary | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [toast, setToast] = useState<{ text: string; key: number } | null>(null);
  const notify = useCallback((text: string) => setToast({ text, key: Date.now() }), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  const onChat = pathname === "/chat";
  const activeChat = onChat ? params.get("c") : null;

  const newChat = useCallback(() => {
    setMobileOpen(false);
    if (onChat) emit("new-chat");
    router.push("/chat?new=1");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onChat, router]);

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
        setPaletteOpen((o) => !o);
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

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const close = () => mq.matches && setMobileOpen(false);
    mq.addEventListener("change", close);
    return () => mq.removeEventListener("change", close);
  }, []);

  const value: StudioContext = {
    theme,
    settings,
    history: { store, refresh },
    addPrompt,
    feedback,
    giveFeedback,
    openSidebar: () => setMobileOpen(true),
    notify,
    on,
    takePendingPrompt,
  };

  return (
    <Ctx value={value}>
      <div className="studio fixed inset-x-0 top-[var(--app-top,0px)] flex h-[var(--app-h,100dvh)] overflow-hidden">
        <div className="studio-ambient" aria-hidden />

        <Sidebar
          collapsed={collapsed}
          onToggleCollapsed={() => setRailStored(collapsed ? "0" : "1")}
          mobileOpen={mobileOpen}
          onCloseMobile={() => setMobileOpen(false)}
          section={sectionFor(pathname)}
          conversations={conversations}
          listError={listError}
          activeId={activeChat}
          onNewChat={newChat}
          onRename={async (id, title) => {
            try {
              await store.rename(id, title);
            } catch (e) {
              notify(`Couldn’t rename the chat: ${(e as Error).message}`);
              throw e;
            }
            emit("renamed", { id, title });
            await refresh();
          }}
          onSearch={store.search}
          onRequestDelete={setToDelete}
          onArchive={
            store.archive
              ? async (c) => {
                  try {
                    await store.archive!(c.id, true);
                  } catch (e) {
                    notify(`Couldn’t archive the chat: ${(e as Error).message}`);
                    return;
                  }
                  if (c.id === activeChat) router.replace("/chat?new=1");
                  await refresh();
                  notify("Chat archived");
                }
              : undefined
          }
          onOpenPrompts={() => {
            setMobileOpen(false);
            setPromptsOpen(true);
          }}
          onOpenSettings={() => {
            setMobileOpen(false);
            setSettingsOpen(true);
          }}
          user={user}
          accountsEnabled={integrations.supabase}
          historyKind={store.kind}
          theme={theme}
          searchRef={searchRef}
        />

        <main className="relative flex min-w-0 flex-1 flex-col">{children}</main>

        <div id="studio-layer" />

        <div
          role="status"
          aria-live="polite"
          className={cn(
            "pointer-events-none absolute bottom-[calc(24px+env(safe-area-inset-bottom))] left-1/2 z-[70] -translate-x-1/2 rounded-full bg-s-ink px-4 py-2 text-[13px] text-s-bg shadow-[var(--s-shadow)] transition-all duration-300",
            toast ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0",
          )}
        >
          {toast?.text}
        </div>

        <SettingsDialog
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          settings={settings}
          onSettings={updateSettings}
          theme={theme}
          historyKind={store.kind}
          onOpenArchived={
            store.listArchived
              ? () => {
                  setSettingsOpen(false);
                  setArchivedOpen(true);
                }
              : undefined
          }
          onClearLocal={() => {
            localHistory.clear?.();
            if (onChat) router.replace("/chat?new=1");
            void refresh();
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
            // Fill whichever composer is on screen; otherwise open a new chat with it.
            if (document.getElementById("studio-input")) emit("use-prompt", text);
            else {
              pendingPrompt.current = text;
              router.push("/chat?new=1");
            }
          }}
        />
        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          conversations={conversations}
          isAdmin={Boolean(user?.isAdmin)}
          signedIn={Boolean(user)}
          onNewChat={newChat}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenPrompts={() => setPromptsOpen(true)}
        />
        {store.listArchived && (
          <ArchivedDialog
            open={archivedOpen}
            onClose={() => setArchivedOpen(false)}
            load={store.listArchived}
            onRestore={async (c) => {
              await store.archive!(c.id, false);
              await refresh();
              notify("Chat restored");
            }}
            onDelete={(c) => {
              setArchivedOpen(false);
              setToDelete(c);
            }}
          />
        )}
        <DeleteDialog
          conv={toDelete}
          onClose={() => setToDelete(null)}
          onConfirm={async (c) => {
            await store.remove(c.id);
            if (c.id === activeChat) router.replace("/chat?new=1");
            await refresh();
            notify("Chat deleted");
          }}
        />
      </div>
    </Ctx>
  );
}

/** Top bar shared by studio pages: drawer button, title area, page actions, theme toggle. */
export function StudioHeader({ children, actions, onNewChat }: { children?: ReactNode; actions?: ReactNode; onNewChat?: () => void }) {
  const { openSidebar, theme } = useStudio();
  return (
    <header className="relative z-10 flex h-14 shrink-0 items-center gap-1 px-2 sm:px-4">
      <IconButton label="Open sidebar" onClick={openSidebar} className="md:hidden">
        <MenuIcon />
      </IconButton>
      <div className="flex min-w-0 flex-1 items-center gap-2 px-1 sm:px-2">{children}</div>
      <div className="flex shrink-0 items-center gap-0.5">
        {actions}
        <IconButton
          label={theme.resolved === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          onClick={() => theme.setTheme(theme.resolved === "dark" ? "light" : "dark")}
          // Pages with their own actions are tight on phones; the theme is also in the profile menu.
          className={cn(actions && "hidden sm:inline-grid")}
        >
          {theme.resolved === "dark" ? <Sun /> : <Moon />}
        </IconButton>
        {onNewChat && (
          <IconButton label="New chat" onClick={onNewChat} className="md:hidden">
            <SquarePen />
          </IconButton>
        )}
      </div>
    </header>
  );
}
