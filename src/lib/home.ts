import { z } from "zod";
import type { ChatMode } from "@/lib/ai/modes";

/**
 * The signed-in home: what it shows and how it's personalised. Everything
 * here is either a real Orbis capability (with a real action behind it) or
 * built from the user's own records; nothing is invented. Shared by the API
 * and the page.
 */

// ---------------------------------------------------------------- actions

/** What pressing something on the home does: start or fill a chat, or open a page. */
export type HomeAction =
  | { kind: "send"; prompt: string; mode: ChatMode; web?: boolean; modelId?: string }
  | { kind: "draft"; prompt: string; mode: ChatMode; web?: boolean; attach?: boolean }
  | { kind: "link"; href: string };

export interface Suggestion {
  id: string;
  label: string;
  action: HomeAction;
}

/** The suggested actions under the prompt box. "Plan my day" is built at run time from the user's day. */
export const SUGGESTIONS: Suggestion[] = [
  { id: "research", label: "Help me research something", action: { kind: "draft", prompt: "Help me research ", mode: "research", web: true } },
  { id: "brainstorm", label: "Brainstorm an idea", action: { kind: "draft", prompt: "Brainstorm ideas for ", mode: "critic" } },
  { id: "write", label: "Write something for me", action: { kind: "draft", prompt: "Write ", mode: "research" } },
  { id: "plan-day", label: "Help me plan my day", action: { kind: "send", prompt: "", mode: "analyst" } },
  { id: "build", label: "Build something new", action: { kind: "link", href: "/code" } },
];

export interface DayContext {
  date: string;
  focus: string[];
  tasks: { title: string; project: string }[];
  events: { title: string; when: string }[];
  calendar: "connected" | "not_connected" | "unavailable";
}

/** "Help me plan my day", with what Orbis actually knows about the day (and nothing it doesn't). */
export function planDayPrompt(d: DayContext): string {
  const parts = [`Help me plan my day (${d.date}).`];
  if (d.focus.length) parts.push(`My priorities for today:\n${d.focus.map((f) => `- ${f}`).join("\n")}`);
  if (d.tasks.length) parts.push(`Tasks in progress in my projects:\n${d.tasks.map((t) => `- ${t.title} (${t.project})`).join("\n")}`);
  if (d.events.length) parts.push(`On my calendar today:\n${d.events.map((e) => `- ${e.when}: ${e.title}`).join("\n")}`);
  else if (d.calendar === "connected") parts.push("My calendar has no events today.");
  parts.push(
    d.focus.length || d.tasks.length || d.events.length
      ? "Ask me briefly about anything else that matters today and when I'm working, then propose a realistic schedule with breaks."
      : "I haven't told you anything about my day yet: ask me a few short questions first (fixed commitments, priorities, energy), then propose a realistic schedule with breaks.",
  );
  return parts.join("\n\n");
}

// ---------------------------------------------------------------- discover and tools

export type DiscoverKind = "capability" | "tool" | "idea";

export interface DiscoverItem {
  id: string;
  kind: DiscoverKind;
  title: string;
  text: string;
  icon: IconName;
  action: HomeAction;
  cta: string;
  /** Shown only when web search is set up on the site. */
  needsSearch?: boolean;
}

export type IconName =
  | "telescope"
  | "users"
  | "swords"
  | "globe"
  | "bug"
  | "file"
  | "bot"
  | "flag"
  | "plug"
  | "play"
  | "flame"
  | "scale"
  | "graduation"
  | "pen"
  | "lightbulb"
  | "chart"
  | "code"
  | "sparkles";

