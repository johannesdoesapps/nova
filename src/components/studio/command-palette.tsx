"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bookmark,
  Bot,
  Code2,
  Cpu,
  Flag,
  Keyboard,
  LayoutTemplate,
  ListPlus,
  MessageSquare,
  Monitor,
  Moon,
  PanelLeft,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  SquarePen,
  Sun,
  TextCursorInput,
} from "lucide-react";
import { useCatalog } from "@/components/common/model-picker";
import { jsonFetch } from "@/hooks/use-ndjson";
import { autoIdFor, ROUTER_MODES } from "@/lib/ai/platform";
import { shortcut, shortcutKeys } from "@/lib/shortcuts";
import { TEMPLATES } from "@/lib/templates/registry";
import { CommandMenu, type Command } from "./command-menu";
import type { ConvSummary } from "./history";
import { navFor, type Section } from "./nav";
import type { ThemePref } from "./prefs";
import { useModelChoice } from "./use-model-choice";

export { rankCommands } from "./command-menu";
export type { Command } from "./command-menu";

/** Extra search words for the "Go to" entries. */
const GO_KEYWORDS: Partial<Record<Section, string>> = {
  chat: "chats conversations ask",
  code: "projects editor terminal preview ide agent",
  missions: "mission control project plan",
  council: "compare models several",
  arena: "blind battle compare vote",
  templates: "workflow template recipe",
  verify: "fact check claims evidence sources",
  usage: "allowance limit quota billing units",
  connectors: "integrations apps gmail drive google calendar slack notion github outlook onedrive hubspot figma wikipedia connect",
  admin: "models providers keys",
  workforce: "commander tasks agents builder developer",
};

export interface PaletteActions {
  onNewChat: () => void;
  onOpenSettings: () => void;
  onOpenPrompts: () => void;
  onOpenShortcuts: () => void;
  onToggleSidebar: () => void;
  onFocusComposer: (() => void) | null;
  onSearchChats: (q: string) => Promise<ConvSummary[]>;
  setTheme: (t: ThemePref) => void;
}

/**
 * The command palette (⌘K / Ctrl+K, or the search button in the top bar):
 * actions, pages, chats, projects, agents, templates, models and settings.
 * Every entry runs the same action as its button elsewhere in Orbis; pages add
 * their own (e.g. the chat adds "Copy the last reply").
 */
export function CommandPalette({
  open,
  onClose,
  conversations,
  isAdmin,
  signedIn,
  mac,
  actions,
  pageCommands,
}: {
  open: boolean;
  onClose: () => void;
  conversations: ConvSummary[] | null;
  isAdmin: boolean;
  signedIn: boolean;
  mac: boolean;
  actions: PaletteActions;
  /** Commands the current page adds. */
  pageCommands: Command[];
}) {
  if (!open) return null;
  return <Palette onClose={onClose} conversations={conversations} isAdmin={isAdmin} signedIn={signedIn} mac={mac} actions={actions} pageCommands={pageCommands} />;
}

type Named = { id: string; name: string };

