import "server-only";
import { cache } from "react";
import { isAdmin } from "./admin";
import { getAuth } from "./auth";
import { listConversations, listProjects } from "./db";
import { integrationStatus, isSupabaseConfigured, publicEnv } from "./env";

/** Everything the app chrome needs, loaded once per request on the server. */
export const loadShellData = cache(async function loadShellData() {
  const auth = await getAuth();
  const status = integrationStatus();
  const flag = (id: string) => status.find((s) => s.id === id)?.configured ?? false;

  let conversations: { id: string; title: string; updated_at: string }[] = [];
  let projects: { id: string; name: string; updated_at: string }[] = [];
  if (auth.mode === "authenticated") {
    const [c, p] = await Promise.all([
      listConversations(auth.supabase, auth.user.id, 8).catch(() => []),
      listProjects(auth.supabase, auth.user.id, 6).catch(() => []),
    ]);
    conversations = c;
    projects = p;
  }

  return {
    auth,
    user: auth.user ? { ...auth.user, isAdmin: await isAdmin(auth) } : null,
    integrations: {
      supabase: isSupabaseConfigured(),
      anthropic: flag("anthropic"),
      openai: flag("openai"),
      google: flag("google"),
      xai: flag("xai"),
      deepseek: flag("deepseek"),
      huggingface: flag("huggingface"),
      search: flag("search"),
    },
    recents: { conversations, projects },
    supabasePublic:
      publicEnv.supabaseUrl && publicEnv.supabaseKey ? { url: publicEnv.supabaseUrl, key: publicEnv.supabaseKey } : null,
  };
});
