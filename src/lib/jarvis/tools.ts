import { z } from "zod";

/**
 * Jarvis Mode's tools: every action Jarvis can take, with typed arguments, where it runs and how risky it is.
 * The model only proposes calls to these tools; the server checks each proposal against this list, and the
 * browser asks the permission rules (permissions.ts) before anything runs. Desktop tools are carried out by the
 * Orbis Desktop Agent on the user's computer, which checks them again (desktop-agent/).
 *
 * There is deliberately no tool that deletes files, runs shell commands, sends messages or buys anything.
 */

/**
 * Where a tool runs: in this browser tab, on the user's computer through the Desktop Agent, or on the Orbis server
 * during the turn itself (looking things up: Jarvis sees the result straight away and carries on).
 */
export type ToolRunner = "browser" | "desktop" | "server";

/**
 * How much a tool can affect: read (looks at something already allowed), private (reads the clipboard or the
 * screen), act (opens something), write (changes files, reversibly) or spend (uses the plan's allowance or
 * stores data with Orbis).
 */
export type RiskClass = "read" | "private" | "act" | "write" | "spend";

export interface JarvisTool {
  name: JarvisToolName;
  /** Short label for people. */
  title: string;
  /** What it does, for the model. */
  description: string;
  runner: ToolRunner;
  risk: RiskClass;
  /** Changes many things at once (shown as a list to approve). */
  batch?: boolean;
  args: z.ZodType<Record<string, unknown>>;
  /** The action in one plain sentence, for plans and approvals. */
  describe(args: Record<string, unknown>): string;
}

const path = z.string().trim().min(1).max(1024).refine((s) => !s.includes("\0"), "Invalid path.");
const str = (v: unknown) => String(v ?? "");

export const ORBIS_PAGES = ["home", "chat", "code", "templates", "missions", "research", "images", "agents", "activity", "connectors", "usage", "projects"] as const;