/** Curated: each is something Orbis really does, with a real way to try it. */
export const DISCOVER: DiscoverItem[] = [
  {
    id: "research-sources",
    kind: "capability",
    title: "Research with sources",
    text: "Research mode searches the web and cites what it read, so you can check every claim.",
    icon: "telescope",
    action: { kind: "draft", prompt: "What are the most important developments this year in ", mode: "research", web: true },
    cta: "Start researching",
    needsSearch: true,
  },
  {
    id: "council",
    kind: "tool",
    title: "Ask several models at once",
    text: "Council puts one question to several models and writes a single answer that shows where they agree and disagree.",
    icon: "users",
    action: { kind: "link", href: "/council" },
    cta: "Open Council",
  },
  {
    id: "arena",
    kind: "tool",
    title: "Blind-test two models",
    text: "Arena answers with two hidden models side by side; you pick the better reply before the names are shown.",
    icon: "swords",
    action: { kind: "link", href: "/arena" },
    cta: "Open Arena",
  },
  {
    id: "build-website",
    kind: "capability",
    title: "Build a website from a prompt",
    text: "Describe a site; the coding agent builds it, runs it and checks it in a real browser on desktop and phone sizes.",
    icon: "globe",
    action: { kind: "link", href: "/code" },
    cta: "Build a website",
  },
  {
    id: "fix-bug",
    kind: "capability",
    title: "Watch an agent fix a bug",
    text: "Try the example project: the agent finds why the tests fail, fixes it and proves it by running them.",
    icon: "bug",
    action: { kind: "link", href: "/code" },
    cta: "Open Code",
  },
  {
    id: "summarise",
    kind: "capability",
    title: "Summarise a long document",
    text: "Attach a text, Markdown or CSV file (or paste the text) and get the key points, decisions and open questions.",
    icon: "file",
    action: { kind: "draft", prompt: "Summarise this document: the key points, any decisions, and open questions.", mode: "analyst", attach: true },
    cta: "Attach a document",
  },
  {
    id: "agent",
    kind: "tool",
    title: "Make a reusable agent",
    text: "Give an agent its own instructions and default model, then come back to it whenever you need that job done.",
    icon: "bot",
    action: { kind: "link", href: "/agents?create=1" },
    cta: "Create an agent",
  },
  {
    id: "mission",
    kind: "tool",
    title: "Turn a goal into a plan",
    text: "Mission Control drafts milestones and tasks from a goal; you edit them, and AI drafts the tasks it can help with.",
    icon: "flag",
    action: { kind: "link", href: "/missions" },
    cta: "Plan a goal",
  },
  {
    id: "connectors",
    kind: "tool",
    title: "Bring in your email and calendar",
    text: "Connect Gmail, Google Calendar, Drive and more so answers can use them — read-only unless you allow more.",
    icon: "plug",
    action: { kind: "link", href: "/connectors" },
    cta: "See connectors",
  },
  {
    id: "run-code",
    kind: "capability",
    title: "Run code from a reply",
    text: "Ask for a script and press Run on the reply: it runs on an isolated computer and you see the output.",
    icon: "play",
    action: { kind: "draft", prompt: "Write a short Python script that ", mode: "coding" },
    cta: "Write a script",
  },
  {
    id: "stress-test",
    kind: "idea",
    title: "Stress-test a plan",
    text: "Critic mode looks for the weak spots in an idea before someone else does.",
    icon: "flame",
    action: { kind: "draft", prompt: "Challenge this plan and tell me where it's most likely to fail: ", mode: "critic" },
    cta: "Challenge an idea",
  },
  {
    id: "decide",
    kind: "idea",
    title: "Make a decision with a table",
    text: "Lay out two or three options side by side against the criteria that matter to you.",
    icon: "scale",
    action: { kind: "draft", prompt: "Help me decide between these options. Compare them in a table against cost, effort, risk and upside: ", mode: "analyst" },
    cta: "Compare options",
  },
  {
    id: "learn",
    kind: "idea",
    title: "Learn something in ten minutes",
    text: "A short lesson at your level, with an example and a three-question quiz at the end.",
    icon: "graduation",
    action: { kind: "draft", prompt: "In ten minutes, with one example and a three-question quiz at the end, teach me the basics of ", mode: "research" },
    cta: "Pick a topic",
  },
  {
    id: "rewrite",
    kind: "idea",
    title: "Make your writing clearer",
    text: "Paste a draft and get a tighter version, with the main changes explained.",
    icon: "pen",
    action: { kind: "draft", prompt: "Edit this for clarity and concision, and explain your main changes:\n\n", mode: "critic" },
    cta: "Paste a draft",
  },
];

