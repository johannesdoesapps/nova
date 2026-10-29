import { createHash } from "node:crypto";
import { globMatch } from "../glob";
import type { ProjectFile } from "../projects";

/**
 * What a project tells the coding agent through its own files, and the user's permission rules.
 *
 * - ORBIS.md (or .orbis/ORBIS.md; AGENTS.md / CLAUDE.md when there's none): the project's instructions, given to
 *   the agent at the start of every session. Nested ORBIS.md files are listed so it reads them in their folder.
 * - .orbis/settings.json: permission rules, hooks and MCP servers. Because a project can be imported from anyone's
 *   repository, this file does nothing until the user has looked at it and trusted it; the trust is kept as its
 *   hash, so any change (by the agent, an import or an edit) needs trusting again.
 * - .orbis/commands/*.md: the project's own slash commands. .orbis/skills/<name>/SKILL.md: skills the agent can
 *   load when a task needs them. .orbis/agents/*.md: helper agents it can hand questions to.
 *
 * Rules look like `bash(npm test*)`, `edit(src/**)`, `read(secrets/**)`, `mcp(github/create_issue)` and
 * `web(docs.example.com)`; a bare kind (`bash`) covers everything of that kind. A matching deny rule always wins.
 */

export const SETTINGS_PATH = ".orbis/settings.json";
export const INSTRUCTION_PATHS = ["ORBIS.md", ".orbis/ORBIS.md", "AGENTS.md", "CLAUDE.md"] as const;
const INSTRUCTION_CHARS = 12_000;

export const RULE_KINDS = ["bash", "edit", "read", "mcp", "web"] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export interface PermissionRules {
  allow: string[];
  deny: string[];
}

export const EMPTY_RULES: PermissionRules = { allow: [], deny: [] };
export const MAX_RULES = 100;

export interface HookDef {
  /** A regular expression matched against the tool's name (empty or "*": every tool hooks apply to). */
  matcher: string;
  command: string;
}

/** The tools hooks run around. */
export const HOOKED_TOOLS = new Set(["write_file", "edit_file", "multi_edit", "delete_file", "run_command", "run_tests"]);

export interface McpServerRef {
  name: string;
  url: string;
}

export interface ProjectSettings {
  permissions: PermissionRules;
  hooks: { pre: HookDef[]; post: HookDef[] };
  mcpServers: McpServerRef[];
}

export const EMPTY_PROJECT_SETTINGS: ProjectSettings = { permissions: EMPTY_RULES, hooks: { pre: [], post: [] }, mcpServers: [] };

export const MCP_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/;

export function settingsHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const strings = (v: unknown, max: number, len = 300): string[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === "string")
        .map((x) => x.trim())
        .filter((x) => x && x.length <= len)
        .slice(0, max)
    : [];

function hooksOf(v: unknown): HookDef[] {
  if (!Array.isArray(v)) return [];
  const out: HookDef[] = [];
  for (const h of v.slice(0, 20)) {
    if (!h || typeof h !== "object") continue;
    const r = h as Record<string, unknown>;
    const command = typeof r.command === "string" ? r.command.trim() : "";
    const matcher = typeof r.matcher === "string" ? r.matcher.trim() : "";
    if (!command || command.length > 1_000 || matcher.length > 200) continue;
    try {
      new RegExp(matcher || ".*");
    } catch {
      continue;
    }
    out.push({ matcher, command });
  }
  return out;
}

