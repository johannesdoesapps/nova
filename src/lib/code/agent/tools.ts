import { z } from "zod";
import { applyAiEdits, type AiEdits } from "../ai-edits";
import { diffStats } from "../diff";
import { fileContent, projectPath, type FileChange, type ProjectFile } from "../projects";
import { classifyCommand } from "./policy";
import { clipText, tailText, type ActionResult, type AgentReply } from "./protocol";
import type { NewEvent } from "./runs";
import type { AgentPlan, CommandMode, Pending, RunStatus } from "./types";

/**
 * The agent's tools. Every action is carried out for real through the
 * environment it's given (the project's saved files, its computer, web
 * search, GitHub); results are what actually happened. Actions that need
 * the user (a plan, a command, edits to review, a question, starting the
 * computer) stop the step and say what the run is waiting for.
 */

export interface CommandOutcome {
  exitCode: number | null;
  output: string;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  /** Files the command created, changed or deleted in the project. */
  changed: FileChange[];
  skipped: string[];
}

export interface AgentEnv {
  /** The project's files as saved now. */
  files(): Promise<ProjectFile[]>;
  /** Save changes to the project (and the running computer), and record them for the run. */
  save(changes: FileChange[]): Promise<void>;
  /** Whether the project's computer is running. */
  computer(): Promise<boolean>;
  /** Run a command in the computer and wait for it (up to the time limit). */
  exec(command: string): Promise<CommandOutcome>;
  lookupDocs?: (query: string) => Promise<{ title: string; url: string; snippet: string }[]>;
  github?: (tool: string, args: Record<string, unknown>) => Promise<{ ok: boolean; text: string; summary: string }>;
}

export interface StepState {
  /** The plan has been approved (or approval isn't required). */
  planApproved: boolean;
  approvePlans: boolean;
  reviewEdits: boolean;
  commands: CommandMode;
  /** Commands the user approved this step (run without asking again). */
  approvedCommand?: string | null;
}

export interface StepOutcome {
  results: ActionResult[];
  events: NewEvent[];
  /** Set when the step stopped to wait for the user, or the run finished. */
  pause: { status: RunStatus; pending: Pending | null } | null;
  plan: AgentPlan | null;
  summary: string | null;
}

const MAX_READ_FILES = 8;
const MAX_READ_CHARS = 30_000;
const MAX_MATCHES = 80;
const OUTPUT_FOR_MODEL = 6_000;
const OUTPUT_FOR_LOG = 20_000;
/** Edits shown for review together (they're kept with the run while it waits). */
const MAX_REVIEW_CHARS = 700_000;

const args = {
  read_files: z.object({ paths: z.array(z.string().max(300)).min(1).max(MAX_READ_FILES) }),
  search_code: z.object({ query: z.string().min(1).max(200), regex: z.boolean().optional() }),
  write_file: z.object({ path: projectPath, content: fileContent }),
  edit_file: z.object({ path: projectPath, search: z.string().min(1).max(40_000), replace: z.string().max(80_000) }),
  delete_file: z.object({ path: projectPath }),
  run_command: z.object({ command: z.string().trim().min(1).max(2_000) }),
  lookup_docs: z.object({ query: z.string().trim().min(2).max(300) }),
  github: z.object({ action: z.enum(["read_file", "search_issues", "list_repos"]), repo: z.string().max(140).optional(), path: z.string().max(400).optional(), query: z.string().max(200).optional() }),
  propose_plan: z.object({ summary: z.string().trim().min(1).max(1_000), steps: z.array(z.string().trim().min(1).max(400)).min(1).max(20) }),
  ask_user: z.object({ question: z.string().trim().min(1).max(2_000), options: z.array(z.string().trim().min(1).max(200)).max(6).optional() }),
  finish: z.object({ summary: z.string().trim().min(1).max(8_000) }),
};

const EDIT_TOOLS = new Set(["write_file", "edit_file", "delete_file"]);
export const KNOWN_TOOLS = new Set(["list_files", ...Object.keys(args)]);

function issue(err: z.ZodError): string {
  const i = err.issues[0];
  return i ? `${i.path.join(".") || "args"}: ${i.message}` : "invalid arguments";
}

