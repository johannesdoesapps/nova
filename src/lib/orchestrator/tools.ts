import type { ToolCall, ToolResult, ToolSpec } from "../ai/types";
import { isSecretPath } from "../code/agent/tools";
import type { ProjectFile } from "../code/projects";
import { redactAll } from "../secrets";
import { data } from "../workforce/prompts";
import type { OrchTool } from "./types";

/**
 * The tools an orchestrator agent can be granted in this phase: read-only access to the task's project. They
 * can't change anything. Files that usually hold credentials (.env, keys) are listed but never read, other file
 * contents are redacted for credentials, and everything returned is fenced as untrusted data.
 */

const MAX_READ = 6;
const MAX_FILE_CHARS = 30_000;
const MAX_MATCHES = 60;

export const TOOL_SPECS: Record<OrchTool, ToolSpec[]> = {
  read_project: [
    { name: "list_files", description: "List the project's file paths (optionally under a folder).", parameters: { type: "object", properties: { under: { type: "string", maxLength: 300 } }, additionalProperties: false } },
    {
      name: "search_code",
      description: "Find lines containing a text (case-insensitive) across the project's files.",
      parameters: { type: "object", properties: { query: { type: "string", minLength: 2, maxLength: 200 } }, required: ["query"], additionalProperties: false },
    },
    {
      name: "read_files",
      description: `Read up to ${MAX_READ} files by path.`,
      parameters: { type: "object", properties: { paths: { type: "array", items: { type: "string", maxLength: 300 }, minItems: 1, maxItems: MAX_READ } }, required: ["paths"], additionalProperties: false },
    },
  ],
};

/** The function tools an agent gets: those of its granted tools that exist, only when the task has a project. */
export function toolsFor(allowed: string[], hasProject: boolean): ToolSpec[] {
  if (!hasProject) return [];
  return allowed.flatMap((t) => (Object.hasOwn(TOOL_SPECS, t) ? TOOL_SPECS[t as OrchTool] : []));
}

const WITHHELD = "(withheld: this file usually holds secrets, so its contents are never sent to an agent)";

/** Run the model's tool calls against the project's files. Calls to tools the agent wasn't given are refused. */
export function runTools(calls: ToolCall[], offered: ToolSpec[], files: ProjectFile[]): ToolResult[] {
  const names = new Set(offered.map((t) => t.name));
  return calls.map((c) => {
    if (!names.has(c.name)) return { id: c.id, ok: false, text: `Not allowed: this agent has no "${c.name}" tool.` };
    const a = c.args ?? {};
    if (c.name === "list_files") {
      const under = typeof a.under === "string" ? a.under.replace(/^\/+|\/+$/g, "") : "";
      const paths = files.map((f) => f.path).filter((p) => !under || p.startsWith(`${under}/`));
      return { id: c.id, ok: true, text: paths.length ? paths.slice(0, 1000).join("\n") : "(no files)" };
    }
    if (c.name === "search_code") {
      const needle = typeof a.query === "string" ? a.query.toLowerCase() : "";
      if (needle.length < 2) return { id: c.id, ok: false, text: "Give a search text of at least 2 characters." };
      const hits: string[] = [];
      for (const f of files) {
        if (isSecretPath(f.path)) continue;
        f.content.split("\n").forEach((line, i) => {
          if (hits.length < MAX_MATCHES && line.toLowerCase().includes(needle)) hits.push(`${f.path}:${i + 1}: ${line.slice(0, 200)}`);
        });
      }
      return { id: c.id, ok: true, text: hits.length ? data("search results", redactAll(hits.join("\n"))) : "No matches." };
    }
    if (c.name === "read_files") {
      const paths = Array.isArray(a.paths) ? a.paths.filter((p): p is string => typeof p === "string").slice(0, MAX_READ) : [];
      if (!paths.length) return { id: c.id, ok: false, text: "Give the paths to read." };
      const parts = paths.map((p) => {
        const f = files.find((x) => x.path === p);
        if (!f) return `${p}: not found`;
        if (isSecretPath(p)) return `${p}: ${WITHHELD}`;
        const body = f.content.length > MAX_FILE_CHARS ? `${f.content.slice(0, MAX_FILE_CHARS)}\n…(cut at ${MAX_FILE_CHARS} characters)` : f.content;
        return data(p, redactAll(body));
      });
      return { id: c.id, ok: true, text: parts.join("\n\n") };
    }
    return { id: c.id, ok: false, text: `Unknown tool "${c.name}".` };
  });
}
