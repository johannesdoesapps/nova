/**
 * Error reporting seam. Logs server-side today. To enable Sentry, install
 * `@sentry/nextjs`, run its wizard, and forward errors from here.
 */
export function reportError(err: unknown, context?: Record<string, unknown>): void {
  // Never log request bodies or secrets here — only the error and safe context.
  console.error("[nova]", err instanceof Error ? err.stack ?? err.message : err, context ?? "");
}