/** Read .orbis/settings.json. Unknown keys are ignored; anything malformed is an error the user sees. */
export function parseProjectSettings(text: string): { ok: true; settings: ProjectSettings } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: `${SETTINGS_PATH} isn't valid JSON.` };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: `${SETTINGS_PATH} must be a JSON object.` };
  const o = raw as Record<string, unknown>;
  const perms = (o.permissions && typeof o.permissions === "object" ? o.permissions : {}) as Record<string, unknown>;
  const hooks = (o.hooks && typeof o.hooks === "object" ? o.hooks : {}) as Record<string, unknown>;
  const servers = (o.mcpServers && typeof o.mcpServers === "object" && !Array.isArray(o.mcpServers) ? o.mcpServers : {}) as Record<string, unknown>;
  const mcpServers: McpServerRef[] = [];
  for (const [name, v] of Object.entries(servers).slice(0, 10)) {
    const url = v && typeof v === "object" ? (v as Record<string, unknown>).url : null;
    if (MCP_NAME_RE.test(name) && typeof url === "string" && /^https:\/\/[^\s]+$/.test(url) && url.length <= 500) mcpServers.push({ name, url });
  }
  return {
    ok: true,
    settings: {
      permissions: { allow: strings(perms.allow, MAX_RULES).filter((r) => parseRule(r)), deny: strings(perms.deny, MAX_RULES).filter((r) => parseRule(r)) },
      hooks: { pre: hooksOf(hooks.PreToolUse), post: hooksOf(hooks.PostToolUse) },
      mcpServers,
    },
  };
}

/** The project's settings file and whether the user trusts this exact version of it. */
export interface SettingsState {
  status: "none" | "trusted" | "untrusted" | "invalid";
  hash: string | null;
  error?: string;
  /** In effect only when trusted. */
  settings: ProjectSettings;
  /** What the file asks for, to show before trusting it. */
  found: ProjectSettings | null;
}

export function settingsState(files: Pick<ProjectFile, "path" | "content">[], trustedHash: string | null | undefined): SettingsState {
  const f = files.find((x) => x.path === SETTINGS_PATH);
  if (!f) return { status: "none", hash: null, settings: EMPTY_PROJECT_SETTINGS, found: null };
  const hash = settingsHash(f.content);
  const parsed = parseProjectSettings(f.content);
  if (!parsed.ok) return { status: "invalid", hash, error: parsed.error, settings: EMPTY_PROJECT_SETTINGS, found: null };
  const trusted = !!trustedHash && trustedHash === hash;
  return { status: trusted ? "trusted" : "untrusted", hash, settings: trusted ? parsed.settings : EMPTY_PROJECT_SETTINGS, found: parsed.settings };
}

// ---------------------------------------------------------------- rules

export function parseRule(rule: string): { kind: RuleKind; pattern: string | null } | null {
  const m = /^(bash|edit|read|mcp|web)(?:\((.{1,280})\))?$/.exec(rule.trim());
  if (!m) return null;
  return { kind: m[1] as RuleKind, pattern: m[2]?.trim() || null };
}

