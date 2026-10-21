"use client";
import { Analytics } from "@vercel/analytics/next";
import type { BeforeSendEvent } from "@vercel/analytics";

const ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Page addresses as counted: no query string or #fragment (they can hold
 * sign-in codes, chat ids and search text) and ids replaced with [id], so a
 * visit says which page, never whose or which thing.
 */
export function cleanAnalyticsUrl(url: string): string {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    u.pathname = u.pathname.replace(ID, "[id]");
    return u.toString();
  } catch {
    return url;
  }
}

/** Vercel Web Analytics: cookie-free visit counts (see the Privacy Policy). */
export function SiteAnalytics() {
  return <Analytics beforeSend={(e: BeforeSendEvent) => ({ ...e, url: cleanAnalyticsUrl(e.url) })} />;
}
