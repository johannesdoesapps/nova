"use client";
import { Analytics } from "@vercel/analytics/next";
import type { BeforeSendEvent } from "@vercel/analytics";

const ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** Shared links carry a secret code in the address: never count it. */
const SHARE = /^\/share\/(chat\/)?[^/]+/;

/** This browser's choice not to be counted (Settings → Privacy and data, or the Cookie Policy page). */
export const ANALYTICS_OFF_KEY = "orbis:analytics-off";

/**
 * Page addresses as counted: no query string or #fragment (they can hold
 * sign-in codes, chat ids and search text), ids replaced with [id] and shared
 * links' codes with [link], so a visit says which page, never whose or which thing.
 */
export function cleanAnalyticsUrl(url: string): string {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    u.pathname = u.pathname.replace(SHARE, (_m, chat: string | undefined) => `/share/${chat ?? ""}[link]`).replace(ID, "[id]");
    return u.toString();
  } catch {
    return url;
  }
}

/** Whether this browser asked not to be counted: the setting, or a Global Privacy Control / Do Not Track signal. */
export function analyticsDeclined(): boolean {
  try {
    if (localStorage.getItem(ANALYTICS_OFF_KEY) === "1") return true;
  } catch {
    /* storage blocked: fall through to the browser's own signals */
  }
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  return nav.globalPrivacyControl === true || nav.doNotTrack === "1";
}

/** Vercel Web Analytics: cookie-free visit counts (see the Cookie Policy). Nothing is sent when the visitor has opted out. */
export function SiteAnalytics() {
  return <Analytics beforeSend={(e: BeforeSendEvent) => (analyticsDeclined() ? null : { ...e, url: cleanAnalyticsUrl(e.url) })} />;
}
