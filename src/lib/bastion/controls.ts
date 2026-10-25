import "server-only";
import { isSupabaseConfigured } from "../env";
import { reportError } from "../observability";
import { serviceSupabase } from "../supabase/admin";
import { createServerSupabase } from "../supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { alertOwner } from "../alerts";
import { macFor } from "../connectors/crypto";
import { latestPolicy, type AuditRow, type Mac } from "./customer/records";
import type { PolicyVersion } from "./customer/policy";
import { DEFAULT_CONTROLS, parseControls, type BastionControls } from "./policy";

/**
 * Bastion's controls live in app_settings.settings.bastion (read by everyone, changed only by administrators).
 * They're cached for a few seconds per server instance, so a change reaches every instance within that time.
 */

const CACHE_MS = 10_000;
const FAILED_CACHE_MS = 3_000;
let cache: { at: number; ttl: number; controls: BastionControls | null } | null = null;

export function invalidateControls() {
  cache = null;
}

/** The current controls, or null when they can't be confirmed (fail closed). */
export async function loadControls(): Promise<BastionControls | null> {
  if (!isSupabaseConfigured()) return DEFAULT_CONTROLS;
  if (cache && Date.now() - cache.at < cache.ttl) return cache.controls;
  let controls: BastionControls | null = null;
  try {
    const db = serviceSupabase() ?? (await createServerSupabase());
    const { data, error } = await db.from("app_settings").select("settings").eq("id", 1).maybeSingle();
    if (!error) controls = parseControls(((data as { settings?: Record<string, unknown> } | null)?.settings ?? {}).bastion);
    if (error) reportError(new Error(`Bastion couldn't read its controls: ${error.message}`), { where: "bastion.controls" });
  } catch (err) {
    reportError(err, { where: "bastion.controls" });
  }
  cache = { at: Date.now(), ttl: controls ? CACHE_MS : FAILED_CACHE_MS, controls };
  // A failed enforcement service is the platform's problem to know about at once (once an hour per server).
  if (!controls) alertOwner("bastion-controls", "Orbis Bastion is failing closed", "Bastion couldn't read or validate its controls (app_settings.settings.bastion). Protected actions are refused until it can. Check the database and the Bastion page.");
  return controls;
}

/* ---------------------------------------------------------- workspace policy */

/** Signs and checks Bastion's audit records (null when the server key isn't configured: records are unsigned). */
export const bastionMac: Mac = (data) => macFor("bastion-audit", data);

const WS_CACHE_MS = 10_000;
const WS_CACHE_MAX = 500;
const wsCache = new Map<string, { at: number; value: WorkspacePolicyState }>();
export type WorkspacePolicyState = { current: PolicyVersion; history: PolicyVersion[]; rejected: number } | "unavailable";

export function invalidateWorkspacePolicy(ownerId: string) {
  wsCache.delete(ownerId);
}

/**
 * A workspace's policy, read from its own audit trail with the session (or scoped client) passed in. Cached per
 * workspace for a few seconds; "unavailable" when it can't be read (callers fail closed).
 */
export async function loadWorkspacePolicy(db: SupabaseClient, ownerId: string): Promise<WorkspacePolicyState> {
  const hit = wsCache.get(ownerId);
  if (hit && Date.now() - hit.at < WS_CACHE_MS) return hit.value;
  let value: WorkspacePolicyState = "unavailable";
  try {
    const { data, error } = await db.from("security_audit").select("action,detail,created_at").eq("user_id", ownerId).eq("action", "bastion.policy").order("created_at", { ascending: false }).limit(30);
    if (!error) value = latestPolicy(bastionMac, ownerId, (data ?? []) as AuditRow[]);
    else reportError(new Error(`Bastion couldn't read a workspace policy: ${error.message}`), { where: "bastion.workspace-policy" });
  } catch (err) {
    reportError(err, { where: "bastion.workspace-policy" });
  }
  if (wsCache.size >= WS_CACHE_MAX) wsCache.delete(wsCache.keys().next().value!);
  wsCache.set(ownerId, { at: Date.now(), value });
  return value;
}
