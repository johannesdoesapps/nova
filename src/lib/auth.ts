import "server-only";
import { displayNameFrom } from "./auth-flow";
import { isSupabaseConfigured, serverEnv } from "./env";
import { ApiError } from "./http";
import { createServerSupabase, type ServerSupabase } from "./supabase/server";

export interface CurrentUser {
  id: string;
  email: string | null;
  displayName: string | null;
}

export type AuthContext =
  | { mode: "authenticated"; user: CurrentUser; supabase: ServerSupabase }
  | { mode: "guest"; user: null; supabase: null };

/**
 * Resolve the caller. `getUser()` validates the session with Supabase Auth,
 * so the result can be trusted for authorisation (unlike `getSession()`).
 *
 * When Supabase is not configured the app runs in guest/demo mode: AI features
 * work (rate-limited by IP) but nothing is persisted.
 */
export async function getAuth(): Promise<AuthContext> {
  if (!isSupabaseConfigured()) return { mode: "guest", user: null, supabase: null };
  const supabase = await createServerSupabase();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return { mode: "guest", user: null, supabase: null };
  const meta = (data.user.user_metadata ?? {}) as Record<string, unknown>;
  return {
    mode: "authenticated",
    supabase,
    user: {
      id: data.user.id,
      email: data.user.email ?? null,
      displayName: displayNameFrom(meta),
    },
  };
}

/**
 * For AI routes: with Supabase configured, a signed-in user is required (so
 * usage can be attributed and limited). Without Supabase, guests are allowed —
 * except in production with a paid provider key, where anonymous use of the
 * owner's key must be enabled explicitly (ORBIS_ALLOW_GUEST_AI=1).
 */
export async function requireUserIfConfigured(): Promise<AuthContext> {
  const env = serverEnv();
  if (!isSupabaseConfigured() && process.env.NODE_ENV === "production" && (env.anthropicKey || env.openaiKey || env.geminiKey || env.xaiKey || env.deepseekKey || env.huggingfaceKey) && !env.allowGuestAi) {
    throw new ApiError(
      "not_configured",
      "This site isn't accepting anonymous AI requests yet. The owner needs to set up accounts (Supabase) or explicitly allow guest use.",
    );
  }
  const auth = await getAuth();
  if (isSupabaseConfigured() && auth.mode !== "authenticated") {
    throw new ApiError("unauthorized", "Please sign in to continue.");
  }
  return auth;
}

/** For persistence routes: always requires Supabase and a signed-in user. */
export async function requireUser(): Promise<Extract<AuthContext, { mode: "authenticated" }>> {
  if (!isSupabaseConfigured()) {
    throw new ApiError(
      "not_configured",
      "Saving requires Supabase. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.",
    );
  }
  const auth = await getAuth();
  if (auth.mode !== "authenticated") throw new ApiError("unauthorized", "Please sign in to continue.");
  return auth;
}
