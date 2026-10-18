import "server-only";
import { ApiError } from "../http";
import type { ServerSupabase } from "../supabase/server";
import type { AgentInput } from "../agents/schema";
import type { AgentConfig } from "../agents/types";
import { isBuiltinId } from "../agents/types";
import type { ConversationRow } from "./index";

/** Custom agents. Row Level Security limits every query to the signed-in owner. */

interface AgentRow {
  id: string;
  name: string;
  description: string;
  instructions: string;
  icon: string;
  accent: string;
  model_id: string | null;
  capabilities: string[];
  starters: string[];
  created_at: string;
  updated_at: string;
}

const COLUMNS = "id,name,description,instructions,icon,accent,model_id,capabilities,starters,created_at,updated_at";

export function rowToAgent(r: AgentRow): AgentConfig {
  return {
    id: r.id,
    kind: "custom",
    name: r.name,
    description: r.description,
    category: "Custom",
    instructions: r.instructions,
    icon: r.icon as AgentConfig["icon"],
    accent: r.accent as AgentConfig["accent"],
    modelId: r.model_id,
    capabilities: r.capabilities as AgentConfig["capabilities"],
    starters: r.starters,
    temperature: null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function fail(what: string): never {
  throw new ApiError("internal", `Could not save or load ${what}.`);
}

export async function listAgents(db: ServerSupabase, userId: string): Promise<AgentConfig[]> {
  const { data, error } = await db.from("agents").select(COLUMNS).eq("user_id", userId).order("updated_at", { ascending: false }).limit(200);
  if (error) fail("agents");
  return (data as AgentRow[]).map(rowToAgent);
}

export async function getAgent(db: ServerSupabase, userId: string, id: string): Promise<AgentConfig> {
  const { data, error } = await db.from("agents").select(COLUMNS).eq("id", id).eq("user_id", userId).maybeSingle();
  if (error) fail("the agent");
  if (!data) throw new ApiError("not_found", "Agent not found.");
  return rowToAgent(data as AgentRow);
}

const toRow = (a: Partial<AgentInput>) => ({
  ...(a.name !== undefined && { name: a.name }),
  ...(a.description !== undefined && { description: a.description }),
  ...(a.instructions !== undefined && { instructions: a.instructions }),
  ...(a.icon !== undefined && { icon: a.icon }),
  ...(a.accent !== undefined && { accent: a.accent }),
  ...(a.modelId !== undefined && { model_id: a.modelId }),
  ...(a.capabilities !== undefined && { capabilities: a.capabilities }),
  ...(a.starters !== undefined && { starters: a.starters }),
});

export async function createAgent(db: ServerSupabase, userId: string, input: AgentInput): Promise<AgentConfig> {
  const { data, error } = await db.from("agents").insert({ user_id: userId, ...toRow(input) }).select(COLUMNS).single();
  if (error) fail("the agent");
  return rowToAgent(data as AgentRow);
}

export async function updateAgent(db: ServerSupabase, userId: string, id: string, patch: Partial<AgentInput>): Promise<AgentConfig> {
  const { data, error } = await db.from("agents").update(toRow(patch)).eq("id", id).eq("user_id", userId).select(COLUMNS).maybeSingle();
  if (error) fail("the agent");
  if (!data) throw new ApiError("not_found", "Agent not found.");
  return rowToAgent(data as AgentRow);
}

/** Deleting an agent also deletes its conversations (foreign key cascade). */
export async function deleteAgent(db: ServerSupabase, userId: string, id: string) {
  const { data, error } = await db.from("agents").delete().eq("id", id).eq("user_id", userId).select("id");
  if (error) fail("the agent");
  if (!data?.length) throw new ApiError("not_found", "Agent not found.");
}

/** Conversations with one agent, newest first. */
export async function listAgentConversations(db: ServerSupabase, userId: string, agentId: string, limit = 50): Promise<ConversationRow[]> {
  const q = db.from("conversations").select("id,project_id,title,mode,agent_id,builtin_agent,created_at,updated_at").eq("user_id", userId);
  const { data, error } = await (isBuiltinId(agentId) ? q.eq("builtin_agent", agentId) : q.eq("agent_id", agentId))
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) fail("conversations");
  return data as ConversationRow[];
}

/** True when a conversation row belongs to the given agent. */
export function conversationIsFor(c: ConversationRow, agentId: string) {
  return isBuiltinId(agentId) ? c.builtin_agent === agentId : c.agent_id === agentId;
}