/** Discover items that work on this site (research needs web search). */
export function discoverFor(opts: { search: boolean }): DiscoverItem[] {
  return DISCOVER.filter((d) => !d.needsSearch || opts.search);
}

/**
 * Today's picks for the home: a few items that change each day, skipping
 * dismissed ones. Deterministic for a given day, so the page doesn't shuffle
 * on every visit.
 */
export function dailyPicks(items: DiscoverItem[], day: string, dismissed: string[], n = 3): DiscoverItem[] {
  const pool = items.filter((d) => !dismissed.includes(d.id));
  if (pool.length <= n) return pool;
  let seed = [...day].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const out: DiscoverItem[] = [];
  const left = [...pool];
  while (out.length < n && left.length) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    out.push(left.splice(seed % left.length, 1)[0]!);
  }
  return out;
}

export interface QuickTool {
  id: string;
  label: string;
  hint: string;
  icon: IconName;
  action: HomeAction;
}

/** Shortcuts to what Orbis supports. */
export const QUICK_TOOLS: QuickTool[] = [
  { id: "write", label: "Write", hint: "Draft an email, post or document", icon: "pen", action: { kind: "draft", prompt: "Write ", mode: "research" } },
  { id: "research", label: "Research", hint: "Research mode, with web search when it's available", icon: "telescope", action: { kind: "draft", prompt: "Research ", mode: "research", web: true } },
  { id: "brainstorm", label: "Brainstorm", hint: "Generate and challenge ideas", icon: "lightbulb", action: { kind: "draft", prompt: "Brainstorm ideas for ", mode: "critic" } },
  {
    id: "summarise",
    label: "Summarise",
    hint: "Attach a document and get the key points",
    icon: "file",
    action: { kind: "draft", prompt: "Summarise this document: the key points, any decisions, and open questions.", mode: "analyst", attach: true },
  },
  {
    id: "analyse",
    label: "Analyse data",
    hint: "Attach a CSV or spreadsheet export and ask about it",
    icon: "chart",
    action: { kind: "draft", prompt: "Analyse this data: describe what's in it, the main patterns, and anything unusual.", mode: "analyst", attach: true },
  },
  { id: "code", label: "Code", hint: "The coding agent: build, fix and test software", icon: "code", action: { kind: "link", href: "/code" } },
  { id: "compare", label: "Compare models", hint: "Council: several models, one combined answer", icon: "users", action: { kind: "link", href: "/council" } },
  { id: "plan", label: "Plan a goal", hint: "Mission Control: milestones and tasks", icon: "flag", action: { kind: "link", href: "/missions" } },
];

/** A suggestion, tool or Discover item by id, so other pages can link to "/home?try=<id>" (never "send": a link mustn't send a message by itself). */
export function homeActionById(id: string): HomeAction | null {
  const a = SUGGESTIONS.find((s) => s.id === id)?.action ?? DISCOVER.find((d) => d.id === id)?.action ?? QUICK_TOOLS.find((t) => t.id === id)?.action ?? null;
  return a && a.kind !== "send" ? a : null;
}

// ---------------------------------------------------------------- sections and preferences

export const HOME_SECTIONS = [
  { id: "continue", label: "Pick up where you left off" },
  { id: "projects", label: "My projects" },
  { id: "conversations", label: "Recent conversations" },
  { id: "day", label: "My day" },
  { id: "tools", label: "Quick tools" },
  { id: "discover", label: "Discover" },
] as const;
export type HomeSectionId = (typeof HOME_SECTIONS)[number]["id"];
const SECTION_IDS = HOME_SECTIONS.map((s) => s.id) as [HomeSectionId, ...HomeSectionId[]];

export const FOCUS_LIMIT = 8;

const focusItem = z.object({ id: z.string().regex(/^[a-z0-9]{6,24}$/), text: z.string().trim().min(1).max(200), done: z.boolean() });

const prefFields = {
  hidden: z.array(z.enum(SECTION_IDS)).max(SECTION_IDS.length),
  dismissed: z.array(z.string().max(60)).max(60),
  /** Today's priorities: the date they're for (the user's local date) and the items. */
  focus: z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), items: z.array(focusItem).max(FOCUS_LIMIT) }).nullable(),
};

