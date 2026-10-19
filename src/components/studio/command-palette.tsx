"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Bookmark, Bot, Cpu, Flag, ListPlus, MessageSquare, MessagesSquare, Search, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, SquarePen, Swords, Users } from "lucide-react";
import { useCatalog } from "@/components/common/model-picker";
import { useModelChoice } from "./use-model-choice";
import { jsonFetch } from "@/hooks/use-ndjson";
import { autoIdFor, ROUTER_MODES } from "@/lib/ai/platform";
import { cn } from "@/lib/utils";
import type { ConvSummary } from "./history";

interface Command {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  keywords?: string;
  run: () => void;
}

/**
 * Ctrl+K / ⌘K command palette: navigate, open chats and missions, switch the
 * chat model, and open settings — all from the keyboard.
 */
export function CommandPalette({
  open,
  onClose,
  conversations,
  isAdmin,
  signedIn,
  onNewChat,
  onOpenSettings,
  onOpenPrompts,
}: {
  open: boolean;
  onClose: () => void;
  conversations: ConvSummary[] | null;
  isAdmin: boolean;
  signedIn: boolean;
  onNewChat: () => void;
  onOpenSettings: () => void;
  onOpenPrompts: () => void;
}) {
  if (!open) return null;
  return (
    <Palette
      onClose={onClose}
      conversations={conversations}
      isAdmin={isAdmin}
      signedIn={signedIn}
      onNewChat={onNewChat}
      onOpenSettings={onOpenSettings}
      onOpenPrompts={onOpenPrompts}
    />
  );
}

