"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Archive, Bookmark, Link2, ChevronDown, Code2, CreditCard, Download, Ellipsis, FolderInput, Gauge, LayoutGrid, FolderPlus, LogIn, LogOut, Monitor, Moon, Pencil, Pin, PinOff, Search, Settings2, SquarePen, Sun, Trash2, X } from "lucide-react";
import type { AppUser } from "@/components/layout/app-context";
import { cn } from "@/lib/utils";
import { groupByDate, type ConvSummary } from "./history";
import { activeEntryFor, sidebarFor, WORKSPACE_SECTIONS, type NavEntry, type Section } from "./nav";
import { SidebarUsage, useUsageGlance } from "./usage";
import { useInbox } from "./inbox";
import type { ThemePref } from "./prefs";
import { IconButton, iconButtonClass, Kbd, Menu, MenuItem, MenuSeparator, Segmented } from "./ui";
import { InfinityMark } from "@/components/brand/infinity";
import { wordmarkFont } from "@/components/brand/fonts";
import { forgetAccountData } from "@/lib/sign-out";

export interface SidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  /** Which workspace is open, for the nav's active state. */
  section: Section;
  conversations: ConvSummary[] | null;
  listError: string | null;
  activeId: string | null;
  onNewChat: () => void;
  onRename: (id: string, title: string) => Promise<void>;
  /** Searches all of the user's chats on the server (signed in); otherwise only the loaded list is filtered. */
  onSearch?: (q: string) => Promise<ConvSummary[]>;
  onRequestDelete: (c: ConvSummary) => void;
  /** Signed-in history only. */
  onArchive?: (c: ConvSummary) => void;
  /** Signed-in history only. */
  onPin?: (c: ConvSummary) => void;
  /** Signed-in history only: choose a project for the chat. */
  onMove?: (c: ConvSummary) => void;
  /** Save the chat as a Markdown file. */
  onDownload?: (c: ConvSummary) => void;
  /** Signed-in chats only: a read-only link. */
  onShare?: (c: ConvSummary) => void;
  onOpenPrompts: () => void;
  onOpenSettings: () => void;
  user: AppUser | null;
  accountsEnabled: boolean;
  historyKind: "server" | "local";
  theme: { pref: ThemePref; setTheme: (p: ThemePref) => void };
  searchRef: RefObject<HTMLInputElement | null>;
}

const noSubscribe = () => () => {};

