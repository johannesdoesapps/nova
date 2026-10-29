/**
 * Slash commands in Orbis Code's task box: shortcuts that pick the mode and phrase the task, so "/test" or
 * "/review" does the common thing without typing it out. They only build a request for the agent (or open a new
 * task); they can't do anything the agent couldn't be asked to do in words, and the mode's approvals still apply.
 */

/** The task box's modes (agent-panel.tsx): read-only, plan first, review each edit, accept edits, work on its own, or full auto. */
export type SlashMode = "read" | "plan" | "review" | "edits" | "auto" | "full";

export const SLASH_MODES: SlashMode[] = ["plan", "review", "edits", "auto", "full", "read"];

/** Things the page does itself rather than ask the agent. */
export type SlashAction = "new" | "help" | "compact" | "rewind" | "fork" | "context" | "cost" | "mode" | "settings" | "parallel";

export interface SlashCommand {
  name: string;
  /** Shown in the menu. */
  hint: string;
  /** What to type after the command, if anything. */
  arg?: string;
  /** Needed: the command does nothing useful without its argument. */
  argRequired?: boolean;
  mode?: SlashMode;
  /** The request sent to the agent, from what was typed after the command. */
  request?: (arg: string) => string;
  action?: SlashAction;
  /** One of the project's own commands (.orbis/commands). */
  custom?: boolean;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "plan", hint: "Plan first: the agent proposes a plan and waits for your OK", arg: "task", argRequired: true, mode: "plan", request: (a) => a },
  { name: "auto", hint: "Let the agent work on its own (commands that need approval still ask)", arg: "task", argRequired: true, mode: "auto", request: (a) => a },
  {
    name: "fix",
    hint: "Find and fix a bug, then prove it with a test",
    arg: "what's wrong",
    argRequired: true,
    request: (a) => `Fix this bug: ${a}\n\nFirst reproduce it (with a failing test where the project has tests), then fix the cause, then run the tests again and show they pass.`,
  },
  {
    name: "test",
    hint: "Run the tests and fix what fails",
    arg: "optional focus",
    request: (a) => `Run the project's tests${a ? ` (focus: ${a})` : ""}. If any fail, find the cause and fix it, then run them again until they pass. If the project has no tests, say so and suggest how to add them.`,
  },
  {
    name: "review",
    hint: "Review the code (read only): bugs, risks, what to improve",
    arg: "optional focus",
    mode: "read",
    request: (a) =>
      `Review this project${a ? `, focusing on ${a}` : ""}. List real problems first (bugs, security issues, broken edge cases), each with the file and line and why it matters, then smaller improvements. Don't change anything.`,
  },
  { name: "explain", hint: "Explain how something works (read only)", arg: "question", argRequired: true, mode: "read", request: (a) => `Explain: ${a}\n\nPoint to the files and functions involved. Don't change anything.` },
  { name: "docs", hint: "Write or update the README", arg: "optional focus", request: (a) => `Write or update the project's README${a ? ` (${a})` : ""}: what it is, how to install, run and test it, and how it's organised. Check every command you mention against the project's files.` },
  {
    name: "init",
    hint: "Write ORBIS.md: how this project works, for every future session",
    request: (a) =>
      `Create ORBIS.md at the project root (or improve the one there) for future agent sessions: what the project is, how to install, run, test and build it (check every command against package.json and the other config files), how the code is organised, its conventions, and anything that would trip someone up.${a ? ` Also cover: ${a}.` : ""} Keep it under 150 lines and only write what's true of this project.`,
  },
  {
    name: "push",
    hint: "Push the project to a new GitHub branch (you approve it first)",
    arg: "optional branch",
    request: (a) => `Push the project to GitHub${a ? ` on the branch ${a}` : " on a new branch with a short descriptive name"}, with a clear commit message describing what changed. Use github_push.`,
  },
  {
    name: "pr",
    hint: "Push to a new branch and open a pull request (you approve it first)",
    arg: "optional title",
    request: (a) => `Push the project to GitHub on a new branch and open a pull request${a ? ` titled “${a}”` : ""}. Write a pull request description that explains what changed and why, and how it was tested. Use github_push with pull_request.`,
  },
  { name: "compact", hint: "Summarise the conversation to make room (say what to keep)", arg: "optional focus", action: "compact" },
  { name: "context", hint: "How full the agent's context is", action: "context" },
  { name: "cost", hint: "What this session has used so far", action: "cost" },
  { name: "rewind", hint: "Go back to before one of your messages (files too)", action: "rewind" },
  { name: "fork", hint: "Carry on in a new session with a copy of this conversation", arg: "message", action: "fork" },
  { name: "mode", hint: "Switch how the agent may work: plan, review, edits, auto, full, read", arg: "mode", argRequired: true, action: "mode" },
  { name: "permissions", hint: "Your rules: commands and files the agent may or may not touch", action: "settings" },
  { name: "mcp", hint: "Connect MCP servers whose tools the agent can use", action: "settings" },
  { name: "config", hint: "This project's agent settings, commands, skills and helpers", action: "settings" },
  { name: "parallel", hint: "Run a task in a parallel copy of the project (merge it back later)", arg: "task", argRequired: true, action: "parallel" },
  { name: "new", hint: "Start a new session", action: "new" },
  { name: "clear", hint: "Start a new session", action: "new" },
  { name: "help", hint: "Show these commands", action: "help" },
];

