"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { LogIn, Menu, MessageSquare, PanelLeft, PanelLeftClose, Plus, FolderKanban, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { NAV } from "./nav";
import { Logo } from "./logo";
import { useApp } from "./app-context";

export function AppShell({ children }: { children: ReactNode }) {
  const [sidebarPref, setSidebarPref] = useLocalStorage("novara:sidebar", "open");
  const collapsed = sidebarPref === "collapsed";
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();
  // Close the mobile drawer on navigation (state adjustment during render, not in an effect).
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    if (mobileOpen) setMobileOpen(false);
  }

  const toggle = () => setSidebarPref(collapsed ? "open" : "collapsed");

  return (
    <div className="flex min-h-dvh">
      {/* Desktop sidebar */}
      <aside
        className={cn(
          "sticky top-0 hidden h-dvh shrink-0 border-r border-border bg-bg-elev/80 backdrop-blur transition-[width] duration-200 lg:flex lg:flex-col",
          collapsed ? "w-[68px]" : "w-[264px]",
        )}
      >
        <SidebarContent collapsed={collapsed} onToggle={toggle} />
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <button className="absolute inset-0 bg-black/60" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-[280px] flex-col border-r border-border bg-bg-elev">
            <SidebarContent collapsed={false} onClose={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-border bg-bg/85 px-4 backdrop-blur lg:hidden">
          <button className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-panel-2 hover:text-fg" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
            <Menu className="h-5 w-5" />
          </button>
          <Link href="/"><Logo /></Link>
        </header>
        <main className="nova-glow min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}

function SidebarContent({ collapsed, onToggle, onClose }: { collapsed: boolean; onToggle?: () => void; onClose?: () => void }) {
  const pathname = usePathname();
  const { user, recents, integrations } = useApp();
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`));

  return (
    <>
      <div className={cn("flex h-14 items-center border-b border-border px-3", collapsed ? "justify-center" : "justify-between")}>
        {!collapsed && <Link href="/" className="pl-1"><Logo /></Link>}
        {onToggle && (
          <button onClick={onToggle} className="grid h-8 w-8 place-items-center rounded-lg text-faint hover:bg-panel-2 hover:text-fg" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
            {collapsed ? <PanelLeft className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
          </button>
        )}
        {onClose && (
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-faint hover:bg-panel-2" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="px-3 pt-3">
        <Link
          href="/chat?new=1"
          className={cn(
            "flex h-9 items-center gap-2 rounded-xl border border-border-strong bg-panel text-sm font-medium hover:border-accent/50 hover:bg-panel-2",
            collapsed ? "w-[44px] justify-center" : "px-3",
          )}
          title="New chat"
        >
          <Plus className="h-4 w-4 text-accent" />
          {!collapsed && "New chat"}
        </Link>
      </div>

      <nav className="mt-2 flex-1 overflow-y-auto px-3 pb-3" aria-label="Main">
        <ul className="space-y-0.5">
          {NAV.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  title={collapsed ? item.label : undefined}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "group flex h-9 items-center gap-2.5 rounded-lg text-sm transition-colors",
                    collapsed ? "w-[44px] justify-center" : "px-2.5",
                    active ? "bg-accent-soft text-fg" : "text-muted hover:bg-panel-2 hover:text-fg",
                  )}
                >
                  <Icon className={cn("h-[17px] w-[17px] shrink-0", active ? "text-accent" : "text-faint group-hover:text-muted")} />
                  {!collapsed && (
                    <>
                      <span className="truncate">{item.label}</span>
                      {item.soon && <span className="ml-auto rounded bg-panel-2 px-1.5 py-px text-[10px] uppercase tracking-wide text-faint">Soon</span>}
                    </>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>

        {!collapsed && user && (
          <>
            <SidebarSection title="Recent chats">
              {recents.conversations.length === 0 ? (
                <p className="px-2.5 text-xs text-faint">No conversations yet.</p>
              ) : (
                recents.conversations.slice(0, 6).map((c) => (
                  <Link key={c.id} href={`/chat?c=${c.id}`} className="flex h-8 items-center gap-2 rounded-lg px-2.5 text-[13px] text-muted hover:bg-panel-2 hover:text-fg">
                    <MessageSquare className="h-3.5 w-3.5 shrink-0 text-faint" />
                    <span className="truncate">{c.title}</span>
                  </Link>
                ))
              )}
            </SidebarSection>
            <SidebarSection title="Projects">
              {recents.projects.length === 0 ? (
                <p className="px-2.5 text-xs text-faint">No projects yet.</p>
              ) : (
                recents.projects.slice(0, 5).map((p) => (
                  <Link key={p.id} href={`/projects/${p.id}`} className="flex h-8 items-center gap-2 rounded-lg px-2.5 text-[13px] text-muted hover:bg-panel-2 hover:text-fg">
                    <FolderKanban className="h-3.5 w-3.5 shrink-0 text-faint" />
                    <span className="truncate">{p.name}</span>
                  </Link>
                ))
              )}
            </SidebarSection>
          </>
        )}
      </nav>

      <div className="border-t border-border p-3">
        {user ? (
          <Link href="/settings" className={cn("flex items-center gap-2.5 rounded-lg p-1.5 hover:bg-panel-2", collapsed && "justify-center")}>
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-panel-2 text-xs font-semibold uppercase text-accent">
              {(user.displayName ?? user.email ?? "?").slice(0, 1)}
            </span>
            {!collapsed && (
              <span className="min-w-0">
                <span className="block truncate text-sm">{user.displayName ?? "Your account"}</span>
                <span className="block truncate text-xs text-faint">{user.email}</span>
              </span>
            )}
          </Link>
        ) : integrations.supabase ? (
          <Link href="/login" className={cn("flex h-9 items-center gap-2 rounded-lg px-2.5 text-sm text-muted hover:bg-panel-2 hover:text-fg", collapsed && "justify-center px-0")}>
            <LogIn className="h-4 w-4" />
            {!collapsed && "Sign in"}
          </Link>
        ) : (
          !collapsed && (
            <Link href="/settings" className="block rounded-lg border border-warning/25 bg-warning/[0.06] px-2.5 py-2 text-xs text-muted hover:text-fg">
              <span className="font-medium text-warning">Demo mode.</span> Accounts are off until Supabase is configured.
            </Link>
          )
        )}
      </div>
    </>
  );
}

function SidebarSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-5">
      <div className="mb-1 px-2.5 text-[11px] font-medium uppercase tracking-wider text-faint">{title}</div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}
