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

/**
 * Where usage records (model_runs) are written: the service role, because people mustn't be able to write their own
 * cost records (they count toward the site-wide cap). Without one (local development) the person's own session.
 */
export function usageWriter<T>(own: T): SupabaseClient | T {
  return serviceSupabase() ?? own;
}