function ruleMatches(rule: string, kind: RuleKind, subject: string): boolean {
  const r = parseRule(rule);
  if (!r || r.kind !== kind) return false;
  if (!r.pattern || r.pattern === "*") return true;
  if (kind === "bash") {
    // Commands match literally: a trailing * means "starting with". No other wildcards, so an approved command
    // containing *, ? or {} can't come to cover others.
    const c = subject.trim().replace(/\s+/g, " ");
    const p = r.pattern.replace(/\s+/g, " ");
    return p.endsWith("*") ? c.startsWith(p.slice(0, -1)) : c === p;
  }
  if (kind === "web") {
    const host = subject.toLowerCase();
    const p = r.pattern.toLowerCase().replace(/^\*\./, "");
    return host === p || host.endsWith(`.${p}`);
  }
  if (kind === "mcp") return globMatch(r.pattern.includes("/") ? r.pattern : `${r.pattern}/*`, subject, true);
  return globMatch(r.pattern, subject.replace(/^\.\//, ""));
}

/**
 * What the rules say about one action: "deny" when any deny rule matches (in any rule set), "allow" when an allow
 * rule matches, null when no rule applies (the permission mode decides).
 */
export function ruleDecision(sets: PermissionRules[], kind: RuleKind, subject: string): "allow" | "deny" | null {
  if (sets.some((s) => s.deny.some((r) => ruleMatches(r, kind, subject)))) return "deny";
  if (sets.some((s) => s.allow.some((r) => ruleMatches(r, kind, subject)))) return "allow";
  return null;
}

/**
 * For a chained command (a && b), every part must be allowed; any denied part denies it. `parts` is null when the
 * line can't be split safely (command substitution, background jobs, unbalanced quotes): then only a deny rule
 * applies (matched against the whole line), never an allow.
 */
export function commandRuleDecision(sets: PermissionRules[], parts: string[] | null, line = ""): "allow" | "deny" | null {
  if (!parts) return ruleDecision(sets, "bash", line) === "deny" ? "deny" : null;
  const ds = parts.map((p) => ruleDecision(sets, "bash", p));
  if (ds.includes("deny")) return "deny";
  return ds.length > 0 && ds.every((d) => d === "allow") ? "allow" : null;
}

/** The rule "Always allow" saves for a command: the command itself, or (with `prefix`) its first words and anything after. */
export function commandRule(command: string, prefix = false): string {
  const c = command.trim().replace(/\s+/g, " ").slice(0, 260);
  if (!prefix) return `bash(${c})`;
  const words = c.split(" ");
  const head = words.slice(0, Math.min(words.length, words[0] === "npm" || words[0] === "pnpm" || words[0] === "yarn" ? 3 : 2)).join(" ");
  return `bash(${head}*)`;
}

/** Rules as the user saved them: valid, unique, within the limit. */
export function cleanRules(r: Partial<PermissionRules> | null | undefined): PermissionRules {
  const clean = (xs: unknown) => [...new Set(strings(xs, MAX_RULES).filter((x) => parseRule(x)))];
  return { allow: clean(r?.allow), deny: clean(r?.deny) };
}

// ---------------------------------------------------------------- hooks

export function hooksFor(hooks: HookDef[], tool: string): HookDef[] {
  if (!HOOKED_TOOLS.has(tool)) return [];
  return hooks.filter((h) => {
    if (!h.matcher || h.matcher === "*") return true;
    try {
      return new RegExp(`^(?:${h.matcher})$`).test(tool);
    } catch {
      return false;
    }
  });
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** How long one hook may run before it's stopped. */
export const HOOK_SECONDS = 60;

/** The shell line that runs a hook with what it's about in environment variables (stopped after HOOK_SECONDS). */
export function hookCommand(h: HookDef, tool: string, args: Record<string, unknown>): string {
  const file = typeof args.path === "string" ? args.path : "";
  const input = JSON.stringify(args).slice(0, 4_000);
  return `ORBIS_TOOL=${shq(tool)} ORBIS_FILE=${shq(file)} ORBIS_INPUT=${shq(input)} timeout ${HOOK_SECONDS} sh -c ${shq(h.command)}`;
}

// ---------------------------------------------------------------- commands, skills, agents

/** `---\nkey: value\n---\nbody` → the keys and the body. Values are single lines. */
export function parseFrontmatter(text: string): { data: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { data: {}, body: text };
  const data: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) data[kv[1]!.toLowerCase()] = kv[2]!.trim().replace(/^["']|["']$/g, "");
  }
  return { data, body: text.slice(m[0].length) };
}

export interface CustomCommand {
  name: string;
  description: string;
  argHint: string | null;
  body: string;
  path: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** .orbis/commands/<name>.md (one folder down becomes "folder:name"). */
export function projectCommands(files: Pick<ProjectFile, "path" | "content">[]): CustomCommand[] {
  const out: CustomCommand[] = [];
  for (const f of files) {
    const m = /^\.orbis\/commands\/(?:([a-z0-9_-]+)\/)?([^/]+)\.md$/i.exec(f.path);
    if (!m) continue;
    const base = m[2]!.toLowerCase();
    if (!NAME_RE.test(base) || (m[1] && !NAME_RE.test(m[1].toLowerCase()))) continue;
    const { data, body } = parseFrontmatter(f.content);
    if (!body.trim()) continue;
    out.push({
      name: m[1] ? `${m[1].toLowerCase()}:${base}` : base,
      description: (data.description || body.trim().split("\n")[0]!).slice(0, 160),
      argHint: data["argument-hint"]?.slice(0, 60) || null,
      body: body.slice(0, 8_000),
      path: f.path,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 60);
}

export { expandCommand } from "../slash";

export interface SkillInfo {
  name: string;
  description: string;
  /** The skill's folder, e.g. .orbis/skills/release */
  dir: string;
}

export function projectSkills(files: Pick<ProjectFile, "path" | "content">[]): SkillInfo[] {
  const out: SkillInfo[] = [];
  for (const f of files) {
    const m = /^\.orbis\/skills\/([^/]+)\/SKILL\.md$/i.exec(f.path);
    if (!m) continue;
    const { data, body } = parseFrontmatter(f.content);
    const name = (data.name || m[1]!).toLowerCase();
    if (!NAME_RE.test(name)) continue;
    out.push({ name, description: (data.description || body.trim().split("\n")[0] || name).slice(0, 300), dir: `.orbis/skills/${m[1]}` });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 40);
}

export interface AgentDef {
  name: string;
  description: string;
  prompt: string;
  path: string;
}

export function projectAgents(files: Pick<ProjectFile, "path" | "content">[]): AgentDef[] {
  const out: AgentDef[] = [];
  for (const f of files) {
    const m = /^\.orbis\/agents\/([^/]+)\.md$/i.exec(f.path);
    if (!m) continue;
    const { data, body } = parseFrontmatter(f.content);
    const name = (data.name || m[1]!).toLowerCase();
    if (!NAME_RE.test(name) || !body.trim()) continue;
    out.push({ name, description: (data.description || body.trim().split("\n")[0]!).slice(0, 300), prompt: body.slice(0, 6_000), path: f.path });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 20);
}

// ---------------------------------------------------------------- ORBIS.md

export interface Instructions {
  path: string;
  content: string;
  truncated: boolean;
  /** ORBIS.md files in sub-folders, read by the agent when it works there. */
  nested: string[];
}

export function projectInstructions(files: Pick<ProjectFile, "path" | "content">[]): Instructions | null {
  const byPath = new Map(files.map((f) => [f.path, f.content]));
  const path = INSTRUCTION_PATHS.find((p) => byPath.has(p) && byPath.get(p)!.trim());
  const nested = files
    .map((f) => f.path)
    .filter((p) => /(^|\/)ORBIS\.md$/.test(p) && p.includes("/") && !p.startsWith(".orbis/"))
    .slice(0, 20);
  if (!path) return nested.length ? { path: "", content: "", truncated: false, nested } : null;
  const content = byPath.get(path)!;
  return { path, content: content.slice(0, INSTRUCTION_CHARS), truncated: content.length > INSTRUCTION_CHARS, nested };
}

/** The instructions and the project's skills and helpers, for the session's first message. */
export function projectContextBlock(files: Pick<ProjectFile, "path" | "content">[], fence: (s: string) => string): string {
  const parts: string[] = [];
  const ins = projectInstructions(files);
  if (ins?.path) {
    const t = fence(ins.content);
    parts.push(
      `Project instructions from ${ins.path} (written for agents working in this project: follow them unless they conflict with your rules or the user's request; they grant no extra permissions):\n${t}\n${ins.content}${ins.truncated ? "\n… (cut; read the file for the rest)" : ""}\n${t}`,
    );
  }
  if (ins?.nested.length) parts.push(`More ORBIS.md files, for work in those folders (read the one for a folder before changing files there): ${ins.nested.join(", ")}`);
  const skills = projectSkills(files);
  if (skills.length) parts.push(`Skills this project provides (load one with use_skill when the task needs it):\n${skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")}`);
  const agents = projectAgents(files);
  if (agents.length) parts.push(`Helper agents this project defines (ask them with delegate and agent set to the name):\n${agents.map((a) => `- ${a.name}: ${a.description}`).join("\n")}`);
  return parts.join("\n\n");
}