export function Sidebar({ searchRef, ...p }: SidebarProps) {
  const [query, setQuery] = useState("");
  const mac = useSyncExternalStore(
    noSubscribe,
    () => /Mac|iPhone|iPad/.test(navigator.platform),
    () => false,
  );

  // The loaded list holds only recent chats; signed-in searches also ask the server (debounced).
  const [found, setFound] = useState<{ q: string; items: ConvSummary[] } | null>(null);
  const onSearch = p.onSearch;
  useEffect(() => {
    const q = query.trim();
    if (!q || !onSearch) return;
    let alive = true;
    const t = setTimeout(() => {
      onSearch(q)
        .then((items) => alive && setFound({ q, items }))
        .catch(() => {
          /* the local filter still shows matches among recent chats */
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query, onSearch, p.conversations]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (p.conversations ?? []).filter((c) => !q || c.title.toLowerCase().includes(q));
    if (!q) {
      // Pinned chats stay at the top, whatever their age.
      const pinned = list.filter((c) => c.pinned);
      return [...(pinned.length ? [{ label: "Pinned", items: pinned }] : []), ...groupByDate(list.filter((c) => !c.pinned))];
    }
    if (found?.q.toLowerCase() !== q) return groupByDate(list);
    // The server's results also match message text, with an excerpt.
    const seen = new Set(found.items.map((c) => c.id));
    const merged = [...found.items, ...list.filter((c) => !seen.has(c.id))].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return groupByDate(merged);
  }, [p.conversations, query, found]);
  const searching = !!onSearch && !!query.trim() && found?.q.toLowerCase() !== query.trim().toLowerCase();

  // On phones the sidebar is a modal drawer: focus moves into it when it opens and back when it closes,
  // and while it's closed (off screen) it can't be reached with Tab.
  const phone = useSyncExternalStore(subscribePhone, readPhone, () => false);
  const drawer = phone && p.mobileOpen;
  const asideRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!drawer) return;
    const aside = asideRef.current;
    openerRef.current = document.activeElement as HTMLElement | null;
    aside?.querySelector<HTMLElement>("[data-drawer-close]")?.focus();
    return () => {
      const opener = openerRef.current;
      if (opener?.isConnected && (!document.activeElement || document.activeElement === document.body || aside?.contains(document.activeElement))) opener.focus();
    };
  }, [drawer]);

  const rail = p.collapsed;
  const usage = useUsageGlance(!!p.user);
  const inbox = useInbox(!!p.user);
  // In Code, the sidebar is about projects; everywhere else, about chats.
  const inCode = p.section === "code";
  // Chat and Code are switched in the top bar, not here.
  const entries = sidebarFor(!!p.user?.isAdmin);
  const current = activeEntryFor(p.section);
  // More: remembered between visits (read after hydration), and always open while on one of its pages.
  const savedMore = useSyncExternalStore(subscribeMore, readMore, () => false);
  const inMore = entries.some((e) => e.group === "tools" && e.id === current);
  const [closedOn, setClosedOn] = useState<Section | null>(null);
  const showMore = savedMore || (inMore && closedOn !== p.section);
  const setMoreOpen = (open: boolean) => {
    setClosedOn(open ? null : p.section);
    try {
      localStorage.setItem(MORE_KEY, open ? "1" : "0");
    } catch {
      /* not remembered */
    }
    moreListeners.forEach((l) => l());
  };
  const expandAndSearch = () => {
    p.onToggleCollapsed();
    requestAnimationFrame(() => searchRef.current?.focus());
  };

  return (
    <>
      <div
        aria-hidden
        onClick={p.onCloseMobile}
        className={cn(
          "fixed inset-0 z-30 bg-[var(--s-scrim)] backdrop-blur-[2px] transition-opacity duration-300 md:hidden",
          p.mobileOpen ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />
      <aside
        ref={asideRef}
        aria-label="Sidebar"
        role={drawer ? "dialog" : undefined}
        aria-modal={drawer || undefined}
        inert={phone && !p.mobileOpen}
        onKeyDown={
          drawer
            ? (e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  p.onCloseMobile();
                } else if (e.key === "Tab") trapTab(e);
              }
            : undefined
        }
        className={cn(
          "glass max-md:!bg-[var(--s-glass-menu)] fixed inset-y-0 left-0 z-40 flex w-[min(300px,86vw)] flex-col overflow-hidden border-0 border-r !shadow-none transition-[transform,width] duration-300 ease-[cubic-bezier(.2,.7,.2,1)]",
          "pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] md:relative md:z-auto md:translate-x-0",
          p.mobileOpen ? "translate-x-0" : "-translate-x-full",
          rail ? "md:w-[68px]" : "md:w-[248px] lg:w-[276px]",
        )}
      >
        {/* On phones the sidebar is a drawer over the top bar: it has its own heading and close button. (On larger screens, the top bar holds Orbis and the collapse button.) */}
        <div className="flex h-12 shrink-0 items-center gap-2 px-3 md:hidden">
          <Link href="/home" onClick={p.onCloseMobile} className="flex min-w-0 items-center gap-2.5 rounded-xl px-1.5 py-1 transition hover:opacity-80" aria-label="Orbis — home">
            <InfinityMark wide weight={6.5} className="h-[22px] w-[38px]" />
            <span className={cn(wordmarkFont.className, "text-[20px] font-semibold leading-none tracking-[-0.01em]")}>orbis</span>
          </Link>
          <IconButton label="Close sidebar" onClick={p.onCloseMobile} className="ml-auto" data-drawer-close="">
            <X />
          </IconButton>
        </div>
        <div className="hidden h-2 shrink-0 md:block" aria-hidden />

        {/* Primary actions */}
        <div className={cn("flex shrink-0 flex-col gap-1 px-3 pb-2", rail && "md:items-center md:px-0")}>
          {rail ? (
            inCode ? (
              <Link href="/code?new=1" onClick={p.onCloseMobile} aria-label="New project" title="New project" className={cn(iconButtonClass(), "hidden md:inline-grid")}>
                <FolderPlus />
              </Link>
            ) : (
              <>
                <IconButton label="New chat" onClick={p.onNewChat} className="hidden md:inline-grid">
                  <SquarePen />
                </IconButton>
                <IconButton label="Search chats" onClick={expandAndSearch} className="hidden md:inline-grid">
                  <Search />
                </IconButton>
              </>
            )
          ) : null}
          {inCode ? (
            <Link
              href="/code?new=1"
              onClick={p.onCloseMobile}
              className={cn("glass group flex h-10 items-center gap-2.5 rounded-xl px-3 text-[14px] font-medium transition hover:border-s-line-strong hover:bg-s-glass-strong active:scale-[0.99]", rail && "md:hidden")}
            >
              <FolderPlus className="h-[17px] w-[17px] text-s-ink-2 transition group-hover:text-s-ink" />
              New project
            </Link>
          ) : (
          <div className={cn("flex flex-col gap-1", rail && "md:hidden")}>
            <button
              type="button"
              onClick={p.onNewChat}
              className="glass group flex h-10 items-center gap-2.5 rounded-xl px-3 text-[14px] font-medium transition hover:border-s-line-strong hover:bg-s-glass-strong active:scale-[0.99]"
            >
              <SquarePen className="h-[17px] w-[17px] text-s-ink-2 transition group-hover:text-s-ink" />
              New chat
            </button>
            <div className="relative mt-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-s-ink-3" />
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setQuery("")}
                placeholder="Search chats"
                aria-label="Search chats"
                className="h-9 w-full rounded-xl border border-transparent bg-s-hover pl-9 pr-12 text-[13.5px] text-s-ink outline-none transition placeholder:text-s-ink-3 focus:border-s-line-strong focus:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--s-ring)] [&::-webkit-search-cancel-button]:hidden"
              />
              <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 [@media(hover:none)]:hidden">
                <Kbd>{mac ? "⌘K" : "Ctrl K"}</Kbd>
              </span>
            </div>
          </div>
          )}
        </div>

        {/* The links and the history scroll together, so nothing is cut off on short screens or with Tools open. */}
        <div className="s-scroll s-scroll-glass min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <nav aria-label="Main" className={cn("px-3 pb-2", rail && "md:px-0")}>
            <ul className={cn("flex flex-col gap-0.5", rail && "md:items-center")}>
              {entries
                .filter((e) => e.group === "main")
                .map((e) =>
                  e.id === "cyber" || e.id === "web" ? (
                    <WorkspaceNav key={e.id} entry={e} rail={rail} section={p.section} onNavigate={p.onCloseMobile} />
                  ) : (
                    <NavLink key={e.id} entry={e} rail={rail} active={current === e.id} onClick={p.onCloseMobile} />
                  ),
                )}
              {/* Tools wait behind one toggle (always open on the page of one of them; icons stay in the narrow rail). */}
              <li className={cn(rail && "md:hidden")}>
                <button
                  type="button"
                  onClick={() => setMoreOpen(!showMore)}
                  aria-expanded={showMore}
                  aria-controls="nav-more"
                  title="Arena, Council, Connectors, Discover and saved prompts"
                  className="flex h-9 w-full items-center gap-3 rounded-xl px-3 text-[13.5px] text-s-ink-2 transition duration-200 hover:bg-s-hover hover:text-s-ink [&_svg]:h-[17px] [&_svg]:w-[17px] [&_svg]:shrink-0"
                >
                  <LayoutGrid />
                  <span className="flex-1 text-left">Tools</span>
                  <ChevronDown className={cn("transition", showMore && "rotate-180")} aria-hidden />
                </button>
              </li>
            </ul>
            <ul id="nav-more" className={cn("flex flex-col gap-0.5", !showMore && "hidden", rail && "md:flex md:items-center", showMore && !rail && "mt-0.5 border-l border-s-line pl-1.5 ml-3")}>
              {entries
                .filter((e) => e.group === "tools")
                .map((e) => (
                  <NavLink key={e.id} entry={e} rail={rail} active={current === e.id} onClick={p.onCloseMobile} />
                ))}
              <NavItem rail={rail} icon={<Bookmark />} label="Saved prompts" onClick={p.onOpenPrompts} />
            </ul>
            {entries.some((e) => e.group === "admin") && (
              <div className="mt-2">
                <h2 className={cn("px-3 pb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-s-ink-3", rail && "md:sr-only")}>Admin</h2>
                <ul className={cn("flex flex-col gap-0.5", rail && "md:items-center")}>
                  {entries
                    .filter((e) => e.group === "admin")
                    .map((e) => (
                      <NavLink key={e.id} entry={e} rail={rail} active={current === e.id} onClick={p.onCloseMobile} />
                    ))}
                </ul>
              </div>
            )}
            <ul className={cn("mt-2 flex flex-col gap-0.5", rail && "md:items-center")}>
              <NavItem rail={rail} icon={<Settings2 />} label="Settings" onClick={p.onOpenSettings} />
            </ul>
          </nav>

          <div className={cn("mx-4 h-px bg-s-line", rail && "md:hidden")} />

          {/* History */}
          <div className={cn("px-3 pb-4 pt-2", rail && "md:hidden")}>
            {inCode ? (
              <RecentProjects signedIn={!!p.user} onNavigate={p.onCloseMobile} />
            ) : p.listError ? (
              <p className="px-3 py-2 text-[13px] text-s-ink-3">History couldn’t load: {p.listError}</p>
            ) : p.conversations === null ? (
              <div className="space-y-2.5 px-3 pt-3" role="status" aria-label="Loading chats">
                {[70, 88, 56, 80].map((w, i) => (
                  <div key={i} className="s-skeleton h-3.5" style={{ width: `${w}%` }} />
                ))}
              </div>
            ) : p.conversations.length === 0 ? (
              <p className="px-3 py-3 text-[13px] leading-relaxed text-s-ink-3">
                No chats yet.
                {p.historyKind === "local" && " As a guest, your chats are kept in this browser only."}
              </p>
            ) : groups.length === 0 ? (
              <p className="px-3 py-3 text-[13px] text-s-ink-3">{searching ? "Searching…" : `No chats match “${query}”.`}</p>
            ) : (
              groups.map((g) => (
                <section key={g.label} className="mt-3 first:mt-1">
                  <h2 className="px-3 pb-1 text-[11.5px] font-medium text-s-ink-3">{g.label}</h2>
                  <ul className="flex flex-col gap-px">
                    {g.items.map((c) => (
                      <HistoryItem
                        key={`${c.id}:${c.title}`}
                        conv={c}
                        active={c.id === p.activeId}
                        onNavigate={p.onCloseMobile}
                        onRename={p.onRename}
                        onRequestDelete={p.onRequestDelete}
                        onArchive={p.onArchive}
                        onPin={p.onPin}
                        onMove={p.onMove}
                        onDownload={p.onDownload}
                        onShare={p.onShare}
                        showSnippet={!!query.trim()}
                      />
                    ))}
                  </ul>
                </section>
              ))
            )}
            {!inCode && p.historyKind === "server" && !!p.conversations?.length && !query.trim() && (
              <Link href="/history" onClick={p.onCloseMobile} className="mt-3 flex h-8 items-center rounded-xl px-3 text-[12.5px] text-s-ink-3 transition hover:bg-s-hover hover:text-s-ink">
                All conversations
              </Link>
            )}
          </div>
        </div>

        {/* The week's usage at a glance, for signed-in accounts with an allowance. */}
        {usage && <SidebarUsage usage={usage} rail={rail} onNavigate={p.onCloseMobile} />}
        {/* Pinned above the account, outside the scrolling list, so it's always in the same place. */}
        {entries.some((e) => e.group === "footer") && (
          <nav aria-label="Activity" className={cn("shrink-0 border-t border-s-line px-3 pt-2", rail && "md:px-0")}>
            <ul className={cn("flex flex-col gap-0.5", rail && "md:items-center")}>
              {entries
                .filter((e) => e.group === "footer")
                .map((e) => (
                  <NavLink key={e.id} entry={e} rail={rail} active={current === e.id} onClick={p.onCloseMobile} badge={e.id === "activity" && inbox ? inbox.waiting + inbox.unread : 0} />
                ))}
            </ul>
          </nav>
        )}
        <ProfileMenu {...p} rail={rail} />
      </aside>
    </>
  );
}

