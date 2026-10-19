import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { publicEnv, serverEnv } from "../env";

let client: SupabaseClient | null = null;

/**
 * A Supabase client with the service role, which bypasses row-level security.
 * Only for trusted server code that has no user session: the Stripe webhook
 * and site-wide totals. Never expose its results or the key to browsers.
 */
export function serviceSupabase(): SupabaseClient | null {
  const key = serverEnv().supabaseServiceRoleKey;
  if (!key || !publicEnv.supabaseUrl) return null;
  client ??= createClient(publicEnv.supabaseUrl, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}
