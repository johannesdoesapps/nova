"use client";
import { createBrowserClient } from "@supabase/ssr";

let client: ReturnType<typeof createBrowserClient> | null = null;

/** Browser Supabase client (auth flows only — data access goes through API routes). */
export function browserSupabase(url: string, key: string) {
  if (!client) client = createBrowserClient(url, key);
  return client;
}
