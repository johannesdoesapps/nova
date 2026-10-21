import { noteError } from "./alerts";

/**
 * Error reporting seam. Logs server-side, and emails the owner when errors
 * pile up (see alerts.ts; off until it's configured). To enable Sentry,
 * install `@sentry/nextjs`, run its wizard, and forward errors from here.
 */
export function reportError(err: unknown, context?: Record<string, unknown>): void {
  // Never log request bodies or secrets here — only the error and safe context.
  console.error("[orbis]", err instanceof Error ? err.stack ?? err.message : err, context ?? "");
  if (typeof window === "undefined") noteError(err, typeof context?.where === "string" ? context.where : typeof context?.code === "string" ? `error:${context.code}` : "server");
}