/** Matching lines across the project. */
export function searchFiles(files: ProjectFile[], query: string, regex = false): { lines: string[]; truncated: boolean } | { error: string } {
  let test: (line: string) => boolean;
  if (regex) {
    let re: RegExp;
    try {
      re = new RegExp(query, "i");
    } catch {
      return { error: "That isn't a valid regular expression." };
    }
    test = (l) => re.test(l);
  } else {
    const q = query.toLowerCase();
    test = (l) => l.toLowerCase().includes(q);
  }
  const lines: string[] = [];
  for (const f of files) {
    const rows = f.content.split("\n");
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      if (row.length > 2_000 || !test(row)) continue;
      if (lines.length >= MAX_MATCHES) return { lines, truncated: true };
      lines.push(`${f.path}:${i + 1}: ${row.trim().slice(0, 200)}`);
    }
  }
  return { lines, truncated: false };
}

function toEdit(tool: string, a: Record<string, unknown>): AiEdits["edits"][number] {
  if (tool === "write_file") return { action: "write", path: a.path as string, content: a.content as string };
  if (tool === "edit_file") return { action: "replace", path: a.path as string, search: a.search as string, replace: a.replace as string };
  return { action: "delete", path: a.path as string };
}

export function describeChange(c: FileChange): string {
  if (c.after === null) return `Deleted ${c.path}`;
  if (c.before === null) return `Created ${c.path} (${c.after.split("\n").length} lines)`;
  const s = diffStats(c.before, c.after);
  return `Edited ${c.path} (+${s.added} −${s.removed})`;
}

/** Combine sequential changes to the same files into one change per file (first before, last after). */
export function mergeChanges(changes: FileChange[]): FileChange[] {
  const out = new Map<string, FileChange>();
  for (const c of changes) {
    const prev = out.get(c.path);
    out.set(c.path, prev ? { path: c.path, before: prev.before, after: c.after } : c);
  }
  return [...out.values()].filter((c) => c.before !== c.after).sort((a, b) => a.path.localeCompare(b.path));
}