/** Below the md breakpoint the sidebar is a drawer. */
const PHONE = "(max-width: 767.98px)";
function subscribePhone(l: () => void) {
  const mq = window.matchMedia(PHONE);
  mq.addEventListener("change", l);
  return () => mq.removeEventListener("change", l);
}
const readPhone = () => window.matchMedia(PHONE).matches;

/** Tab and Shift+Tab stay inside the open drawer. */
function trapTab(e: KeyboardEvent<HTMLElement>) {
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])")].filter((el) => el.offsetParent !== null);
  if (!items.length) return;
  const first = items[0]!;
  const last = items[items.length - 1]!;
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

const MORE_KEY = "orbis.nav.more";
const moreListeners = new Set<() => void>();
function subscribeMore(l: () => void) {
  moreListeners.add(l);
  return () => moreListeners.delete(l);
}
function readMore(): boolean {
  try {
    return localStorage.getItem(MORE_KEY) === "1";
  } catch {
    return false;
  }
}

function NavLink({ entry, rail, active, onClick, badge = 0 }: { entry: NavEntry; rail: boolean; active: boolean; onClick: () => void; badge?: number }) {
  const Icon = entry.icon;
  return <NavItem rail={rail} icon={<Icon />} label={entry.label} href={entry.href} active={active} onClick={onClick} hint={entry.hint} badge={badge} />;
}