/** What the user chose for their home, kept in their profile's preferences. */
/** Shown until the user chooses otherwise: a calm home (My day, Quick tools and Discover are one switch away in Customize). */
export const DEFAULT_HIDDEN: HomeSectionId[] = ["day", "tools", "discover"];
export const homePrefs = z.object({ hidden: prefFields.hidden.default(DEFAULT_HIDDEN), dismissed: prefFields.dismissed.default([]), focus: prefFields.focus.default(null) });
export type HomePrefs = z.infer<typeof homePrefs>;
export const EMPTY_PREFS: HomePrefs = { hidden: DEFAULT_HIDDEN, dismissed: [], focus: null };

/** Stored preferences, tolerating anything malformed (it's ignored rather than breaking the page). */
export function readPrefs(raw: unknown): HomePrefs {
  const r = homePrefs.safeParse(raw ?? {});
  return r.success ? r.data : EMPTY_PREFS;
}

/** A change to the preferences: only what's given changes (no defaults, so nothing else is reset). */
export const homePrefsPatch = z
  .object({ hidden: prefFields.hidden.optional(), dismissed: prefFields.dismissed.optional(), focus: prefFields.focus.optional() })
  .strict()
  .refine((p) => Object.keys(p).length > 0, "Nothing to update.");
export type HomePrefsPatch = z.infer<typeof homePrefsPatch>;

/** Stored preferences with a change applied. */
export function applyPrefs(current: HomePrefs, patch: HomePrefsPatch): HomePrefs {
  return { ...current, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
}

// ---------------------------------------------------------------- data the page gets

export interface HomeConversation {
  id: string;
  title: string;
  mode: string;
  updatedAt: string;
  /** The start of the latest message. */
  preview: string | null;
}

export interface HomeProject {
  kind: "code" | "mission";
  id: string;
  name: string;
  updatedAt: string;
  href: string;
  /** A short state line, e.g. "3 of 8 tasks done" or "Website · agent waiting for you". */
  detail: string;
  /** Something needs the user (an agent waiting, a task in progress). */
  attention: string | null;
}

export interface HomeTask {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "blocked";
  priority: "low" | "medium" | "high";
  project: string;
  href: string;
}

export interface HomeData {
  signedIn: boolean;
  conversations: HomeConversation[];
  projects: HomeProject[];
  tasks: HomeTask[];
  prefs: HomePrefs;
  calendar: "connected" | "not_connected" | "unavailable" | "reauth";
}

/** An event on the user's calendar today (from Google Calendar). */
export interface DayEvent {
  title: string;
  url: string | null;
  start: string;
  end: string | null;
  /** A date without a time: an all-day event. */
  allDay: boolean;
}

/** One line under the greeting, from what's really there. */
export function contextLine(d: Pick<HomeData, "signedIn" | "conversations" | "projects" | "tasks">): string {
  if (!d.signedIn) return "Ask anything, try a tool below, or sign in to keep your conversations and projects.";
  const waiting = d.projects.filter((p) => p.attention).length;
  const active = d.tasks.filter((t) => t.status === "in_progress").length;
  const bits: string[] = [];
  if (waiting) bits.push(`${waiting} project${waiting === 1 ? " needs" : "s need"} you`);
  if (active) bits.push(`${active} task${active === 1 ? "" : "s"} in progress`);
  if (bits.length) return `${bits.join(" and ")}. Pick up below, or start something new.`;
  if (d.conversations.length || d.projects.length) return "Everything you were working on is below. What's next?";
  return "This is your space in Orbis. Ask a question, try a suggestion, or start a project — it'll all be here when you come back.";
}

export function greetingFor(hour: number, name: string | null): string {
  const part = hour < 5 || hour >= 18 ? "Good evening" : hour < 12 ? "Good morning" : "Good afternoon";
  return name ? `${part}, ${name}` : part;
}

/** The user's local date as YYYY-MM-DD. */
export function localDay(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "2 h ago", "yesterday", "12 Oct". */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 172_800) return "yesterday";
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
