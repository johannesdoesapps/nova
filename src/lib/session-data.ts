import "server-only";
import { cache } from "react";
import { isAdmin } from "./admin";
import { getAuth } from "./auth";
import { listConversations, listProjects } from "./db";
import { integrationStatus, isSupabaseConfigured, publicEnv } from "./env";
import { isFirstRun, readOnboarding, type OnboardingState } from "./onboarding";

/** Everything the app chrome needs, loaded once per request on the server. */
export const loadShellData = cache(async function loadShellData() {
  const auth = await getAuth();
  const status = integrationStatus();
  const flag = (id: string) => status.find((s) => s.id === id)?.configured ?? false;

  let conversations: { id: string; title: string; updated_at: string }[] = [];
  let projects: { id: string; name: string; updated_at: string }[] = [];
  let preferredModel: string | null = null;
  let onboarding: OnboardingState | null = null;
  let firstRun = false;
  if (auth.mode === "authenticated") {
    const [c, p, prof, code] = await Promise.all([
      listConversations(auth.supabase, auth.user.id, 8).catch(() => []),
      listProjects(auth.supabase, auth.user.id, 6).catch(() => []),
      auth.supabase.from("profiles").select("preferences").eq("id", auth.user.id).maybeSingle(),
      auth.supabase.from("code_projects").select("id", { count: "exact", head: true }),
    ]);
    conversations = c;
    projects = p;
    const chatModel = (prof.data?.preferences as { chatModel?: unknown } | null)?.chatModel;
    preferredModel = typeof chatModel === "string" ? chatModel : null;
    onboarding = readOnboarding(prof.data?.preferences);
    // Only when everything loaded: a failed read never shows onboarding to someone who already has work.
    firstRun = !prof.error && !code.error && isFirstRun({ onboarding, conversations: c.length, codeProjects: code.count ?? 0 });
  }

  return {
    auth,
    user: auth.user ? { ...auth.user, isAdmin: await isAdmin(auth), preferredModel, onboarding, firstRun } : null,
    integrations: {
      supabase: isSupabaseConfigured(),
      anthropic: flag("anthropic"),
      openai: flag("openai"),
      google: flag("google"),
      xai: flag("xai"),
      deepseek: flag("deepseek"),
      huggingface: flag("huggingface"),
      search: flag("search"),
      billing: flag("billing"),
    },
    recents: { conversations, projects },
    supabasePublic:
      publicEnv.supabaseUrl && publicEnv.supabaseKey ? { url: publicEnv.supabaseUrl, key: publicEnv.supabaseKey } : null,
  };
});
