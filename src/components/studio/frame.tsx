"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { createPortal } from "react-dom";
import { Bookmark, Ellipsis, Keyboard, Menu as MenuIcon, Moon, PanelLeftClose, PanelLeftOpen, Search, Settings2, SquarePen, Sun } from "lucide-react";
import { useApp } from "@/components/layout/app-context";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { cn } from "@/lib/utils";
import { CommandPalette, type Command } from "./command-palette";
import { isMacPlatform, isTypingTarget, shortcut, shortcutFor, shortcutKeys } from "@/lib/shortcuts";
import { ArchivedDialog, DeleteDialog, MoveChatDialog, PromptsDialog, SettingsDialog, ShortcutsDialog } from "./dialogs";
import { downloadConversation, localHistory, serverHistory, type ConvSummary, type HistoryStore } from "./history";
import { useFeedback, useSavedPrompts, useSettings, useTheme, type Feedback, type StudioSettings } from "./prefs";
import { forgetPlace, ModeSwitch, rememberPlace } from "./mode-switch";
import { sectionFor } from "./nav";
import { Sidebar } from "./sidebar";
import { IconButton, iconButtonClass, Menu, MenuItem, MenuSeparator, OrbisMark } from "./ui";

type FrameEvent = "new-chat" | "use-prompt" | "renamed" | "moved";

interface StudioContext {
  theme: ReturnType<typeof useTheme>;
  settings: StudioSettings;
  /** General chat history (agent conversations are kept separately). */
  history: { store: HistoryStore; refresh: () => Promise<void> };
  /** The recent chats the sidebar shows (null while loading). */
  conversations: ConvSummary[] | null;
  addPrompt: (text: string) => boolean;
  feedback: Record<string, Feedback>;
  giveFeedback: (id: string, f: Feedback) => void;
  openSidebar: () => void;
  openSettings: () => void;
  openPrompts: () => void;
  /** Where pages put their title (centre of the top bar) and their actions (right). */
  slots: { center: HTMLElement | null; right: HTMLElement | null };
  notify: (text: string) => void;
  /** Subscribe to frame events (new chat, saved prompt chosen, chat renamed). */
  on: <T = unknown>(event: FrameEvent, cb: (detail: T) => void) => () => void;
  /** A saved prompt chosen while no composer was on screen. */
  takePendingPrompt: () => string | null;
  /** Open a new chat with `text` in the box (not sent). */
  startChatWith: (text: string) => void;
  /** Add commands to the palette while the page is open; returns a function that removes them. */
  addCommands: (key: string, commands: Command[]) => () => void;
  openPalette: () => void;
  openShortcuts: () => void;
}

/** Where typed text goes on this page (the chat's or Code's message box), if anywhere. */
const COMPOSER = "#studio-input, textarea[data-composer]";
function focusComposer(): boolean {
  const el = document.querySelector<HTMLTextAreaElement>(COMPOSER);
  if (!el || el.disabled) return false;
  el.focus();
  el.setSelectionRange(el.value.length, el.value.length);
  return true;
}

const noSubscribe = () => () => {};