/** A workspace section (Cybersecurity, Website Builder): its own link plus a collapsible submenu. */
function WorkspaceNav({ entry, rail, section, onNavigate }: { entry: NavEntry; rail: boolean; section: Section; onNavigate: () => void }) {
  const pathname = usePathname();
  const ws = WORKSPACE_SECTIONS.find((w) => w.id === entry.id)!;
  const onSection = section === entry.id;
  const Icon = entry.icon;

  // In the narrow rail the submenu can't show, so the icon just links to the dashboard.
  if (rail) return <NavItem rail icon={<Icon />} label={entry.label} href={ws.base} active={onSection} hint={entry.hint} />;

  return (
    <li>
      <div className={cn("flex items-center rounded-xl transition", onSection && "bg-s-hover")}>
        <Link
          href={ws.base}
          onClick={onNavigate}
          aria-current={onSection ? "page" : undefined}
          className={cn("flex h-9 flex-1 items-center gap-3 rounded-xl px-3 text-[13.5px] transition hover:text-s-ink [&_svg]:h-[17px] [&_svg]:w-[17px]", onSection ? "font-medium text-s-ink" : "text-s-ink-2")}
        >
          <Icon />
          <span className="flex-1">{entry.label}</span>
        </Link>
      </div>
      {ws.children.length > 1 && (
        <ul id={`nav-${entry.id}`} className="ml-3 mt-0.5 flex flex-col gap-0.5 border-l border-s-line pl-1.5">
          {ws.children.slice(1).map((c) => {
            const active = pathname === c.href || pathname.startsWith(`${c.href}/`);
            return (
              <li key={c.href}>
                <Link
                  href={c.href}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  className={cn("flex h-8 items-center rounded-lg px-3 text-[13px] transition hover:bg-s-hover hover:text-s-ink", active ? "bg-s-hover text-s-ink" : "text-s-ink-2")}
                >
                  {c.label}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

/** In Code, the sidebar lists the user's projects (most recently edited first) instead of chats. */
function RecentProjects({ signedIn, onNavigate }: { signedIn: boolean; onNavigate: () => void }) {
  const pathname = usePathname();
  const [projects, setProjects] = useState<{ id: string; name: string }[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!signedIn) return;
    let alive = true;
    fetch("/api/code/projects")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { projects: { id: string; name: string }[] }) => alive && setProjects(j.projects))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
    // Re-read on navigation so new and renamed projects show up.
  }, [signedIn, pathname]);
  if (!signedIn) return <p className="px-3 py-3 text-[13px] leading-relaxed text-s-ink-3">Sign in to keep projects.</p>;
  if (failed) return <p className="px-3 py-3 text-[13px] text-s-ink-3">Projects couldn’t load.</p>;
  if (!projects)
    return (
      <div className="space-y-2.5 px-3 pt-3" role="status" aria-label="Loading projects">
        {[70, 56, 80].map((w, i) => (
          <div key={i} className="s-skeleton h-3.5" style={{ width: `${w}%` }} />
        ))}
      </div>
    );
  if (!projects.length) return <p className="px-3 py-3 text-[13px] leading-relaxed text-s-ink-3">No projects yet.</p>;
  return (
    <section className="mt-1">
      <h2 className="px-3 pb-1 text-[11.5px] font-medium text-s-ink-3">Projects</h2>
      <ul className="flex flex-col gap-px">
        {projects.slice(0, 30).map((pr) => {
          const active = pathname === `/code/${pr.id}`;
          return (
            <li key={pr.id}>
              <Link
                href={`/code/${pr.id}`}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cn("flex h-9 items-center gap-2 rounded-xl px-3 text-[13.5px] transition hover:bg-s-hover", active ? "bg-s-hover text-s-ink" : "text-s-ink-2")}
              >
                <Code2 className="h-3.5 w-3.5 shrink-0 text-s-ink-3" />
                <span className="truncate">{pr.name}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function NavItem({ rail, icon, label, href, onClick, active, hint, badge = 0 }: { rail: boolean; icon: ReactNode; label: string; href?: string; onClick?: () => void; active?: boolean; hint?: string; badge?: number }) {
  const cls = cn(
    "flex h-9 items-center gap-3 rounded-xl px-3 text-[13.5px] text-s-ink-2 transition duration-200 hover:bg-s-hover hover:text-s-ink active:scale-[0.98] [&_svg]:h-[17px] [&_svg]:w-[17px] [&_svg]:shrink-0",
    active && "bg-s-hover font-medium text-s-ink",
    rail && "md:w-9 md:justify-center md:px-0",
  );
  // A count of things for the user (Activity: tasks waiting for them and new updates).
  const count = badge > 99 ? "99+" : String(badge);
  const body = (
    <>
      <span className="relative inline-flex">
        {icon}
        {badge > 0 && rail && <span aria-hidden className="absolute -right-1 -top-1 hidden h-2 w-2 rounded-full bg-s-accent md:block" />}
      </span>
      <span className={cn(rail && "md:sr-only")}>{label}</span>
      {badge > 0 && (
        <span className={cn("ml-auto rounded-full bg-s-accent px-1.5 text-[11px] font-semibold leading-[18px] text-s-accent-ink", rail && "md:sr-only")}>
          {count}
          <span className="sr-only"> need{badge === 1 ? "s" : ""} your attention</span>
        </span>
      )}
    </>
  );
  return (
    <li>
      {href ? (
        <Link href={href} onClick={onClick} className={cls} aria-current={active ? "page" : undefined} title={rail ? `${label} — ${hint ?? ""}`.replace(/ — $/, "") : hint}>
          {body}
        </Link>
      ) : (
        <button type="button" onClick={onClick} className={cn(cls, "w-full")} aria-current={active ? "page" : undefined} title={rail ? label : undefined}>
          {body}
        </button>
      )}
    </li>
  );
}

function HistoryItem({
  conv,
  active,
  onNavigate,
  onRename,
  onRequestDelete,
  onArchive,
  onPin,
  onMove,
  onDownload,
  onShare,
  showSnippet,
}: {
  conv: ConvSummary;
  active: boolean;
  onNavigate: () => void;
  onRename: (id: string, title: string) => Promise<void>;
  onRequestDelete: (c: ConvSummary) => void;
  onArchive?: (c: ConvSummary) => void;
  onPin?: (c: ConvSummary) => void;
  onMove?: (c: ConvSummary) => void;
  onDownload?: (c: ConvSummary) => void;
  onShare?: (c: ConvSummary) => void;
  showSnippet?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(conv.title);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  // Enter submits and the input's blur follows: only the first commit renames.
  const committing = useRef(false);
  const commit = async () => {
    if (committing.current) return;
    committing.current = true;
    setEditing(false);
    const t = title.trim();
    try {
      if (!t || t === conv.title) return setTitle(conv.title);
      await onRename(conv.id, t.slice(0, 200));
    } catch {
      setTitle(conv.title);
    } finally {
      committing.current = false;
    }
  };

  if (editing) {
    return (
      <li>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void commit();
          }}
        >
          <input
            ref={inputRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setTitle(conv.title);
                setEditing(false);
              }
            }}
            maxLength={200}
            aria-label="Chat title"
            className="h-9 w-full rounded-xl border border-s-line-strong bg-s-glass-strong px-3 text-[13.5px] text-s-ink outline-none focus-visible:outline-none"
          />
        </form>
      </li>
    );
  }

  return (
    <li className={cn("group relative flex items-center rounded-xl transition-colors", active ? "bg-s-glass-strong shadow-[var(--s-shadow-sm)]" : "hover:bg-s-hover")}>
      <Link
        href={`/chat?c=${conv.id}`}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        className={cn("min-w-0 flex-1 py-2 pl-3 pr-9 text-[13.5px]", active ? "text-s-ink" : "text-s-ink-2 group-hover:text-s-ink")}
        title={conv.project_name ? `${conv.title} · ${conv.project_name}` : conv.title}
      >
        <span className="block truncate">{conv.title}</span>
        {showSnippet && conv.snippet && <span className="mt-0.5 line-clamp-2 block text-[12px] leading-snug text-s-ink-3">{conv.snippet}</span>}
      </Link>
      <div className="absolute right-1 top-1/2 -translate-y-1/2">
        <Menu
          label={`Actions for ${conv.title}`}
          align="start"
          side="auto"
          width={200}
          buttonLabel="Chat actions"
          buttonClassName={cn(
            iconButtonClass("sm"),
            "h-7 w-7 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100 [@media(hover:none)]:opacity-100",
          )}
          button={<Ellipsis />}
        >
          {onPin && (
            <MenuItem icon={conv.pinned ? <PinOff /> : <Pin />} onClick={() => onPin(conv)}>
              {conv.pinned ? "Unpin" : "Pin to top"}
            </MenuItem>
          )}
          <MenuItem icon={<Pencil />} onClick={() => setEditing(true)}>
            Rename
          </MenuItem>
          {onMove && (
            <MenuItem icon={<FolderInput />} onClick={() => onMove(conv)}>
              {conv.project_id ? "Change project…" : "Move to project…"}
            </MenuItem>
          )}
          {onShare && (
            <MenuItem icon={<Link2 />} onClick={() => onShare(conv)}>
              Share…
            </MenuItem>
          )}
          {onDownload && (
            <MenuItem icon={<Download />} onClick={() => onDownload(conv)}>
              Download
            </MenuItem>
          )}
          {onArchive && (
            <MenuItem icon={<Archive />} onClick={() => onArchive(conv)}>
              Archive
            </MenuItem>
          )}
          <MenuItem icon={<Trash2 />} danger onClick={() => onRequestDelete(conv)}>
            Delete
          </MenuItem>
        </Menu>
      </div>
    </li>
  );
}

function ProfileMenu(p: Omit<SidebarProps, "searchRef"> & { rail: boolean }) {
  const router = useRouter();
  const signOutRef = useRef<HTMLFormElement>(null);
  const name = p.user?.displayName || p.user?.email?.split("@")[0] || "Guest";
  const initials = name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]!.toUpperCase())
    .join("");
  const sub = p.user ? (p.user.email ?? "Signed in") : p.historyKind === "local" ? "History saved in this browser" : "Not signed in";

  return (
    <div className={cn("shrink-0 border-t border-s-line p-2", p.rail && "md:flex md:justify-center")}>
      <form ref={signOutRef} action="/auth/signout" method="post" hidden />
      <Menu
        label="Account"
        side="top"
        width={264}
        buttonTitle={`Account: ${name}`}
        buttonClassName={cn("flex w-full items-center gap-3 rounded-xl p-2 text-left transition hover:bg-s-hover", p.rail && "md:w-auto")}
        button={
          <>
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-s-accent-soft text-[12px] font-semibold text-s-accent">{initials || "G"}</span>
            <span className={cn("min-w-0 flex-1", p.rail && "md:hidden")}>
              <span className="block truncate text-[13.5px] font-medium">{name}</span>
              <span className="block truncate text-[12px] text-s-ink-3">{sub}</span>
            </span>
          </>
        }
      >
            <div className="px-2.5 pb-2 pt-1.5">
              <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-s-ink-3">Theme</div>
              <Segmented
                label="Theme"
                value={p.theme.pref}
                onChange={p.theme.setTheme}
                options={[
                  { value: "light", label: "Light", icon: <Sun /> },
                  { value: "dark", label: "Dark", icon: <Moon /> },
                  { value: "system", label: "Auto", icon: <Monitor /> },
                ]}
              />
            </div>
            <MenuSeparator />
            <MenuItem
              icon={<Settings2 />}
              hint="Preferences, usage and your account"
              onClick={p.onOpenSettings}
            >
              Settings
            </MenuItem>
            {p.user && (
              <MenuItem icon={<Gauge />} hint="What's left, resets and history" onClick={() => router.push("/usage")}>
                Usage
              </MenuItem>
            )}
            <MenuItem icon={<CreditCard />} hint="Compare plans or upgrade" onClick={() => router.push("/pricing")}>
              Plans and pricing
            </MenuItem>
            {p.accountsEnabled && <MenuSeparator />}
            {p.accountsEnabled &&
              (p.user ? (
                <MenuItem
                  icon={<LogOut />}
                  onClick={() => {
                    forgetAccountData();
                    signOutRef.current?.requestSubmit();
                  }}
                >
                  Sign out
                </MenuItem>
              ) : (
                <MenuItem
                  icon={<LogIn />}
                  hint="Keep your history across devices"
                  onClick={() => router.push("/login?next=/home")}
                >
                  Sign in
                </MenuItem>
              ))}
      </Menu>
    </div>
  );
}
