import "server-only";
import { createClient } from "@supabase/supabase-js";
import { displayNameFrom } from "./auth-flow";
import type { AuthContext } from "./auth";
import { isSupabaseConfigured, publicEnv } from "./env";
import { ApiError } from "./http";
import { limiter } from "./rate-limit";
import { serviceSupabase } from "./supabase/admin";
import type { ServerSupabase } from "./supabase/server";

/**
 * Sign-in for the Orbis terminal app (public/downloads/orbis-cli.mjs). The app has no cookies: it sends the
 * user's Supabase access token as `Authorization: Bearer …`. The token is checked with Supabase Auth, and every
 * query made with the returned client runs as that user under row-level security, exactly like a browser
 * request, so metering (src/lib/usage.ts) works unchanged. getAuth()/requireUser() are not involved.
 */

export type CliAuth = Extract<AuthContext, { mode: "authenticated" }>;

/** A Supabase access token is a JWT: three base64url parts. Anything else is refused before Supabase is asked. */
const JWT = /^[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,8192}\.[A-Za-z0-9_-]{8,2048}$/;

/** The bearer token on a request, or null. */
export function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m && JWT.test(m[1]!) ? m[1]! : null;
}

/** The terminal app's user, rate limited per user (`bucket`, requests per minute). */
export async function requireCliUser(req: Request, bucket = "cli", perMinute = 120): Promise<CliAuth> {
  if (!isSupabaseConfigured() || !publicEnv.supabaseUrl || !publicEnv.supabaseKey) {
    throw new ApiError("not_configured", "Accounts aren't set up on this site, so the terminal app can't sign in.");
  }
  const token = bearerToken(req);
  if (!token) throw new ApiError("unauthorized", "Sign in first: run `orbis login`.");
  const supabase = createClient(publicEnv.supabaseUrl, publicEnv.supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) throw new ApiError("unauthorized", "Your sign-in has expired or was revoked. Run `orbis login` again.");
  if (!limiter(bucket, perMinute, 60_000).check(`u:${data.user.id}`, 1).ok) {
    throw new ApiError("rate_limited", "Too many requests from the terminal app. Please wait a moment.");
  }
  return {
    mode: "authenticated",
    // The same queries as a request's cookie client; this one carries the user's access token instead.
    supabase: supabase as unknown as ServerSupabase,
    user: { id: data.user.id, email: data.user.email ?? null, displayName: displayNameFrom((data.user.user_metadata ?? {}) as Record<string, unknown>) },
  };
}

/**
 * A new, separate session for the terminal app, for the signed-in user (needs the service role key). The terminal
 * app refreshes its tokens on its own; if it shared the browser's session, each refresh would use up the refresh
 * token the browser still holds, and Supabase signs out the whole session when an old one is reused. Returns null
 * when the site can't mint sessions (no service role key), so the page falls back to the browser's session.
 */
export async function newCliSession(userId: string): Promise<{ access_token: string; refresh_token: string; expires_at: number | null } | null> {
  const admin = serviceSupabase();
  if (!admin || !publicEnv.supabaseUrl || !publicEnv.supabaseKey) return null;
  const { data: found, error: userError } = await admin.auth.admin.getUserById(userId);
  const email = found?.user?.email;
  if (userError || !email) return null;
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const tokenHash = link?.properties?.hashed_token;
  if (linkError || !tokenHash) return null;
  const anon = createClient(publicEnv.supabaseUrl, publicEnv.supabaseKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const { data: verified, error } = await anon.auth.verifyOtp({ type: "email", token_hash: tokenHash });
  const s = verified?.session;
  if (error || !s || verified.user?.id !== userId) return null;
  return { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at ?? null };
}