/** A page's own palette commands, while it's open (e.g. the chat's "Copy the last reply"). */
export function usePageCommands(key: string, commands: Command[]) {
  const { addCommands } = useStudio();
  useEffect(() => addCommands(key, commands), [addCommands, key, commands]);
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
  const { prompts, add: addPrompt, remove: removePrompt, update: updatePrompt, duplicate: duplicatePrompt } = useSavedPrompts();
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
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const mac = useSyncExternalStore(
    noSubscribe,
    () => isMacPlatform(navigator.platform),
    () => false,
  );
  const [pageCommands, setPageCommands] = useState<Record<string, Command[]>>({});
  const addCommands = useCallback((key: string, commands: Command[]) => {
    setPageCommands((m) => ({ ...m, [key]: commands }));
    return () =>
      setPageCommands((m) => {
        if (m[key] !== commands) return m;
        const next = { ...m };
        delete next[key];
        return next;
      });
  }, []);
  const [toDelete, setToDelete] = useState<ConvSummary | null>(null);
  const [toMove, setToMove] = useState<ConvSummary | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [toast, setToast] = useState<{ text: string; key: number } | null>(null);
  const notify = useCallback((text: string) => setToast({ text, key: Date.now() }), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  // The home is a chat surface too: a conversation started there continues there.
  const onHome = pathname === "/home";
  const onChat = pathname === "/chat" || onHome;
  const activeChat = onChat ? params.get("c") : null;

  const newChat = useCallback(() => {
    setMobileOpen(false);
    if (onChat) emit("new-chat");
    router.push(onHome ? "/home?new=1" : "/chat?new=1");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onChat, onHome, router]);

  // Where Chat and Code were last left, for the top bar's switch.
  useEffect(() => rememberPlace(pathname, params), [pathname, params]);

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

  const toggleSidebar = useCallback(() => {
    if (window.matchMedia("(min-width: 768px)").matches) setRailStored(collapsed ? "0" : "1");
    else setMobileOpen((o) => !o);
  }, [collapsed, setRailStored]);

  // Global shortcuts (see lib/shortcuts): single keys only when not typing, and never while another dialog is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const id = shortcutFor(e, mac, isTypingTarget(document.activeElement));
      if (!id) return;
      const dialogOpen = !!document.querySelector('[role="dialog"][aria-modal="true"], dialog[open]');
      if (id === "palette") {
        e.preventDefault();
        setShortcutsOpen(false);
        setPaletteOpen((o) => !o);
      } else if (dialogOpen) {
        return;
      } else if (id === "new-chat") {
        e.preventDefault();
        newChat();
      } else if (id === "sidebar") {
        e.preventDefault();
        toggleSidebar();
      } else if (id === "focus-composer") {
        if (focusComposer()) e.preventDefault();
      } else if (id === "shortcuts") {
        e.preventDefault();
        setShortcutsOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mac, newChat, toggleSidebar]);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const close = () => mq.matches && setMobileOpen(false);
    mq.addEventListener("change", close);
    return () => mq.removeEventListener("change", close);
  }, []);

  // The top bar's two page areas (set once mounted; pages render into them).
  const [center, setCenter] = useState<HTMLElement | null>(null);
  const [right, setRight] = useState<HTMLElement | null>(null);

  const value: StudioContext = {
    slots: { center, right },
    openSettings: () => {
      setMobileOpen(false);
      setSettingsOpen(true);
    },
    openPrompts: () => {
      setMobileOpen(false);
      setPromptsOpen(true);
    },
    theme,
    settings,
    history: { store, refresh },
    conversations,
    addPrompt,
    feedback,
    giveFeedback,
    openSidebar: () => setMobileOpen(true),
    notify,
    on,
    takePendingPrompt,
    startChatWith: (text: string) => {
      pendingPrompt.current = text;
      router.push("/chat?new=1");
    },
    addCommands,
    openPalette: () => setPaletteOpen(true),
    openShortcuts: () => setShortcutsOpen(true),
  };

  return (
    <Ctx value={value}>
      <div className="studio fixed inset-x-0 top-[var(--app-top,0px)] flex h-[var(--app-h,100dvh)] flex-col overflow-hidden">
        <div className="studio-ambient" aria-hidden />

        {/* One slim bar across the top: sidebar, Orbis and the Chat / Code switch; the page's title; the page's actions. */}
        <header className="relative z-20 flex h-12 shrink-0 items-center gap-2 border-b border-s-line px-2 pt-[env(safe-area-inset-top)] sm:px-3">
          <div className="flex flex-1 basis-0 items-center gap-1">
            <IconButton label="Open sidebar" onClick={() => setMobileOpen(true)} className="md:hidden">
              <MenuIcon />
            </IconButton>
            <IconButton label={collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={() => setRailStored(collapsed ? "0" : "1")} className="hidden md:inline-grid">
              {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
            </IconButton>
            <Link href="/home" aria-label="Orbis — home" className="flex shrink-0 items-center gap-2 rounded-lg px-1.5 py-1 transition hover:opacity-80">
              <OrbisMark className="h-6 w-6 text-s-ink" />
              <span className="hidden text-[13.5px] font-semibold tracking-[0.22em] lg:inline">ORBIS</span>
            </Link>
            <ModeSwitch className="ml-1" />
          </div>
          <div ref={setCenter} className="flex min-w-0 max-w-[50%] shrink items-center justify-center gap-2" />
          <div className="flex flex-1 basis-0 items-center justify-end gap-0.5">
            <div ref={setRight} className="flex items-center justify-end gap-0.5" />
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              aria-label="Search and commands"
              aria-keyshortcuts={mac ? "Meta+K" : "Control+K"}
              title={`Search and commands (${shortcutKeys(shortcut("palette"), mac).join(mac ? "" : "+")})`}
              className={cn(iconButtonClass(), "order-first")}
            >
              <Search />
            </button>
          </div>
        </header>

        <div className="relative flex min-h-0 flex-1">

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
                  if (c.id === activeChat) router.replace(onHome ? "/home?new=1" : "/chat?new=1");
                  await refresh();
                  notify("Chat archived");
                }
              : undefined
          }
          onPin={
            store.pin
              ? async (c) => {
                  try {
                    await store.pin!(c.id, !c.pinned);
                  } catch (e) {
                    notify(`Couldn’t ${c.pinned ? "unpin" : "pin"} the chat: ${(e as Error).message}`);
                    return;
                  }
                  await refresh();
                  notify(c.pinned ? "Unpinned" : "Pinned to the top");
                }
              : undefined
          }
          onMove={store.move ? (c) => setToMove(c) : undefined}
          onDownload={async (c) => {
            try {
              await downloadConversation(store, c);
            } catch (e) {
              notify(`Couldn’t download the chat: ${(e as Error).message}`);
            }
          }}
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
        </div>

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
            if (onChat) router.replace(onHome ? "/home?new=1" : "/chat?new=1");
            void refresh();
          }}
        />
        <PromptsDialog
          open={promptsOpen}
          onClose={() => setPromptsOpen(false)}
          prompts={prompts}
          onAdd={addPrompt}
          onRemove={removePrompt}
          onUpdate={updatePrompt}
          onDuplicate={duplicatePrompt}
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
          mac={mac}
          pageCommands={Object.values(pageCommands).flat()}
          actions={{
            onNewChat: newChat,
            onOpenSettings: () => setSettingsOpen(true),
            onOpenPrompts: () => setPromptsOpen(true),
            onOpenShortcuts: () => setShortcutsOpen(true),
            onToggleSidebar: toggleSidebar,
            onFocusComposer: paletteOpen && typeof document !== "undefined" && document.querySelector(COMPOSER) ? () => requestAnimationFrame(() => focusComposer()) : null,
            onSearchChats: store.search ?? (async () => []),
            setTheme: theme.setTheme,
          }}
        />
        <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} mac={mac} />
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
        {store.move && (
          <MoveChatDialog
            conv={toMove}
            onClose={() => setToMove(null)}
            onMove={async (c, projectId) => {
              await store.move!(c.id, projectId);
              emit("moved", { id: c.id, projectId });
              await refresh();
            }}
          />
        )}
        <DeleteDialog
          conv={toDelete}
          onClose={() => setToDelete(null)}
          onConfirm={async (c) => {
            await store.remove(c.id);
            forgetPlace("chat", `/chat?c=${encodeURIComponent(c.id)}`);
            if (c.id === activeChat) router.replace(onHome ? "/home?new=1" : "/chat?new=1");
            await refresh();
            notify("Chat deleted");
          }}
        />
      </div>
    </Ctx>
  );
}

