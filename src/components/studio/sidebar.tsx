"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { Archive, Bookmark, Code2, Ellipsis, FolderPlus, LogIn, LogOut, Monitor, Moon, PanelLeftClose, PanelLeftOpen, Pencil, Search, Settings2, SquarePen, Sun, Trash2, X } from "lucide-react";
import type { AppUser } from "@/components/layout/app-context";
import { cn } from "@/lib/utils";
import { groupByDate, type ConvSummary } from "./history";
import { navFor, type NavEntry, type Section } from "./nav";
import type { ThemePref } from "./prefs";
import { IconButton, iconButtonClass, Kbd, Menu, MenuItem, MenuSeparator, OrbisMark, Segmented } from "./ui";

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
    if (!q || found?.q.toLowerCase() !== q) return groupByDate(list);
    const seen = new Set(list.map((c) => c.id));
    const merged = [...list, ...found.items.filter((c) => !seen.has(c.id))].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return groupByDate(merged);
  }, [p.conversations, query, found]);
  const searching = !!onSearch && !!query.trim() && found?.q.toLowerCase() !== query.trim().toLowerCase();

  const rail = p.collapsed;
  // In Code, the sidebar is about projects; everywhere else, about chats.
  const inCode = p.section === "code";
  const entries = navFor(!!p.user?.isAdmin);
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
        aria-label="Sidebar"
        className={cn(
          "glass max-md:!bg-[var(--s-glass-menu)] fixed inset-y-0 left-0 z-40 flex w-[min(300px,86vw)] flex-col overflow-hidden border-0 border-r !shadow-none transition-[transform,width] duration-300 ease-[cubic-bezier(.2,.7,.2,1)]",
          "pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] md:relative md:z-auto md:translate-x-0",
          p.mobileOpen ? "translate-x-0" : "-translate-x-full",
          rail ? "md:w-[68px]" : "md:w-[248px] lg:w-[276px]",
        )}
      >
        {/* Brand + collapse */}
        <div className={cn("flex h-14 shrink-0 items-center gap-2 px-3", rail && "md:justify-center md:px-0")}>
          <Link
            href="/home"
            onClick={p.onCloseMobile}
            className={cn("flex min-w-0 items-center gap-2.5 rounded-xl px-1.5 py-1 transition hover:opacity-80", rail && "md:hidden")}
            aria-label="Orbis — home"
          >
            <OrbisMark className="h-7 w-7 text-s-ink" />
            <span className="text-[15px] font-semibold tracking-[0.22em]">ORBIS</span>
          </Link>
          <IconButton
            label={rail ? "Expand sidebar" : "Collapse sidebar"}
            onClick={p.onToggleCollapsed}
            className={cn("ml-auto hidden md:inline-grid", rail && "md:ml-0")}
          >
            {rail ? <PanelLeftOpen /> : <PanelLeftClose />}
          </IconButton>
          <IconButton label="Close sidebar" onClick={p.onCloseMobile} className="ml-auto md:hidden">
            <X />
          </IconButton>
        </div>

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
                className="h-9 w-full rounded-xl border border-transparent bg-s-hover pl-9 pr-12 text-[13.5px] text-s-ink outline-none transition placeholder:text-s-ink-3 focus:border-s-line-strong focus:bg-transparent focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden"
              />
              <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 [@media(hover:none)]:hidden">
                <Kbd>{mac ? "⌘K" : "Ctrl K"}</Kbd>
              </span>
            </div>
          </div>
          )}
        </div>

        <nav aria-label="Main" className={cn("shrink-0 px-3 pb-2", rail && "md:px-0")}>
          {(["main", "tools", "admin"] as const).map((group) => {
            const items = entries.filter((e) => e.group === group);
            if (!items.length) return null;
            return (
              <div key={group} className={cn(group !== "main" && "mt-2")}>
                {group !== "main" && (
                  <h2 className={cn("px-3 pb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-s-ink-3", rail && "md:sr-only")}>{group === "tools" ? "Tools" : "Admin"}</h2>
                )}
                <ul className={cn("flex flex-col gap-0.5", rail && "md:items-center")}>
                  {items.map((e) => (
                    <NavLink key={e.id} entry={e} rail={rail} active={p.section === e.id} onClick={p.onCloseMobile} />
                  ))}
                </ul>
              </div>
            );
          })}
          <ul className={cn("mt-2 flex flex-col gap-0.5", rail && "md:items-center")}>
            <NavItem rail={rail} icon={<Bookmark />} label="Saved prompts" onClick={p.onOpenPrompts} />
            <NavItem rail={rail} icon={<Settings2 />} label="Settings" onClick={p.onOpenSettings} />
          </ul>
        </nav>

        <div className={cn("mx-4 h-px shrink-0 bg-s-line", rail && "md:hidden")} />

        {/* History */}
        <div className={cn("s-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-2", rail && "md:invisible")}>
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
                <h3 className="px-3 pb-1 text-[11.5px] font-medium text-s-ink-3">{g.label}</h3>
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

        <ProfileMenu {...p} rail={rail} />
      </aside>
    </>
  );
}

function NavLink({ entry, rail, active, onClick }: { entry: NavEntry; rail: boolean; active: boolean; onClick: () => void }) {
  const Icon = entry.icon;
  return <NavItem rail={rail} icon={<Icon />} label={entry.label} href={entry.href} active={active} onClick={onClick} hint={entry.hint} />;
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
      <h3 className="px-3 pb-1 text-[11.5px] font-medium text-s-ink-3">Projects</h3>
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

function NavItem({ rail, icon, label, href, onClick, active, hint }: { rail: boolean; icon: ReactNode; label: string; href?: string; onClick?: () => void; active?: boolean; hint?: string }) {
  const cls = cn(
    "flex h-9 items-center gap-3 rounded-xl px-3 text-[13.5px] text-s-ink-2 transition duration-200 hover:bg-s-hover hover:text-s-ink active:scale-[0.98] [&_svg]:h-[17px] [&_svg]:w-[17px] [&_svg]:shrink-0",
    active && "bg-s-hover font-medium text-s-ink",
    rail && "md:w-9 md:justify-center md:px-0",
  );
  const body = (
    <>
      {icon}
      <span className={cn(rail && "md:sr-only")}>{label}</span>
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
}: {
  conv: ConvSummary;
  active: boolean;
  onNavigate: () => void;
  onRename: (id: string, title: string) => Promise<void>;
  onRequestDelete: (c: ConvSummary) => void;
  onArchive?: (c: ConvSummary) => void;
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
        className={cn("min-w-0 flex-1 truncate py-2 pl-3 pr-9 text-[13.5px]", active ? "text-s-ink" : "text-s-ink-2 group-hover:text-s-ink")}
        title={conv.title}
      >
        {conv.title}
      </Link>
      <div className="absolute right-1 top-1/2 -translate-y-1/2">
        <Menu
          label={`Actions for ${conv.title}`}
          align="start"
          side="auto"
          width={180}
          buttonLabel="Chat actions"
          buttonClassName={cn(
            iconButtonClass("sm"),
            "h-7 w-7 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100 [@media(hover:none)]:opacity-100",
          )}
          button={<Ellipsis />}
        >
          <MenuItem icon={<Pencil />} onClick={() => setEditing(true)}>
            Rename
          </MenuItem>
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
              onClick={p.onOpenSettings}
            >
              Settings
            </MenuItem>
            {p.accountsEnabled && <MenuSeparator />}
            {p.accountsEnabled &&
              (p.user ? (
                <MenuItem icon={<LogOut />} onClick={() => signOutRef.current?.requestSubmit()}>
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
