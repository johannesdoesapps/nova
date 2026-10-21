/** A short excerpt of `text` around the first match of `q` (case-insensitive), for search results. */
export function snippetAround(text: string, q: string, radius = 70): string | null {
  const flat = text.replace(/\s+/g, " ").trim();
  const i = flat.toLowerCase().indexOf(q.trim().toLowerCase());
  if (i < 0) return null;
  const start = Math.max(0, i - radius);
  const end = Math.min(flat.length, i + q.trim().length + radius);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

export const MAX_PINS = 20;

/** Pin or unpin `id`: pinned chats go first, at most MAX_PINS (the oldest pin drops off). */
export function togglePin(pins: string[], id: string, pinned: boolean): string[] {
  const rest = pins.filter((p) => p !== id);
  return pinned ? [id, ...rest].slice(0, MAX_PINS) : rest;
}

/** Stored pins, ignoring anything malformed. */
export function readPins(prefs: unknown): string[] {
  const v = (prefs as { pinnedChats?: unknown } | null)?.pinnedChats;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x)).slice(0, MAX_PINS) : [];
}
