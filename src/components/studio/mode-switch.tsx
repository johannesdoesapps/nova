"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";
import { CodeXml, MessagesSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { MODES, modeFor } from "./nav";

/**
 * Where each mode was last left (the open conversation, the open project), so
 * switching back returns there. Kept for the browser tab.
 */
const KEY = { chat: "orbis:last-chat", code: "orbis:last-code" } as const;
const listeners = new Set<() => void>();

/**
 * Code's places to return to: its start page and an open project. The website builder (/code/website) is a
 * side trip, not where Code lives, so the Code button never reopens it.
 */
function codePlace(pathname: string): string | null {
  return pathname === "/code/website" || pathname.startsWith("/code/website/") ? null : pathname;
}

function read(mode: "chat" | "code"): string | null {
  try {
    const href = sessionStorage.getItem(KEY[mode]);
    // Ignore a website-builder page remembered before codePlace existed.
    if (mode === "code" && href && !codePlace(href.split("?")[0]!)) return null;
    return href;
  } catch {
    return null;
  }
}

/** Remember the current place in a mode (called by the frame on navigation). */
export function rememberPlace(pathname: string, search: URLSearchParams) {
  const mode = modeFor(pathname);
  let href: string | null = null;
  if (mode === "code") href = codePlace(pathname);
  else if (pathname === "/chat" || pathname === "/home") {
    // A conversation (started on the home or in Chat) reopens in Chat; a fresh one is just Chat.
    const c = search.get("c");
    href = c ? `/chat?c=${encodeURIComponent(c)}` : pathname === "/chat" ? "/chat" : null;
  }
  if (!href || !mode) return;
  try {
    if (sessionStorage.getItem(KEY[mode]) === href) return;
    sessionStorage.setItem(KEY[mode], href);
  } catch {
    return;
  }
  listeners.forEach((l) => l());
}

/** Forget a place that no longer exists (a deleted chat or project); with `href`, only if it's that place. */
export function forgetPlace(mode: "chat" | "code", href?: string) {
  try {
    if (href && sessionStorage.getItem(KEY[mode]) !== href) return;
    sessionStorage.removeItem(KEY[mode]);
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((l) => l());
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

/** The Chat / Code switch in the top bar. */
export function ModeSwitch({ className }: { className?: string }) {
  const pathname = usePathname();
  const active = modeFor(pathname);
  const chatHref =
    useSyncExternalStore(
      subscribe,
      () => read("chat"),
      () => null,
    ) ?? "/chat";
  const codeHref =
    useSyncExternalStore(
      subscribe,
      () => read("code"),
      () => null,
    ) ?? "/code";
  return (
    <nav aria-label="Mode" className={cn("inline-flex shrink-0 items-center gap-0.5 rounded-xl border border-s-line bg-s-hover p-0.5", className)}>
      {MODES.map((m) => {
        const Icon = m.id === "code" ? CodeXml : MessagesSquare;
        const on = active === m.id;
        return (
          <Link
            key={m.id}
            href={m.id === "chat" ? chatHref : codeHref}
            aria-label={m.label}
            aria-current={on ? "page" : undefined}
            title={m.label}
            className={cn(
              "grid h-8 w-9 place-items-center rounded-[9px] border transition-colors duration-150 [&_svg]:h-[17px] [&_svg]:w-[17px]",
              on ? "border-s-line-strong bg-s-glass-strong text-s-ink shadow-[var(--s-shadow-sm)]" : "border-transparent text-s-ink-3 hover:bg-s-hover hover:text-s-ink",
            )}
          >
            <Icon aria-hidden />
          </Link>
        );
      })}
    </nav>
  );
}
