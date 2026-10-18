import "server-only";
import type { AuthContext } from "./auth";
import { ApiError } from "./http";

/** Server-side admin check. Admins are rows in public.admins (added with SQL); RLS enforces the same rule on writes. */
export async function isAdmin(auth: AuthContext): Promise<boolean> {
  if (auth.mode !== "authenticated") return false;
  const { data, error } = await auth.supabase.from("admins").select("user_id").eq("user_id", auth.user.id).maybeSingle();
  return !error && !!data;
}

export async function requireAdmin(auth: AuthContext): Promise<AuthContext & { mode: "authenticated" }> {
  if (auth.mode !== "authenticated") throw new ApiError("unauthorized", "Sign in as an administrator.");
  if (!(await isAdmin(auth))) throw new ApiError("forbidden", "Only administrators can change platform settings.");
  return auth;
}
