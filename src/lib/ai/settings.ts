import "server-only";
import { isSupabaseConfigured } from "../env";
import { createServerSupabase } from "../supabase/server";
import { DEFAULT_PLATFORM_SETTINGS, parsePlatformSettings, type PlatformSettings } from "./platform";

/** Read platform settings. Readable by everyone (no secrets); writable only by admins (RLS). */
export async function getPlatformSettings(): Promise<PlatformSettings> {
  if (!isSupabaseConfigured()) return DEFAULT_PLATFORM_SETTINGS;
  try {
    const supabase = await createServerSupabase();
    const { data, error } = await supabase.from("app_settings").select("settings").eq("id", 1).maybeSingle();
    if (error || !data) return DEFAULT_PLATFORM_SETTINGS;
    return parsePlatformSettings((data as { settings: unknown }).settings);
  } catch {
    return DEFAULT_PLATFORM_SETTINGS;
  }
}
