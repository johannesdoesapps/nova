import "server-only";
import { isIP } from "node:net";
import { connectorKeyConfigured, open, seal } from "@/lib/connectors/crypto";
import { ApiError, requireUuid } from "@/lib/http";
import { isPublicAddress } from "@/lib/security/net-pure";
import { reportError } from "@/lib/observability";
import type { McpServer } from "@/lib/mcp/client";
import { cleanRules, EMPTY_RULES, INSTRUCTION_PATHS, MCP_NAME_RE, type PermissionRules, type ProjectSettings } from "./agent/settings";
import type { ProjectFile } from "./projects";
import { dbError, type Authed } from "./server";

/**
 * The agent settings the user chose for a project (code_projects.agent_settings, theirs under row-level security):
 * permission rules, MCP servers (a token, when one is given, is sealed with the server's key and never sent back to
 * the page), and the hash of the project's .orbis/settings.json version they trusted.
 */

export interface StoredMcp {
  name: string;
  url: string;
  /** Sealed "Bearer …" header value. */
  token?: string;
}

export interface AgentSettingsRow {
  rules?: PermissionRules;
  mcp?: StoredMcp[];
  trustedSettings?: string | null;
}

export interface PublicAgentSettings {
  rules: PermissionRules;
  mcp: { name: string; url: string; hasToken: boolean }[];
  trustedSettings: string | null;
}

export const MAX_MCP_SERVERS = 8;

const binding = (userId: string, projectId: string, name: string) => `${userId}:mcp:${projectId}:${name}`;

export async function getAgentSettings(auth: Authed, projectId: string): Promise<AgentSettingsRow> {
  requireUuid(projectId);
  const { data, error } = await auth.supabase.from("code_projects").select("agent_settings").eq("id", projectId).maybeSingle();
  if (error) throw dbError(error, "code.agent_settings.get");
  if (!data) throw new ApiError("not_found", "Project not found.");
  const s = ((data as { agent_settings: AgentSettingsRow | null }).agent_settings ?? {}) as AgentSettingsRow;
  return { rules: cleanRules(s.rules), mcp: Array.isArray(s.mcp) ? s.mcp.filter((m) => m && MCP_NAME_RE.test(m.name) && typeof m.url === "string") : [], trustedSettings: typeof s.trustedSettings === "string" ? s.trustedSettings : null };
}

export async function saveAgentSettings(auth: Authed, projectId: string, next: AgentSettingsRow): Promise<AgentSettingsRow> {
  const value: AgentSettingsRow = { rules: cleanRules(next.rules), mcp: (next.mcp ?? []).slice(0, MAX_MCP_SERVERS), trustedSettings: next.trustedSettings ?? null };
  const { error } = await auth.supabase.from("code_projects").update({ agent_settings: value }).eq("id", projectId);
  if (error) throw dbError(error, "code.agent_settings.save");
  return value;
}

export function publicSettings(s: AgentSettingsRow): PublicAgentSettings {
  return { rules: s.rules ?? EMPTY_RULES, mcp: (s.mcp ?? []).map((m) => ({ name: m.name, url: m.url, hasToken: !!m.token })), trustedSettings: s.trustedSettings ?? null };
}

/** Save one more rule (the "Always allow" button). */
export async function addRule(auth: Authed, projectId: string, list: "allow" | "deny", rule: string): Promise<PermissionRules> {
  const s = await getAgentSettings(auth, projectId);
  const rules = cleanRules({ ...(s.rules ?? EMPTY_RULES), [list]: [...(s.rules?.[list] ?? []), rule] });
  await saveAgentSettings(auth, projectId, { ...s, rules });
  return rules;
}

/** An MCP server to add: its token sealed for this user, project and name. */
export function sealedServer(auth: Authed, projectId: string, input: { name: string; url: string; token?: string | null }): StoredMcp {
  if (!MCP_NAME_RE.test(input.name)) throw new ApiError("bad_request", "Use a short name: lowercase letters, digits, - and _.");
  if (!/^https:\/\/[^\s]+$/.test(input.url) || input.url.length > 500) throw new ApiError("bad_request", "The server's address must start with https://.");
  const unreachable = mcpAddressProblem(input.url);
  if (unreachable) throw new ApiError("bad_request", unreachable);
  const token = input.token?.trim();
  if (!token) return { name: input.name, url: input.url };
  if (!connectorKeyConfigured()) throw new ApiError("not_configured", "Servers that need a token can't be added until the site's connector key is set up (ORBIS_CONNECTOR_KEY).");
  const header = /^(bearer|basic|token)\s/i.test(token) ? token : `Bearer ${token}`;
  return { name: input.name, url: input.url, token: seal(header.slice(0, 4_000), binding(auth.user.id, projectId, input.name)) };
}

/**
 * Why Orbis could never connect to this address, said when the server is added rather than at the agent's first call.
 * Only what the address itself shows (a private IP, localhost, a port other than 443); names that resolve to private
 * addresses are still refused at connect time by the guarded POST.
 */
export function mcpAddressProblem(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "That isn't a valid address.";
  }
  if (u.port && u.port !== "443") return "Orbis connects to MCP servers on the standard HTTPS port (443) only.";
  const host = u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || (isIP(host) && !isPublicAddress(host)))
    return "That address is private or internal. Orbis only connects to servers on the public internet; run local servers with the terminal app.";
  return null;
}

/** The servers the agent may use this step: the user's own, and those the trusted project settings name. */
export function mcpServersFor(auth: Authed, projectId: string, stored: StoredMcp[], project: ProjectSettings): McpServer[] {
  const out: McpServer[] = [];
  for (const m of stored) {
    let authorization: string | null = null;
    if (m.token) {
      try {
        authorization = open(m.token, binding(auth.user.id, projectId, m.name));
      } catch (err) {
        reportError(err, { where: "code.mcp.unseal" });
        continue;
      }
    }
    out.push({ name: m.name, url: m.url, authorization, scope: `${auth.user.id}:${projectId}`, own: true });
  }
  for (const m of project.mcpServers) if (!out.some((o) => o.name === m.name)) out.push({ name: m.name, url: m.url, scope: `${auth.user.id}:${projectId}` });
  return out.slice(0, MAX_MCP_SERVERS + 4);
}

/** The project's .orbis folder and its instruction files, without loading every file in the project. */
export async function getOrbisFiles(auth: Authed, projectId: string): Promise<ProjectFile[]> {
  const [a, b] = await Promise.all([
    auth.supabase.from("code_files").select("path, content").eq("project_id", projectId).like("path", ".orbis/%").limit(300),
    auth.supabase.from("code_files").select("path, content").eq("project_id", projectId).in("path", [...INSTRUCTION_PATHS]).limit(10),
  ]);
  if (a.error) throw dbError(a.error, "code.files.orbis");
  if (b.error) throw dbError(b.error, "code.files.instructions");
  return [...((a.data ?? []) as ProjectFile[]), ...((b.data ?? []) as ProjectFile[])];
}