const defs = {
  open_url: {
    title: "Open a web page",
    description: "Open an http or https address in a new browser tab.",
    runner: "browser",
    risk: "act",
    args: z.object({ url: z.url({ protocol: /^https?$/ }).max(2000) }),
    describe: (a) => `Open ${str(a.url)} in a new tab`,
  },
  open_orbis_page: {
    title: "Open an Orbis page",
    description: "Open one of Orbis's own pages in this tab's app (home, chat, code, templates, missions, research, images, agents, activity, connectors, usage, projects).",
    runner: "browser",
    risk: "act",
    args: z.object({ page: z.enum(ORBIS_PAGES) }),
    describe: (a) => `Open Orbis ${str(a.page)}`,
  },
  research: {
    title: "Deep Research",
    description:
      "Start Orbis Deep Research on a question: multi-step web research with a cited report, opened in a new tab where it runs. Uses the plan's research allowance. Use for comparisons, market or product research and anything that needs current sources.",
    runner: "browser",
    risk: "spend",
    args: z.object({ question: z.string().trim().min(5).max(2000), depth: z.enum(["quick", "standard", "deep"]).default("standard") }),
    describe: (a) => `Research “${str(a.question).slice(0, 140)}” (${str(a.depth || "standard")} depth, uses research allowance)`,
  },
  build_website: {
    title: "Build a website",
    description: "Build a website in Orbis Code: creates a new website project and starts the coding agent on it, which works on its own and uses the plan's allowance. Use when the user wants a website or web page made; describe it fully (purpose, sections, style).",
    runner: "browser",
    risk: "spend",
    args: z.object({ description: z.string().trim().min(5).max(6000) }),
    describe: (a) => `Build a website in Orbis Code: “${str(a.description).slice(0, 140)}”`,
  },
  start_mission: {
    title: "Plan a project",
    description: "Open Orbis Missions with a goal filled in, to turn it into milestones and tasks.",
    runner: "browser",
    risk: "act",
    args: z.object({ goal: z.string().trim().min(3).max(4000) }),
    describe: (a) => `Plan in Missions: “${str(a.goal).slice(0, 140)}”`,
  },
  remember: {
    title: "Remember a fact",
    description: "Save one fact or preference the user asked Orbis to remember (Orbis memory, which the user can see and delete). Never store passwords, keys or other secrets.",
    runner: "browser",
    risk: "spend",
    args: z.object({ fact: z.string().trim().min(2).max(500) }),
    describe: (a) => `Remember: “${str(a.fact)}”`,
  },
  read_clipboard: {
    title: "Read the clipboard",
    description: "Read the text on the clipboard once, only when the user asks about what they copied. The browser may ask for permission.",
    runner: "browser",
    risk: "private",
    args: z.object({ purpose: z.string().trim().min(2).max(300) }),
    describe: (a) => `Read the clipboard once, to ${str(a.purpose)}`,
  },
  look_at_screen: {
    title: "Look at the screen",
    description: "Ask the user to share a screen or window once, take one picture of it and answer a question about it. Only when the user asks about their screen.",
    runner: "browser",
    risk: "private",
    args: z.object({ question: z.string().trim().min(2).max(1000) }),
    describe: (a) => `Look at a screen or window you choose, to answer: “${str(a.question).slice(0, 140)}”`,
  },
  open_application: {
    title: "Open an app",
    description: "Open an installed application by its name, e.g. \"Safari\", \"Visual Studio Code\", \"Notes\", \"notepad\".",
    runner: "desktop",
    risk: "act",
    args: z.object({ name: z.string().trim().min(1).max(60).regex(/^[\w .+&()-]+$/, "Use the app's plain name.") }),
    describe: (a) => `Open the app ${str(a.name)}`,
  },
  open_path: {
    title: "Open a file or folder",
    description: "Open a file or folder in its default app. Paths may start with ~ for the home folder; only folders the user allowed are reachable.",
    runner: "desktop",
    risk: "act",
    args: z.object({ path }),
    describe: (a) => `Open ${str(a.path)}`,
  },
  list_directory: {
    title: "List a folder",
    description: "List what is in a folder (names, kinds and sizes).",
    runner: "desktop",
    risk: "read",
    args: z.object({ path }),
    describe: (a) => `List the folder ${str(a.path)}`,
  },
  find_files: {
    title: "Find files",
    description: "Find files under a folder by part of their name and/or extensions, optionally only large ones. Searches up to 4 folders deep.",
    runner: "desktop",
    risk: "read",
    args: z.object({
      folder: path,
      name: z.string().trim().max(100).optional(),
      extensions: z.array(z.string().trim().regex(/^\.?[\w-]{1,12}$/)).max(20).optional(),
      min_size_mb: z.number().min(0).max(100_000).optional(),
    }),
    describe: (a) =>
      `Find files in ${str(a.folder)}${a.name ? ` named like “${str(a.name)}”` : ""}${Array.isArray(a.extensions) && a.extensions.length ? ` (${(a.extensions as string[]).join(", ")})` : ""}${a.min_size_mb ? ` over ${str(a.min_size_mb)} MB` : ""}`,
  },
  create_directory: {
    title: "Create a folder",
    description: "Create a new folder (and missing parent folders).",
    runner: "desktop",
    risk: "write",
    args: z.object({ path }),
    describe: (a) => `Create the folder ${str(a.path)}`,
  },
  move_file: {
    title: "Move a file",
    description: "Move a file or folder to another path. Never overwrites: fails if something already exists there.",
    runner: "desktop",
    risk: "write",
    args: z.object({ from: path, to: path }),
    describe: (a) => `Move ${str(a.from)} to ${str(a.to)}`,
  },
  copy_file: {
    title: "Copy a file",
    description: "Copy a file to another path. Never overwrites.",
    runner: "desktop",
    risk: "write",
    args: z.object({ from: path, to: path }),
    describe: (a) => `Copy ${str(a.from)} to ${str(a.to)}`,
  },
  rename_file: {
    title: "Rename a file",
    description: "Rename a file or folder in place. Never overwrites.",
    runner: "desktop",
    risk: "write",
    args: z.object({ path, new_name: z.string().trim().min(1).max(255).regex(/^[^/\\\0]+$/, "A name, not a path.") }),
    describe: (a) => `Rename ${str(a.path)} to ${str(a.new_name)}`,
  },
  organize_folder: {
    title: "Organise a folder",
    description:
      "Sort the files directly inside a folder into subfolders by type (Images, Documents, PDFs, Spreadsheets, Presentations, Archives, Audio, Video, Code, Installers, Other). Shows the exact moves for approval first. Never deletes or overwrites anything.",
    runner: "desktop",
    risk: "write",
    batch: true,
    args: z.object({ path }),
    describe: (a) => `Sort the files in ${str(a.path)} into folders by type (nothing deleted)`,
  },
  undo_last_change: {
    title: "Undo the last change",
    description: "Undo the Desktop Agent's most recent file change or batch of moves, when nothing has changed since.",
    runner: "desktop",
    risk: "write",
    args: z.object({}),
    describe: () => "Undo the last file change",
  },
  web_search: {
    title: "Search the web",
    description:
      "Search the web and get the top sources with short excerpts; you see the results straight away. Use for current facts, news, prices, opening hours and anything that may have changed. For a thorough written report with many sources, use research instead.",
    runner: "server",
    risk: "read",
    args: z.object({ query: z.string().trim().min(2).max(300) }),
    describe: (a) => `Search the web for “${str(a.query).slice(0, 120)}”`,
  },
  read_web_page: {
    title: "Read a web page",
    description: "Read the text of a public web page (an article, documentation, a product page); you see it straight away. Not for pages behind a login.",
    runner: "server",
    risk: "read",
    args: z.object({ url: z.url({ protocol: /^https?$/ }).max(2000) }),
    describe: (a) => `Read ${str(a.url).slice(0, 120)}`,
  },
  calculate: {
    title: "Calculate",
    description:
      "Exact arithmetic; you see the result straight away. Operators + - * / ^ % (remainder) and parentheses; functions sqrt, abs, round(x, digits), floor, ceil, min, max, log, ln, exp, sin, cos, tan; constants pi, e. Use it instead of doing sums yourself.",
    runner: "server",
    risk: "read",
    args: z.object({ expression: z.string().trim().min(1).max(300) }),
    describe: (a) => `Calculate ${str(a.expression).slice(0, 120)}`,
  },
  get_time: {
    title: "Check the time",
    description: "The current date and time in the user's time zone, or in a given IANA time zone such as Asia/Tokyo or America/New_York.",
    runner: "server",
    risk: "read",
    args: z.object({ time_zone: z.string().trim().max(64).regex(/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/, "Use an IANA time zone, e.g. Europe/Paris.").optional() }),
    describe: (a) => (a.time_zone ? `Check the time in ${str(a.time_zone)}` : "Check the time"),
  },
  recall_memories: {
    title: "Recall memories",
    description: "Look up what the user asked Orbis to remember (their Orbis memory), optionally about a topic.",
    runner: "server",
    risk: "read",
    args: z.object({ topic: z.string().trim().max(200).optional() }),
    describe: (a) => (a.topic ? `Recall what you've told Orbis about ${str(a.topic).slice(0, 80)}` : "Recall what you've told Orbis to remember"),
  },
  use_skill: {
    title: "Use a skill",
    description: "Load the step-by-step instructions of one of the skills listed in your instructions, before doing a task it covers. Pass its id.",
    runner: "server",
    risk: "read",
    args: z.object({ name: z.string().trim().min(2).max(60) }),
    describe: (a) => `Use the “${str(a.name)}” skill`,
  },
  system_info: {
    title: "Check the computer",
    description: "Report the computer's operating system, memory, free disk space and battery (where available).",
    runner: "desktop",
    risk: "read",
    args: z.object({}),
    describe: () => "Check system information",
  },
} satisfies Record<string, Omit<JarvisTool, "name" | "args" | "describe"> & { args: z.ZodObject; describe(a: Record<string, unknown>): string }>;

