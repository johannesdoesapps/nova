import { Bot, Code2, Compass, Flag, FolderKanban, House, MessagesSquare, Plug, SlidersHorizontal, Swords, Users, Workflow, type LucideIcon } from "lucide-react";

/**
 * The app's one navigation list: the sidebar (desktop, collapsed and the
 * phone drawer) and the command palette are built from it, so each
 * destination appears once, with one label and one icon everywhere.
 */

export type Section = "home" | "chat" | "code" | "projects" | "agents" | "discover" | "missions" | "council" | "arena" | "connectors" | "workforce" | "admin";

export interface NavEntry {
  id: Section;
  label: string;
  href: string;
  icon: LucideIcon;
  /** main: everyday work; tools: more ways to use the models; admin: administrators only. */
  group: "main" | "tools" | "admin";
  /** What it's for, in a few words (tooltips and the command palette). */
  hint: string;
}

export const NAV_ENTRIES: NavEntry[] = [
  { id: "home", label: "Home", href: "/home", icon: House, group: "main", hint: "Your start page: recent work, your day and suggestions" },
  { id: "chat", label: "Chat", href: "/chat", icon: MessagesSquare, group: "main", hint: "Ask, research and write with AI" },
  { id: "code", label: "Code", href: "/code", icon: Code2, group: "main", hint: "Build and fix software with the coding agent" },
  { id: "projects", label: "Projects", href: "/projects", icon: FolderKanban, group: "main", hint: "All your code projects and missions" },
  { id: "agents", label: "Agents", href: "/agents", icon: Bot, group: "main", hint: "Specialised assistants, including the Security Team" },
  { id: "discover", label: "Discover", href: "/discover", icon: Compass, group: "tools", hint: "What Orbis can do, with ways to try it" },
  { id: "missions", label: "Missions", href: "/missions", icon: Flag, group: "tools", hint: "Plan projects and track tasks" },
  { id: "council", label: "Council", href: "/council", icon: Users, group: "tools", hint: "Several models answer; one combined reply" },
  { id: "arena", label: "Arena", href: "/arena", icon: Swords, group: "tools", hint: "Compare models side by side" },
  { id: "connectors", label: "Connectors", href: "/connectors", icon: Plug, group: "tools", hint: "Connect Gmail, GitHub, Drive and more" },
  { id: "workforce", label: "Workforce", href: "/workforce", icon: Workflow, group: "admin", hint: "Internal AI engineers" },
  { id: "admin", label: "Admin", href: "/admin", icon: SlidersHorizontal, group: "admin", hint: "Models, plans and finance" },
];

/** The entries a user sees: administrators also get the admin group. */
export function navFor(isAdmin: boolean): NavEntry[] {
  return NAV_ENTRIES.filter((e) => e.group !== "admin" || isAdmin);
}

/** Which entry a path belongs to (pages without their own entry, like settings dialogs on /chat or /history, count as Chat). */
export function sectionFor(pathname: string): Section {
  const hit = NAV_ENTRIES.find((e) => pathname === e.href || pathname.startsWith(`${e.href}/`));
  return hit?.id ?? "chat";
}
