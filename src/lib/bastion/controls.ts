import "server-only";
import { isSupabaseConfigured } from "../env";
import { reportError } from "../observability";
import { serviceSupabase } from "../supabase/admin";
import { createServerSupabase } from "../supabase/server";
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
  return controls;
}
