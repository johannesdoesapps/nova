import type { SupabaseClient } from "@supabase/supabase-js";
import { LEGAL } from "@/content/legal-meta";

/**
 * Acceptance of the Terms of Service and Privacy Policy. Every signed-in user
 * must have accepted the current version of both before using the app; the
 * record lives in `legal_acceptances` (append-only for users).
 */

export const LEGAL_DOCUMENTS = ["terms", "privacy"] as const;

/** Set once the current version is known to be accepted, so pages don't ask the database each time. */
export const ACCEPTED_COOKIE = "orbis_terms";
/** Set by the sign-up form just before "Continue with Google/GitHub": both boxes were ticked. */
export const PENDING_COOKIE = "orbis_terms_pending";

/**
 * Pages anyone may see without having accepted: the public site, the legal
 * pages themselves, sign-in, and the page that asks for acceptance.
 */
const OPEN_PREFIXES = ["/features", "/pricing", "/docs", "/security", "/privacy", "/terms", "/login", "/auth", "/reset-password", "/consent", "/share"];

export function needsAcceptance(path: string): boolean {
  if (path === "/") return false;
  return !OPEN_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/** Whether this user has accepted both documents at the current version. Null when it can't be checked. */
export async function hasAccepted(supabase: SupabaseClient, version = LEGAL.version): Promise<boolean | null> {
  const { data, error } = await supabase.from("legal_acceptances").select("document").eq("version", version).limit(10);
  if (error) return null;
  const docs = new Set((data as { document: string }[]).map((r) => r.document));
  return LEGAL_DOCUMENTS.every((d) => docs.has(d));
}

export async function recordAcceptance(supabase: SupabaseClient, method: "signup" | "prompt", version = LEGAL.version): Promise<boolean> {
  const { error } = await supabase.from("legal_acceptances").insert(LEGAL_DOCUMENTS.map((document) => ({ document, version, method })));
  return !error;
}

export const acceptedCookieOptions = { httpOnly: true, secure: true, sameSite: "lax" as const, path: "/", maxAge: 60 * 60 * 24 * 365 };
