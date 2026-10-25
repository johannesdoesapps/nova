import { safeNext } from "@/lib/auth-flow";

/**
 * The Orbis mobile apps (iOS and Android, built with Capacitor from `mobile/`) load https://tryorbis.app in a
 * native web view. This module holds the pure rules the web app follows when it runs inside them; the browser
 * side lives in `components/common/native-bridge.tsx`. Nothing here imports Capacitor: the native shell injects
 * `window.Capacitor`, so the website itself keeps working, unchanged, in any browser.
 */

/** The app's id on both stores and its URL scheme (deep links come back as `app.tryorbis.orbis://…`). */
export const APP_ID = "app.tryorbis.orbis";
export const APP_SCHEME = APP_ID;

export type NativePlatform = "ios" | "android";

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: Record<string, unknown>;
}

/** "ios" or "android" inside the Orbis app, null in a browser. */
export function nativePlatform(w: { Capacitor?: CapacitorGlobal } | undefined = typeof window === "undefined" ? undefined : (window as never)): NativePlatform | null {
  const c = w?.Capacitor;
  if (!c?.isNativePlatform?.()) return null;
  const p = c.getPlatform?.();
  return p === "ios" || p === "android" ? p : null;
}

/** A link that leaves Orbis (opened in the in-app browser instead of replacing the app). */
export function isExternalUrl(href: string, origin: string): boolean {
  let u: URL;
  try {
    u = new URL(href, origin);
  } catch {
    return false;
  }
  if (u.protocol === "mailto:" || u.protocol === "tel:") return true;
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  return u.origin !== new URL(origin).origin;
}

/** Where Google sends the person back to when they sign in from the app (the system browser hands it to the app). */
export function nativeOAuthRedirect(next: string, via: "google" | "github" = "google"): string {
  const u = new URL(`${APP_SCHEME}://auth/callback`);
  u.searchParams.set("via", via);
  const n = safeNext(next);
  if (n !== "/") u.searchParams.set("next", n);
  return u.toString();
}

/**
 * The page to open for a deep link into the app, or null to ignore it:
 * - `app.tryorbis.orbis://auth/callback?code=…` → `/auth/callback?code=…` (the server finishes the sign-in with the
 *   PKCE verifier the web view stored when it started it);
 * - `app.tryorbis.orbis://open/<path>` and `https://tryorbis.app/<path>` → `/<path>` (same-site paths only).
 */
export function deepLinkTarget(link: string, siteOrigin = "https://tryorbis.app"): string | null {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return null;
  }
  if (u.protocol === `${APP_SCHEME}:`) {
    // Custom schemes parse "auth" as the host and "/callback" as the path.
    const route = `${u.host}${u.pathname}`.replace(/\/+$/, "");
    if (route === "auth/callback") {
      const q = new URLSearchParams();
      for (const k of ["code", "sb_flow_id", "error", "error_code", "error_description", "via", "next"]) {
        const v = u.searchParams.get(k);
        if (v) q.set(k, k === "next" ? safeNext(v) : v.slice(0, 2000));
      }
      return `/auth/callback?${q.toString()}`;
    }
    if (u.host === "open") {
      const p = safeNext(`${u.pathname}${u.search}`);
      return p === "/" ? "/home" : p;
    }
    return null;
  }
  if ((u.protocol === "https:" || u.protocol === "http:") && u.origin === new URL(siteOrigin).origin) {
    const p = safeNext(`${u.pathname}${u.search}`);
    return p;
  }
  return null;
}

/**
 * What the Android back button does: go back in the web history when there is one, otherwise leave the app
 * (Android's convention) — never navigate somewhere unexpected.
 */
export function backButtonAction(canGoBack: boolean): "back" | "exit" {
  return canGoBack ? "back" : "exit";
}

/**
 * Buying or changing a plan isn't offered inside the store apps: Apple and Google require their own billing for
 * digital subscriptions bought in an app. People manage plans on the website; what they bought works everywhere.
 */
export const NATIVE_PURCHASE_NOTE = "Plans and extra usage can't be bought in the app. You can manage them on tryorbis.app in a web browser; your plan works everywhere you sign in.";