function Palette({ onClose, conversations, isAdmin, signedIn, mac, actions, pageCommands }: Omit<Parameters<typeof CommandPalette>[0], "open">) {
  const router = useRouter();
  const catalog = useCatalog();
  const [, setModel] = useModelChoice();
  const [missions, setMissions] = useState<Named[]>([]);
  const [codeProjects, setCodeProjects] = useState<Named[]>([]);
  const [agents, setAgents] = useState<{ id: string; name: string; description: string; kind: string }[]>([]);
  const [found, setFound] = useState<{ q: string; items: ConvSummary[] } | null>(null);
  const [searching, setSearching] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // What to list: the user's projects and agents (fetched when the palette opens).
  useEffect(() => {
    let alive = true;
    jsonFetch<{ builtins: { id: string; name: string; description: string; kind: string }[]; agents: { id: string; name: string; description: string; kind: string }[] }>("/api/agents")
      .then((r) => alive && setAgents([...r.builtins, ...r.agents]))
      .catch(() => {});
    if (signedIn) {
      jsonFetch<{ missions: Named[] }>("/api/missions")
        .then((r) => alive && setMissions(r.missions))
        .catch(() => {});
      jsonFetch<{ projects: Named[] }>("/api/code/projects")
        .then((r) => alive && setCodeProjects(r.projects))
        .catch(() => {});
    }
    return () => {
      alive = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [signedIn]);

  // Signed in: also search every chat's title and messages on the server.
  const onQuery = (q: string) => {
    if (timer.current) clearTimeout(timer.current);
    const t = q.trim();
    if (!signedIn || t.length < 2) {
      setSearching(false);
      return;
    }
    setSearching(true);
    timer.current = setTimeout(() => {
      actions
        .onSearchChats(t)
        .then((items) => setFound({ q: t, items }))
        .catch(() => setFound({ q: t, items: [] }))
        .finally(() => setSearching(false));
    }, 250);
  };

  const commands = useMemo<Command[]>(() => {
    const go = (href: string) => () => router.push(href);
    const keys = (id: Parameters<typeof shortcut>[0]) => shortcutKeys(shortcut(id), mac);
    const pickModel = (id: string) => () => {
      setModel(id);
      if (!location.pathname.startsWith("/chat") && !location.pathname.startsWith("/home")) router.push("/chat");
    };
    const list: Command[] = [
      ...pageCommands,
      { id: "new", group: "Actions", label: "New chat", icon: <SquarePen />, keys: keys("new-chat"), keywords: "start conversation", run: actions.onNewChat },
      ...(actions.onFocusComposer
        ? [
            {
              id: "focus",
              group: "Actions",
              label: "Go to the message box",
              icon: <TextCursorInput />,
              keys: keys("focus-composer"),
              keywords: "type write composer input",
              run: actions.onFocusComposer,
            },
          ]
        : []),
      { id: "search-chats", group: "Actions", label: "Search conversations", hint: "Titles and messages", icon: <Search />, keywords: "find history chats", run: go("/history") },
      { id: "template", group: "Actions", label: "Start a workflow template", icon: <LayoutTemplate />, keywords: "workflow template recipe", run: go("/templates") },
      { id: "code-new", group: "Actions", label: "New coding project", icon: <Code2 />, keywords: "code project build fix bug agent", run: go("/code?new=1") },
      { id: "mission-new", group: "Actions", label: "New mission", icon: <Flag />, keywords: "project plan goal mission control", run: go("/missions") },
      { id: "task", group: "Actions", label: "Create a task in a mission", icon: <ListPlus />, keywords: "todo task", run: go("/missions") },
      { id: "verify", group: "Actions", label: "Check claims against sources", icon: <ShieldCheck />, keywords: "verify fact check evidence", run: go("/verify") },
      // The same destinations, labels and icons as the sidebar.
      ...navFor(isAdmin).map((e) => {
        const Icon = e.icon;
        return { id: `go-${e.id}`, group: "Go to", label: e.label, hint: e.hint, icon: <Icon />, keywords: GO_KEYWORDS[e.id] ?? "", run: go(e.href) };
      }),
      { id: "history", group: "Go to", label: "All conversations", icon: <MessageSquare />, keywords: "history chats", run: go("/history") },
      { id: "prompts", group: "Go to", label: "Saved prompts", icon: <Bookmark />, keywords: "reuse prompt library", run: actions.onOpenPrompts },
      { id: "settings", group: "Settings", label: "Settings", icon: <Settings2 />, keywords: "preferences privacy data reply length style", run: actions.onOpenSettings },
      { id: "sidebar", group: "Settings", label: "Show or hide the sidebar", icon: <PanelLeft />, keys: keys("sidebar"), run: actions.onToggleSidebar },
      { id: "theme-dark", group: "Settings", label: "Theme: dark", icon: <Moon />, keywords: "appearance colour mode", run: () => actions.setTheme("dark") },
      { id: "theme-light", group: "Settings", label: "Theme: light", icon: <Sun />, keywords: "appearance colour mode", run: () => actions.setTheme("light") },
      { id: "theme-system", group: "Settings", label: "Theme: match my device", icon: <Monitor />, keywords: "appearance colour mode system", run: () => actions.setTheme("system") },
      { id: "shortcuts", group: "Settings", label: "Keyboard shortcuts", icon: <Keyboard />, keys: keys("shortcuts"), keywords: "keys hotkeys help", run: actions.onOpenShortcuts },
    ];
    if (catalog?.auto.enabled) {
      for (const m of ROUTER_MODES) {
        list.push({
          id: `auto-${m.id}`,
          group: "Switch model",
          label: m.id === "balanced" ? "Auto" : `Auto · ${m.label}`,
          hint: m.blurb,
          icon: <Sparkles />,
          keywords: "smart router model",
          run: pickModel(autoIdFor(m.id)),
        });
      }
    }
    for (const m of catalog?.models ?? []) {
      if (!m.available || m.locked || m.provider === "demo") continue;
      list.push({ id: `model-${m.id}`, group: "Switch model", label: m.displayName, hint: m.provider, icon: <Cpu />, keywords: "model", run: pickModel(m.id) });
    }
    for (const t of TEMPLATES)
      list.push({ id: `tpl-${t.id}`, group: "Templates", label: t.name, hint: t.description, icon: <LayoutTemplate />, keywords: "template workflow", run: go(`/templates?t=${t.id}`) });
    for (const a of agents) list.push({ id: `agent-${a.id}`, group: "Agents", label: a.name, hint: a.description, icon: <Bot />, keywords: "agent assistant", run: go(`/agents/${a.id}`) });
    for (const p of missions) list.push({ id: `mission-${p.id}`, group: "Projects", label: p.name, hint: "Mission", icon: <Flag />, keywords: "mission project", run: go(`/missions/${p.id}`) });
    for (const p of codeProjects) list.push({ id: `code-${p.id}`, group: "Projects", label: p.name, hint: "Code project", icon: <Code2 />, keywords: "code project", run: go(`/code/${p.id}`) });
    const seen = new Set<string>();
    for (const c of [...(found?.items ?? []), ...(conversations ?? [])]) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      // A match in the message text carries its excerpt, so it ranks for the words searched.
      list.push({
        id: `chat-${c.id}`,
        group: "Conversations",
        label: c.title || "Untitled chat",
        hint: c.snippet ?? c.project_name ?? undefined,
        icon: <MessageSquare />,
        keywords: `chat conversation ${c.snippet ?? ""}`,
        run: go(`/chat?c=${c.id}`),
      });
    }
    return list;
  }, [router, setModel, actions, pageCommands, isAdmin, catalog, missions, codeProjects, agents, conversations, found, mac]);

  return (
    <CommandMenu
      label="Command palette"
      placeholder="Search commands, chats, projects, agents, templates, models…"
      commands={commands}
      onClose={onClose}
      onQuery={onQuery}
      loading={searching}
      empty={(q) => (
        <>
          <span className="block text-s-ink-2">Nothing matches “{q}”.</span>
          <span className="mt-1 block">{signedIn ? "Chats were searched by title and message too." : "Sign in to search your chats’ messages too."} Try a page name, a template, or “new chat”.</span>
        </>
      )}
      footer={
        <span className="flex flex-wrap gap-x-3 gap-y-0.5">
          <span>↑ ↓ to move</span>
          <span>Enter to open</span>
          <span>Esc to close</span>
        </span>
      }
    />
  );
}
