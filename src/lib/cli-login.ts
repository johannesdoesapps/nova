/**
 * Pure helpers for the terminal app's browser sign-in (/cli/login). Kept free of framework imports so they can be
 * unit-tested and used by both the page and its client component.
 */

/** The port the terminal app listens on: a number from 1024 to 65535, written plainly. */
export function cliPort(v: string | string[] | undefined): number | null {
  const s = Array.isArray(v) ? v[0] : v;
  if (!s || !/^\d{4,5}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1024 && n <= 65535 ? n : null;
}

/** The terminal app's one-time state: URL-safe characters only, 16 to 128 of them. */
export function cliState(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  return s && /^[A-Za-z0-9_-]{16,128}$/.test(s) ? s : null;
}

/**
 * Where the browser sends the tokens: the terminal app on this computer only (127.0.0.1, never a host name), with
 * the tokens in the fragment, which browsers never send to any server.
 */
export function cliCallbackUrl(port: number, tokens: { access_token: string; refresh_token: string; expires_at?: number | null }, state: string): string {
  const frag = new URLSearchParams({ access_token: tokens.access_token, refresh_token: tokens.refresh_token, state, ...(tokens.expires_at ? { expires_at: String(tokens.expires_at) } : {}) });
  return `http://127.0.0.1:${port}/callback#${frag.toString()}`;
}

/** The address of this page, to come back to after signing in. */
export function cliLoginPath(port: number, state: string): string {
  return `/cli/login?port=${port}&state=${encodeURIComponent(state)}`;
}
