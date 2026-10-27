/**
 * Slash commands in Orbis Code's task box: shortcuts that pick the mode and phrase the task, so "/test" or
 * "/review" does the common thing without typing it out. They only build a request for the agent (or open a new
 * task); they can't do anything the agent couldn't be asked to do in words, and the mode's approvals still apply.
 */

/** The task box's modes (agent-panel.tsx): read-only, plan first, review each edit, or work on its own. */
export type SlashMode = "read" | "plan" | "review" | "auto";

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
  action?: "new" | "help";
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
  { name: "new", hint: "Start a new task", action: "new" },
  { name: "help", hint: "Show these commands", action: "help" },
];

export type SlashResult =
  | { kind: "task"; command: string; request: string; mode?: SlashMode }
  | { kind: "action"; command: string; action: "new" | "help" }
  | { kind: "error"; message: string };

/** What a task-box entry starting with "/" means; null when it isn't a command (an ordinary task). */
export function parseSlash(text: string): SlashResult | null {
  const m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  const name = m[1]!.toLowerCase();
  const arg = (m[2] ?? "").trim();
  const cmd = SLASH_COMMANDS.find((c) => c.name === name);
  if (!cmd) return { kind: "error", message: `There's no /${name} command. Type / to see them.` };
  if (cmd.action) return { kind: "action", command: cmd.name, action: cmd.action };
  if (cmd.argRequired && !arg) return { kind: "error", message: `Add ${cmd.arg} after /${cmd.name}, for example “/${cmd.name} ${cmd.name === "explain" ? "how login works" : "the signup form"}”.` };
  return { kind: "task", command: cmd.name, request: cmd.request!(arg), ...(cmd.mode ? { mode: cmd.mode } : {}) };
}

/** Commands matching what has been typed so far ("/" alone lists them all), while the command word is being typed. */
export function slashSuggestions(text: string): SlashCommand[] {
  const m = /^\/([a-z]*)$/i.exec(text);
  if (!m) return [];
  const typed = m[1]!.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(typed));
}