/** Run one step's actions in order, stopping at the first that needs the user. */
export async function runActions(reply: AgentReply, state: StepState, env: AgentEnv): Promise<StepOutcome> {
  const results: ActionResult[] = [];
  const events: NewEvent[] = [];
  let plan: AgentPlan | null = null;
  let files: ProjectFile[] | null = null;
  const current = async () => (files ??= await env.files());
  let commandRan = false;
  // With review on, edits are collected here and shown together at the end of the step.
  let proposed: FileChange[] = [];
  const done = (pause: StepOutcome["pause"], summary: string | null = null): StepOutcome => ({ results, events, pause, plan, summary });
  const skipRest = (from: number, why: string) => {
    for (const a of reply.actions.slice(from)) results.push({ tool: a.tool, ok: false, text: `Not run: ${why}` });
  };

  for (let i = 0; i < reply.actions.length; i++) {
    const { tool, args: raw } = reply.actions[i]!;
    if (!KNOWN_TOOLS.has(tool)) {
      results.push({ tool, ok: false, text: `Unknown tool "${tool}".` });
      continue;
    }
    if (proposed.length && !EDIT_TOOLS.has(tool)) {
      results.push({ tool, ok: false, text: "Not run: waiting for the user to review your edits. Do it in a later step." });
      continue;
    }

    if (tool === "list_files") {
      const fs = await current();
      results.push({ tool, ok: true, text: fs.length ? fs.map((f) => `${f.path} (${f.content.length} chars)`).join("\n") : "(no files)" });
      events.push({ kind: "inspect", title: `Listed ${fs.length} file${fs.length === 1 ? "" : "s"}` });
      continue;
    }

    const schema = args[tool as keyof typeof args];
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      results.push({ tool, ok: false, text: `Invalid arguments (${issue(parsed.error)}).` });
      continue;
    }
    const a = parsed.data as Record<string, unknown>;

    switch (tool) {
      case "read_files": {
        const fs = await current();
        const byPath = new Map(fs.map((f) => [f.path, f.content]));
        const paths = [...new Set((a.paths as string[]).map((p) => p.replace(/^\.\//, "")))];
        const parts = paths.map((p) => (byPath.has(p) ? `<file path="${p}">\n${clipText(byPath.get(p)!, MAX_READ_CHARS)}\n</file>` : `<file path="${p}">(no such file)</file>`));
        const found = paths.filter((p) => byPath.has(p));
        results.push({ tool, ok: found.length > 0, text: parts.join("\n") });
        events.push({ kind: "inspect", title: found.length ? `Read ${found.join(", ").slice(0, 300)}` : `Tried to read ${paths.join(", ").slice(0, 300)} (not found)` });
        break;
      }
      case "search_code": {
        const r = searchFiles(await current(), a.query as string, a.regex as boolean | undefined);
        if ("error" in r) {
          results.push({ tool, ok: false, text: r.error });
          break;
        }
        results.push({ tool, ok: true, text: r.lines.length ? r.lines.join("\n") + (r.truncated ? `\n(first ${MAX_MATCHES} matches)` : "") : "No matches." });
        events.push({ kind: "inspect", title: `Searched for “${(a.query as string).slice(0, 80)}” (${r.lines.length}${r.truncated ? "+" : ""} match${r.lines.length === 1 ? "" : "es"})` });
        break;
      }
      case "write_file":
      case "edit_file":
      case "delete_file": {
        if (!state.planApproved) {
          results.push({ tool, ok: false, text: "Not allowed yet: propose your plan and wait for the user's approval before changing files." });
          break;
        }
        const base = state.reviewEdits ? applyProposed(await current(), proposed) : await current();
        const applied = applyAiEdits(base, [toEdit(tool, a)]);
        if (!applied.ok) {
          results.push({ tool, ok: false, text: applied.errors.join(" ") });
          break;
        }
        if (!applied.changes.length) {
          results.push({ tool, ok: true, text: "No change (the file already had that content)." });
          break;
        }
        if (state.reviewEdits) {
          const next = mergeChanges([...proposed, ...applied.changes]);
          if (JSON.stringify(next).length > MAX_REVIEW_CHARS) {
            results.push({ tool, ok: false, text: "Not proposed: that's more than the user can review at once. Propose it in a later step." });
            break;
          }
          proposed = next;
          results.push({ tool, ok: true, text: `${describeChange(applied.changes[0]!)} — proposed; the user will review it.` });
          break;
        }
        await env.save(applied.changes);
        files = applyProposed(await current(), applied.changes);
        const c = applied.changes[0]!;
        results.push({ tool, ok: true, text: `${describeChange(c)} — saved.` });
        events.push({ kind: "edit", title: describeChange(c), detail: { path: c.path } });
        break;
      }
      case "run_command": {
        const command = a.command as string;
        if (!state.planApproved) {
          results.push({ tool, ok: false, text: "Not allowed yet: propose your plan and wait for the user's approval before running commands." });
          break;
        }
        if (state.commands === "off") {
          results.push({ tool, ok: false, text: "Commands are turned off for this run. Tell the user what to run instead." });
          break;
        }
        if (commandRan) {
          results.push({ tool, ok: false, text: "Not run: one command per step. Run it in the next step." });
          break;
        }
        const decision = classifyCommand(command);
        if (decision.kind === "block") {
          results.push({ tool, ok: false, text: `Not run: ${decision.reason} Find another way, or tell the user to do it themselves.` });
          events.push({ kind: "command", title: `Blocked: ${command.slice(0, 200)}`, detail: { command, blocked: decision.reason } });
          break;
        }
        const approved = state.approvedCommand === command;
        if (!approved && (state.commands === "ask" || decision.kind === "ask")) {
          const reason = decision.kind === "ask" ? decision.reason : "Every command needs your approval in this run.";
          results.push({ tool, ok: true, text: "Waiting for the user to approve this command." });
          skipRest(i + 1, "waiting for the user's approval of the command.");
          events.push({ kind: "approval", title: `Asked to run: ${command.slice(0, 200)}`, detail: { command, reason } });
          return done({ status: "awaiting_approval", pending: { kind: "command", command, reason } });
        }
        if (!(await env.computer())) {
          results.push({ tool, ok: true, text: "Waiting for the user to start the project's computer." });
          skipRest(i + 1, "waiting for the project's computer to start.");
          events.push({ kind: "status", title: "Needs the project's computer to run a command", detail: { command } });
          return done({ status: "needs_input", pending: { kind: "computer", command } });
        }
        commandRan = true;
        const out = await env.exec(command);
        events.push(commandEvent(command, out));
        results.push({ tool, ok: out.exitCode === 0 && !out.timedOut && !out.cancelled, text: commandResultText(command, out) });
        if (out.changed.length) files = null;
        if (out.cancelled) {
          skipRest(i + 1, "the run was stopped.");
          return done({ status: "cancelled", pending: null });
        }
        break;
      }
      case "lookup_docs": {
        if (!env.lookupDocs) {
          results.push({ tool, ok: false, text: "Web search isn't available here. Rely on the project's own files and what you know, and say when you're unsure." });
          break;
        }
        try {
          const found = await env.lookupDocs(a.query as string);
          results.push({ tool, ok: true, text: found.length ? found.map((s, n) => `(${n + 1}) ${s.title} — ${s.url}\n${s.snippet}`).join("\n\n") : "No results." });
          events.push({ kind: "inspect", title: `Looked up “${(a.query as string).slice(0, 80)}” (${found.length} result${found.length === 1 ? "" : "s"})`, detail: { query: a.query, sources: found.map((s) => ({ title: s.title, url: s.url })) } });
        } catch (err) {
          results.push({ tool, ok: false, text: `Web search failed: ${(err as Error).message.slice(0, 200)}` });
        }
        break;
      }
      case "github": {
        if (!env.github) {
          results.push({ tool, ok: false, text: "GitHub isn't connected for this user." });
          break;
        }
        const name = `github_${a.action as string}`;
        const r = await env.github(name, Object.fromEntries(Object.entries(a).filter(([k]) => k !== "action")));
        results.push({ tool, ok: r.ok, text: r.text });
        events.push({ kind: "inspect", title: r.ok ? `GitHub: ${r.summary}` : `GitHub: ${r.text.slice(0, 200)}` });
        break;
      }
      case "propose_plan": {
        plan = { summary: a.summary as string, steps: a.steps as string[], approved: !state.approvePlans };
        events.push({ kind: "plan", title: plan.summary, detail: { steps: plan.steps } });
        if (state.approvePlans) {
          results.push({ tool, ok: true, text: "Plan sent to the user for approval." });
          skipRest(i + 1, "waiting for the user to approve the plan.");
          return done({ status: "awaiting_approval", pending: { kind: "plan" } });
        }
        results.push({ tool, ok: true, text: "Plan noted. Carry on." });
        break;
      }
      case "ask_user": {
        const question = a.question as string;
        events.push({ kind: "question", title: question.slice(0, 400), detail: { options: a.options ?? [] } });
        results.push({ tool, ok: true, text: "Question sent to the user." });
        skipRest(i + 1, "waiting for the user's answer.");
        return done({ status: "needs_input", pending: { kind: "question", question, options: (a.options as string[] | undefined) ?? [] } });
      }
      case "finish": {
        if (proposed.length) {
          results.push({ tool, ok: false, text: "Not yet: the user hasn't reviewed your edits." });
          break;
        }
        events.push({ kind: "summary", title: "Finished", detail: { summary: a.summary } });
        results.push({ tool, ok: true, text: "Finished." });
        skipRest(i + 1, "the run has finished.");
        return done({ status: "completed", pending: null }, a.summary as string);
      }
    }
  }

  if (proposed.length) {
    events.push({ kind: "approval", title: `Proposed changes to ${proposed.length} file${proposed.length === 1 ? "" : "s"} for review`, detail: { paths: proposed.map((c) => c.path) } });
    return done({ status: "awaiting_approval", pending: { kind: "edits", changes: proposed } });
  }
  return done(null);
}

/** The files with changes applied (null after deletes the file). */
export function applyProposed(files: ProjectFile[], changes: FileChange[]): ProjectFile[] {
  const map = new Map(files.map((f) => [f.path, f.content]));
  for (const c of changes) {
    if (c.after === null) map.delete(c.path);
    else map.set(c.path, c.after);
  }
  return [...map].map(([path, content]) => ({ path, content })).sort((a, b) => a.path.localeCompare(b.path));
}

export function commandResultText(command: string, out: CommandOutcome): string {
  const status = out.cancelled
    ? "stopped by the user"
    : out.timedOut
      ? "stopped after 2 minutes (still running). Long-running servers should be started with the Run button."
      : `exit code ${out.exitCode}`;
  const files = out.changed.length ? `\nFiles it changed in the project: ${out.changed.map((c) => (c.after === null ? `${c.path} (deleted)` : c.path)).join(", ").slice(0, 1_000)}` : "";
  const skipped = out.skipped.length ? `\nNot copied back (binary, too large or over the project's limits): ${out.skipped.slice(0, 20).join(", ")}` : "";
  return `$ ${command}\n${status} after ${(out.durationMs / 1000).toFixed(1)}s${files}${skipped}\nOutput:\n${tailText(out.output, OUTPUT_FOR_MODEL) || "(no output)"}`;
}

export function commandEvent(command: string, out: CommandOutcome): NewEvent {
  const verdict = out.cancelled ? "stopped" : out.timedOut ? "timed out" : out.exitCode === 0 ? "passed" : `failed (exit ${out.exitCode})`;
  return {
    kind: "command",
    title: `Ran ${command.slice(0, 200)} — ${verdict}`,
    detail: {
      command,
      exitCode: out.exitCode,
      timedOut: out.timedOut,
      cancelled: out.cancelled,
      durationMs: Math.round(out.durationMs),
      output: tailText(out.output, OUTPUT_FOR_LOG),
      changed: out.changed.map((c) => c.path),
    },
  };
}