function Palette({
  onClose,
  conversations,
  isAdmin,
  signedIn,
  onNewChat,
  onOpenSettings,
  onOpenPrompts,
}: Omit<Parameters<typeof CommandPalette>[0], "open">) {
  const router = useRouter();
  const catalog = useCatalog();
  const [, setModel] = useModelChoice();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [missions, setMissions] = useState<{ id: string; name: string }[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    if (!signedIn) return;
    let alive = true;
    jsonFetch<{ missions: { id: string; name: string }[] }>("/api/missions")
      .then((r) => alive && setMissions(r.missions))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [signedIn]);

  const commands = useMemo<Command[]>(() => {
    const go = (href: string) => () => router.push(href);
    const pickModel = (id: string) => () => {
      setModel(id);
      if (!location.pathname.startsWith("/chat")) router.push("/chat");
    };
    const list: Command[] = [
      { id: "new", group: "Actions", label: "New chat", hint: "Ctrl Shift O", icon: <SquarePen />, run: onNewChat },
      { id: "council", group: "Actions", label: "Ask the Council", icon: <Users />, keywords: "compare models several", run: go("/council") },
      { id: "arena", group: "Actions", label: "Open Arena", icon: <Swords />, keywords: "blind battle compare vote", run: go("/arena") },
      { id: "mission-new", group: "Actions", label: "New mission", icon: <Flag />, keywords: "project plan goal mission control", run: go("/missions") },
      { id: "task", group: "Actions", label: "Create a task in a mission", icon: <ListPlus />, keywords: "todo task", run: go("/missions") },
      { id: "security", group: "Actions", label: "Security Team: scan, investigate or audit", icon: <ShieldCheck />, keywords: "security sentinel threat hunter code guardian vulnerability scan audit logs", run: go("/agents/security") },
      { id: "chats", group: "Go to", label: "Chats", icon: <MessagesSquare />, run: go("/chat") },
      { id: "missions", group: "Go to", label: "Mission Control", icon: <Flag />, run: go("/missions") },
      { id: "agents", group: "Go to", label: "Agents", icon: <Bot />, run: go("/agents") },
      { id: "prompts", group: "Go to", label: "Saved prompts", icon: <Bookmark />, run: onOpenPrompts },
      { id: "settings", group: "Go to", label: "Settings", icon: <Settings2 />, keywords: "preferences theme", run: onOpenSettings },
    ];
    if (isAdmin) list.push({ id: "admin", group: "Go to", label: "Admin", icon: <SlidersHorizontal />, keywords: "models providers keys", run: go("/admin") });
    if (isAdmin) list.push({ id: "workforce", group: "Go to", label: "Workforce (internal AI engineers)", icon: <Bot />, keywords: "workforce commander tasks agents builder developer", run: go("/workforce") });
    if (catalog?.auto.enabled) {
      for (const m of ROUTER_MODES) {
        list.push({ id: `auto-${m.id}`, group: "Switch model", label: m.id === "balanced" ? "Auto" : `Auto · ${m.label}`, hint: m.blurb, icon: <Sparkles />, keywords: "smart router model", run: pickModel(autoIdFor(m.id)) });
      }
    }
    for (const m of catalog?.models ?? []) {
      if (!m.available || m.provider === "demo") continue;
      list.push({ id: `model-${m.id}`, group: "Switch model", label: m.displayName, hint: m.provider, icon: <Cpu />, keywords: "model", run: pickModel(m.id) });
    }
    for (const mi of missions) list.push({ id: `mission-${mi.id}`, group: "Missions", label: mi.name, icon: <Flag />, keywords: "mission project", run: go(`/missions/${mi.id}`) });
    for (const c of conversations ?? []) list.push({ id: `chat-${c.id}`, group: "Conversations", label: c.title || "Untitled chat", icon: <MessageSquare />, keywords: "chat conversation", run: go(`/chat?c=${c.id}`) });
    return list;
  }, [router, setModel, onNewChat, onOpenPrompts, onOpenSettings, isAdmin, catalog, missions, conversations]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands.slice(0, 60);
    const words = q.split(/\s+/);
    return commands.filter((c) => {
      const hay = `${c.label} ${c.group} ${c.keywords ?? ""} ${c.hint ?? ""}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [commands, query]);

  const index = Math.min(active, Math.max(0, results.length - 1));

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const runAt = (i: number) => {
    const c = results[i];
    if (!c) return;
    onClose();
    c.run();
  };

  let lastGroup = "";
  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center bg-black/30 px-4 pt-[12vh] backdrop-blur-[2px]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Command palette" className="glass-strong glass-solid glass-edge s-pop w-full max-w-[560px] overflow-hidden rounded-[22px] text-s-ink">
        <div className="flex items-center gap-2.5 border-b border-s-line px-4">
          <Search className="h-4 w-4 shrink-0 text-s-ink-3" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((index + 1) % Math.max(1, results.length));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((index - 1 + results.length) % Math.max(1, results.length));
              } else if (e.key === "Enter") {
                e.preventDefault();
                runAt(index);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
            role="combobox"
            aria-label="Search commands, chats, missions and models"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={results[index] ? `palette-${results[index].id}` : undefined}
            placeholder="Search commands, chats, missions, models…"
            className="h-14 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-s-ink-3"
          />
          <kbd className="rounded-md border border-s-line px-1.5 py-0.5 text-[11px] text-s-ink-3">Esc</kbd>
        </div>
        <ul id="palette-list" ref={listRef} role="listbox" aria-label="Results" className="s-scroll max-h-[min(60vh,440px)] overflow-y-auto p-2">
          {results.length === 0 && <li className="px-3 py-6 text-center text-[13.5px] text-s-ink-3">No matches</li>}
          {results.map((c, i) => {
            const header = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <li key={c.id} role="presentation">
                {header && <div className="px-3 pb-1 pt-2.5 text-[11px] font-medium uppercase tracking-[0.08em] text-s-ink-3">{header}</div>}
                <div
                  id={`palette-${c.id}`}
                  role="option"
                  aria-selected={i === index}
                  data-index={i}
                  onMouseMove={() => i !== index && setActive(i)}
                  onClick={() => runAt(i)}
                  className={cn("flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-[14px] [&_svg]:h-4 [&_svg]:w-4", i === index ? "bg-s-hover" : "")}
                >
                  <span className="text-s-ink-2">{c.icon}</span>
                  <span className="min-w-0 flex-1 truncate">{c.label}</span>
                  {c.hint && <span className="hidden max-w-[45%] truncate text-[12px] text-s-ink-3 sm:inline">{c.hint}</span>}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