/**
 * A page's part of the top bar: its title (shown in the centre) and its
 * actions (on the right, followed by a ⋯ menu with the page's less-used
 * actions and the app's own). Rendered into the frame's top bar.
 */
export function StudioHeader({ children, actions, menu, onNewChat }: { children?: ReactNode; actions?: ReactNode; menu?: ReactNode; onNewChat?: () => void }) {
  const { slots, theme, openSettings, openPrompts, openShortcuts } = useStudio();
  return (
    <>
      {slots.center && createPortal(<div className="flex min-w-0 items-center gap-2 text-[14px]">{children}</div>, slots.center)}
      {slots.right &&
        createPortal(
          <>
            {actions}
            {onNewChat && (
              <IconButton label="New chat" onClick={onNewChat} className="md:hidden">
                <SquarePen />
              </IconButton>
            )}
            <Menu label="More" align="end" width={240} buttonLabel="More actions" buttonTitle="More" buttonClassName={iconButtonClass()} button={<Ellipsis />}>
              {menu}
              {menu && <MenuSeparator />}
              <MenuItem icon={theme.resolved === "dark" ? <Sun /> : <Moon />} onClick={() => theme.setTheme(theme.resolved === "dark" ? "light" : "dark")}>
                {theme.resolved === "dark" ? "Light theme" : "Dark theme"}
              </MenuItem>
              <MenuItem icon={<Bookmark />} onClick={openPrompts}>
                Saved prompts
              </MenuItem>
              <MenuItem icon={<Settings2 />} onClick={openSettings}>
                Settings
              </MenuItem>
              <MenuItem icon={<Keyboard />} onClick={openShortcuts} className="max-md:hidden">
                Keyboard shortcuts
              </MenuItem>
            </Menu>
          </>,
          slots.right,
        )}
    </>
  );
}