export type JarvisToolName = keyof typeof defs;
export const TOOL_NAMES = Object.keys(defs) as JarvisToolName[];
export const TOOLS: Record<JarvisToolName, JarvisTool> = Object.fromEntries(
  TOOL_NAMES.map((name) => [name, { name, ...defs[name], args: defs[name].args as unknown as z.ZodType<Record<string, unknown>> }]),
) as Record<JarvisToolName, JarvisTool>;

export function isToolName(v: unknown): v is JarvisToolName {
  return typeof v === "string" && Object.hasOwn(defs, v);
}

export type ProposalCheck = { ok: true; tool: JarvisToolName; args: Record<string, unknown> } | { ok: false; tool: string; error: string };

/** Check a proposed call: a known tool, offered this turn, with valid arguments (defaults filled in). */
export function checkProposal(name: unknown, args: unknown, offered: readonly JarvisToolName[]): ProposalCheck {
  const tool = typeof name === "string" ? name.slice(0, 60) : "?";
  if (!isToolName(name)) return { ok: false, tool, error: "Unknown tool." };
  if (!offered.includes(name)) return { ok: false, tool, error: "That tool isn't available right now." };
  const parsed = TOOLS[name].args.safeParse(args ?? {});
  if (!parsed.success) return { ok: false, tool, error: parsed.error.issues[0]?.message ?? "Invalid arguments." };
  return { ok: true, tool: name, args: parsed.data };
}

/**
 * The tools offered to the model: browser and server tools always (minus any this deployment or user can't use),
 * desktop tools only while the Desktop Agent is connected.
 */
export function offeredTools(desktopConnected: boolean, unavailable: readonly JarvisToolName[] = []): JarvisToolName[] {
  return TOOL_NAMES.filter((n) => (TOOLS[n].runner !== "desktop" || desktopConnected) && !unavailable.includes(n));
}

export const isServerTool = (name: JarvisToolName) => TOOLS[name].runner === "server";

/** JSON Schemas for providers with native tool calling. */
export function toolSpecs(names: readonly JarvisToolName[]): { name: string; description: string; parameters: Record<string, unknown> }[] {
  return names.map((name) => {
    const parameters = { ...(z.toJSONSchema(defs[name].args, { io: "input", unrepresentable: "any" }) as Record<string, unknown>) };
    delete parameters.$schema;
    return { name, description: defs[name].description, parameters };
  });
}