export type SlashResult =
  | { kind: "task"; command: string; request: string; mode?: SlashMode }
  | { kind: "action"; command: string; action: SlashAction; arg: string }
  | { kind: "error"; message: string };

/** A project's own command (.orbis/commands/<name>.md) as a slash command; its text becomes the request. */
export function customSlash(c: { name: string; description: string; argHint: string | null; body: string }, expand: (body: string, args: string) => string): SlashCommand {
  return { name: c.name, hint: c.description, ...(c.argHint ? { arg: c.argHint } : {}), custom: true, request: (a) => expand(c.body, a) };
}

/** What a task-box entry starting with "/" means; null when it isn't a command (an ordinary task). */
export function parseSlash(text: string, extra: SlashCommand[] = []): SlashResult | null {
  const m = /^\/([a-z][\w:-]*)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  const name = m[1]!.toLowerCase();
  const arg = (m[2] ?? "").trim();
  const cmd = SLASH_COMMANDS.find((c) => c.name === name) ?? extra.find((c) => c.name === name);
  if (!cmd) return { kind: "error", message: `There's no /${name} command. Type / to see them.` };
  if (cmd.argRequired && !arg && cmd.action) return { kind: "error", message: `Add ${cmd.arg} after /${cmd.name}${cmd.action === "mode" ? `: one of ${SLASH_MODES.join(", ")}` : ""}.` };
  if (cmd.action) return { kind: "action", command: cmd.name, action: cmd.action, arg };
  if (cmd.argRequired && !arg) return { kind: "error", message: `Add ${cmd.arg} after /${cmd.name}, for example “/${cmd.name} ${cmd.name === "explain" ? "how login works" : "the signup form"}”.` };
  return { kind: "task", command: cmd.name, request: cmd.request!(arg), ...(cmd.mode ? { mode: cmd.mode } : {}) };
}

/** Commands matching what has been typed so far ("/" alone lists them all), while the command word is being typed. */
export function slashSuggestions(text: string, extra: SlashCommand[] = []): SlashCommand[] {
  const m = /^\/([a-z][\w:-]*|)$/i.exec(text);
  if (!m) return [];
  const typed = m[1]!.toLowerCase();
  return [...SLASH_COMMANDS, ...extra.filter((e) => !SLASH_COMMANDS.some((c) => c.name === e.name))].filter((c) => c.name.startsWith(typed));
}

/** A custom command's request: $ARGUMENTS is everything typed after it, $1…$9 its words (added at the end when the command doesn't use them). */
export function expandCommand(body: string, args: string): string {
  const words = args.trim().split(/\s+/).filter(Boolean);
  const out = body.replace(/\$ARGUMENTS\b/g, args.trim()).replace(/\$([1-9])\b/g, (_, n: string) => words[Number(n) - 1] ?? "");
  return (body.includes("$ARGUMENTS") || /\$[1-9]\b/.test(body) || !args.trim() ? out : `${out.trimEnd()}\n\n${args.trim()}`).trim();
}
