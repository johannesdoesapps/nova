import {
  Bot,
  Code2,
  Compass,
  Flag,
  Gauge,
  FolderKanban,
  House,
  ImageIcon,
  LayoutTemplate,
  MessagesSquare,
  Plug,
  ShieldCheck,
  SlidersHorizontal,
  Swords,
  Users,
  Workflow,
  type LucideIcon,
} from "lucide-react";

/**
 * The app's one navigation list: the sidebar (desktop, collapsed and the
 * phone drawer) and the command palette are built from it, so each
 * destination appears once, with one label and one icon everywhere.
 */

export type Section =
  | "home"
  | "chat"
  | "code"
  | "projects"
  | "templates"
  | "agents"
  | "discover"
  | "missions"
  | "council"
  | "arena"
  | "images"
  | "verify"
  | "connectors"
  | "usage"
  | "workforce"
  | "admin";

export interface NavEntry {
  id: Section;
  label: string;
  href: string;
  icon: LucideIcon;
  /** mode: Chat and Code, switched in the top bar (not the sidebar); main: everyday work; tools: more ways to use the models; admin: administrators only. */
  group: "mode" | "main" | "tools" | "admin";
  /** What it's for, in a few words (tooltips and the command palette). */
  hint: string;
  /** Reached from another entry's page rather than the sidebar (Missions from Projects); that entry is shown active. */
  parent?: Section;
}

export const NAV_ENTRIES: NavEntry[] = [
  { id: "home", label: "Home", href: "/home", icon: House, group: "main", hint: "Your start page: recent work, your day and suggestions" },
  { id: "chat", label: "Chat", href: "/chat", icon: MessagesSquare, group: "mode", hint: "Ask, research and write with AI" },
  { id: "code", label: "Code", href: "/code", icon: Code2, group: "mode", hint: "Build and fix software with the coding agent" },
  { id: "agents", label: "Agents", href: "/agents", icon: Bot, group: "main", hint: "Specialised assistants, including the Security Team" },
  { id: "projects", label: "Projects", href: "/projects", icon: FolderKanban, group: "main", hint: "Ongoing work: code projects, missions and their tasks" },
  { id: "templates", label: "Templates", href: "/templates", icon: LayoutTemplate, group: "main", hint: "Ready-made workflows for common tasks" },
  { id: "discover", label: "Discover", href: "/discover", icon: Compass, group: "tools", hint: "What Orbis can do, with ways to try it" },
  { id: "missions", label: "Missions", href: "/missions", icon: Flag, group: "main", hint: "Plan projects and track tasks", parent: "projects" },
  { id: "council", label: "Council", href: "/council", icon: Users, group: "tools", hint: "Several models answer; one combined reply" },
  { id: "arena", label: "Arena", href: "/arena", icon: Swords, group: "tools", hint: "Compare models side by side, blind if you like" },
  { id: "images", label: "Images", href: "/images", icon: ImageIcon, group: "tools", hint: "Create an image from a description" },
  { id: "verify", label: "Verify", href: "/verify", icon: ShieldCheck, group: "tools", hint: "Check claims against sources" },
  { id: "connectors", label: "Connectors", href: "/connectors", icon: Plug, group: "tools", hint: "Connect Gmail, GitHub, Drive and more" },
  { id: "usage", label: "Usage", href: "/usage", icon: Gauge, group: "main", hint: "Your allowance, resets and usage history", parent: "home" },
  { id: "workforce", label: "Workforce", href: "/workforce", icon: Workflow, group: "admin", hint: "Internal AI engineers" },
  { id: "admin", label: "Admin", href: "/admin", icon: SlidersHorizontal, group: "admin", hint: "Models, plans and finance" },
];

/** The entries a user sees: administrators also get the admin group. */
export function navFor(isAdmin: boolean): NavEntry[] {
  return NAV_ENTRIES.filter((e) => e.group !== "admin" || isAdmin);
}

/** The sidebar's entries: everything except Chat and Code (in the top bar's switcher) and pages reached from another entry. */
export function sidebarFor(isAdmin: boolean): NavEntry[] {
  return navFor(isAdmin).filter((e) => e.group !== "mode" && !e.parent);
}

/** The sidebar entry to show as current for a section (Missions → Projects). */
export function activeEntryFor(section: Section): Section {
  return NAV_ENTRIES.find((e) => e.id === section)?.parent ?? section;
}

/** The two modes in the top bar. */
export const MODES = NAV_ENTRIES.filter((e) => e.group === "mode") as (NavEntry & { id: "chat" | "code" })[];

/** Which mode a page belongs to: Code pages, or Chat (the chat, the home where chats start, and chat history); none elsewhere. */
export function modeFor(pathname: string): "chat" | "code" | null {
  const s = sectionFor(pathname);
  return s === "code" ? "code" : s === "chat" || s === "home" ? (pathname === "/" ? null : "chat") : null;
}

/** Which entry a path belongs to (pages without their own entry, like settings dialogs on /chat or /history, count as Chat). */
export function sectionFor(pathname: string): Section {
  const hit = NAV_ENTRIES.find((e) => pathname === e.href || pathname.startsWith(`${e.href}/`));
  return hit?.id ?? "chat";
}
