import { ACCEPTED_COOKIE, PENDING_COOKIE } from "./legal";

/**
 * What signing out removes from the browser, kept in one place so the server
 * route and the page agree. Session cookies are Supabase's
 * `sb-<project>-auth-token` (split into `.0`, `.1`… when large) and the PKCE
 * verifier of a sign-in that was started but not finished. The terms cookie
 * only caches one account's acceptance, so it must not carry over to whoever
 * signs in next on this browser.
 */

/** Set for a few minutes after signing out, so the sign-in page can say so. */
export const SIGNED_OUT_COOKIE = "orbis_signed_out";

const SESSION_COOKIE = /^sb-[a-z0-9-]+-auth-token(-code-verifier)?(\.\d+)?$/i;

export function cookiesToClear(names: string[]): string[] {
  return names.filter((n) => SESSION_COOKIE.test(n) || n === ACCEPTED_COOKIE || n === PENDING_COOKIE);
}

/**
 * Browser storage that belongs to the signed-in account (not to the device): the last chat and
 * project opened, a sign-up's pending first task, a hand-off between pages, and the model list,
 * which reflects the account's plan. Theme, layout and other device preferences are kept.
 */
export const ACCOUNT_STORAGE_KEYS = ["orbis:last-chat", "orbis:last-code", "orbis:pending-start", "orbis:verify:prefill", "orbis:catalog:v1", "orbis:admin:answer-check:last"];

/** Run in the browser just before the sign-out request; never throws. */
export function forgetAccountData(storage: Pick<Storage, "removeItem"> | null = typeof window === "undefined" ? null : window.localStorage) {
  try {
    for (const k of ACCOUNT_STORAGE_KEYS) storage?.removeItem(k);
    if (typeof window !== "undefined") window.sessionStorage.clear();
  } catch {
    // Storage can be unavailable (private mode, blocked site data); the server still ends the session.
  }
}
