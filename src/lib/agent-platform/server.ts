import "server-only";
import { agentSuspended } from "../bastion/server";
import { isAdmin } from "../admin";
import type { AuthContext } from "../auth";
import { workspacesAvailable } from "../code/workspace";
import { entitlementFor } from "../entitlements";
import { isSupabaseConfigured, serverEnv } from "../env";
import { ApiError } from "../http";
import type { PlanId } from "../plans";
import { getPlatformSettings } from "../ai/settings";
import { availability, type Availability, type PlatformFlags } from "./availability";
import { AGENTS, agentDef, type AgentDef, type AgentId } from "./registry";

export function platformFlags(): PlatformFlags {
  const env = serverEnv();
  return {
    ai: Boolean(env.anthropicKey || env.openaiKey || env.geminiKey || env.xaiKey || env.deepseekKey || env.zaiKey || env.huggingfaceKey),
    anthropic: Boolean(env.anthropicKey),
    sandbox: workspacesAvailable(),
    accounts: isSupabaseConfigured(),
  };
}

async function planOf(auth: AuthContext): Promise<{ plan: PlanId | null; admin: boolean }> {
  if (auth.mode !== "authenticated") return { plan: null, admin: false };
  const [entitlement, admin] = await Promise.all([entitlementFor(auth), isAdmin(auth)]);
  return { plan: entitlement?.plan ?? "free", admin: admin || entitlement?.kind === "unlimited" };
}

export interface AgentListing {
  agent: AgentDef;
  availability: Availability;
}

/** Every agent with whether this user can run it here. */
export async function listAgents(auth: AuthContext): Promise<{ agents: AgentListing[]; plan: PlanId | null }> {
  const flags = platformFlags();
  const [{ plan, admin }, settings] = await Promise.all([planOf(auth), getPlatformSettings()]);
  return { agents: AGENTS.map((agent) => ({ agent, availability: availability(agent, flags, plan, admin, settings.pausedAgents) })), plan };
}

/** Refuses (with the reason) unless the user may start a task with this agent here. */
export async function assertAgentAccess(auth: AuthContext, id: AgentId): Promise<AgentDef> {
  const def = agentDef(id);
  if (!def) throw new ApiError("not_found", "Unknown agent.");
  const [{ plan, admin }, settings] = await Promise.all([planOf(auth), getPlatformSettings()]);
  const a = availability(def, platformFlags(), plan, admin, settings.pausedAgents);
  if (a.state === "paused") throw new ApiError("not_configured", `${def.name}: ${a.message}`);
  if (a.state === "setup") throw new ApiError("not_configured", `${def.name}: ${a.message}`);
  if (a.state === "sign_in") throw new ApiError("unauthorized", a.message);
  if (a.state === "upgrade") throw new ApiError("plan_required", `${def.name} isn't included in your plan. ${a.message}`);
  // Orbis Bastion: an agent an administrator suspended can't start anything (and stops at its next step).
  const suspended = await agentSuspended(id, auth.mode === "authenticated" ? { db: auth.supabase, ownerId: auth.user.id } : null);
  if (suspended) throw new ApiError(suspended.kind === "unavailable" ? "provider_unavailable" : "not_configured", `${def.name}: ${suspended.message.replace(/^this agent/, "it")}`);
  return def;
}
