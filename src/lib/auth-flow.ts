/**
 * Pure helpers for the sign-in flows (email/password and Google via Supabase
 * Auth). Kept free of framework imports so they can be unit-tested.
 */

/** Only same-site relative paths are allowed after sign-in, to prevent open redirects. */
export function safeNext(n: string | string[] | null | undefined): string {
  const v = Array.isArray(n) ? n[0] : n;
  if (!v || !v.startsWith("/") || v.startsWith("//") || v.startsWith("/\\")) return "/";
  // Reject control characters and backslashes, which browsers may read as another origin.
  if (/[\u0000-\u001f\\]/.test(v)) return "/";
  return v;
}

/**
 * Where Supabase sends the browser back after Google. `via=google` lets the
 * callback word its errors for the Google flow; `next` is re-checked there.
 */
export function oauthRedirectTo(origin: string, next: string): string {
  const u = new URL("/auth/callback", origin);
  u.searchParams.set("via", "google");
  if (safeNext(next) !== "/") u.searchParams.set("next", safeNext(next));
  return u.toString();
}

/**
 * Messages the sign-in page can show. The page only accepts these codes in its
 * URL, so a crafted link can't put arbitrary text on NOVA's sign-in screen.
 */
export const LOGIN_MESSAGES = {
  google_cancelled: { tone: "danger", text: "Google sign-in was cancelled. You can try again or use your email instead." },
  google_unavailable: { tone: "danger", text: "Google sign-in isn't available right now. Please use your email and password." },
  google_email_unverified: { tone: "danger", text: "Your Google account's email isn't verified. Verify it with Google, or sign up with email instead." },
  google_expired: { tone: "danger", text: "That sign-in attempt expired or was started in another browser or tab. Please try again." },
  google_failed: { tone: "danger", text: "Google sign-in couldn't be completed. Please try again, or use your email instead." },
  signup_closed: { tone: "danger", text: "New sign-ups are closed right now." },
  email_confirmed: { tone: "success", text: "Your email is confirmed. Sign in with your password to continue." },
} as const satisfies Record<string, { tone: "danger" | "success"; text: string }>;
export type LoginMessageCode = keyof typeof LOGIN_MESSAGES;

export function loginMessage(code: unknown): (typeof LOGIN_MESSAGES)[LoginMessageCode] | null {
  return typeof code === "string" && Object.hasOwn(LOGIN_MESSAGES, code) ? LOGIN_MESSAGES[code as LoginMessageCode] : null;
}

/**
 * Map an error that Supabase or Google reported (on the callback URL or from
 * the client library) to a message code. Provider descriptions are never shown
 * verbatim: they can carry internal details.
 */
export function oauthErrorCode(error: string | null | undefined, errorCode?: string | null): LoginMessageCode {
  const c = `${error ?? ""} ${errorCode ?? ""}`.toLowerCase();
  if (c.includes("access_denied")) return "google_cancelled";
  if (c.includes("provider_disabled") || c.includes("not enabled") || c.includes("unsupported provider")) return "google_unavailable";
  if (c.includes("signup_disabled") || c.includes("signups not allowed")) return "signup_closed";
  if (c.includes("email") && (c.includes("unverified") || c.includes("not verified"))) return "google_email_unverified";
  if (c.includes("flow_state") || c.includes("bad_oauth_state") || c.includes("bad_code_verifier") || c.includes("expired")) return "google_expired";
  return "google_failed";
}

/** Message code when exchanging the callback code for a session fails. */
export function exchangeFailureCode(via: string | null): LoginMessageCode {
  // Email confirmation links: Supabase confirmed the address before redirecting,
  // so the user only needs to sign in normally.
  return via === "google" ? "google_expired" : "email_confirmed";
}

/** Name for a new account from the profile data Supabase stores (email sign-up or Google). */
export function displayNameFrom(meta: Record<string, unknown> | null | undefined): string | null {
  for (const k of ["display_name", "full_name", "name"]) {
    const v = meta?.[k];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 80);
  }
  return null;
}
