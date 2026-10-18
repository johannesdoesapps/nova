/** Shared, client-safe limits (no dependencies). */
export const MAX_ATTACHMENT_CHARS = 60_000;
export const ALLOWED_ATTACHMENT_EXT = [".txt", ".md", ".markdown", ".csv", ".json", ".tsv", ".log"] as const;
