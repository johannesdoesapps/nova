import "server-only";
import { publicEnv } from "./env";

/** true / false when Supabase answered; null when it couldn't be asked (the button then stays usable). */
export type ProviderStatus = { google: boolean | null };

/**
 * Which sign-in providers are switched on in Supabase Auth. Reads the public
 * settings endpoint (no secrets) and caches it briefly, so enabling Google in
 * the Supabase dashboard shows up without a redeploy.
 */
export async function authProviders(): Promise<ProviderStatus> {
  const { supabaseUrl, supabaseKey } = publicEnv;
  if (!supabaseUrl || !supabaseKey) return { google: false };
  try {
    const res = await fetch(`${supabaseUrl.replace(/\/$/, "")}/auth/v1/settings`, {
      headers: { apikey: supabaseKey },
      signal: AbortSignal.timeout(3_000),
      next: { revalidate: 60 },
    });
    if (!res.ok) return { google: null };
    const j = (await res.json()) as { external?: Record<string, unknown> };
    return { google: j.external?.google === true };
  } catch {
    return { google: null };
  }
}
