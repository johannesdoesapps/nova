"use client";

export type ApiErrorBody = { error?: { code?: string; message?: string; details?: { resetsAt?: string } } };

/** A plain-English message for an HTTP status when the response carries no message of its own (e.g. a proxy's HTML error page). */
export function statusMessage(status: number): string {
  if (status === 401) return "Your session has ended. Sign in again to continue.";
  if (status === 403) return "You don't have access to this.";
  if (status === 404) return "That couldn't be found. It may have been deleted.";
  if (status === 413) return "That's too large to send.";
  if (status === 429) return "Too many requests. Please wait a moment and try again.";
  if (status === 502 || status === 503 || status === 504) return "Orbis is temporarily unavailable. Please try again in a moment.";
  if (status >= 500) return "Something went wrong on Orbis's side. Please try again.";
  return `Request failed (${status}).`;
}

export async function readApiError(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as ApiErrorBody;
    const message = j.error?.message ?? statusMessage(res.status);
    const resetsAt = j.error?.details?.resetsAt ? new Date(j.error.details.resetsAt) : null;
    if (resetsAt && !Number.isNaN(resetsAt.getTime())) {
      const sameDay = resetsAt.toDateString() === new Date().toDateString();
      const time = resetsAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      return `${message} It resets ${sameDay ? `at ${time}` : `on ${resetsAt.toLocaleDateString([], { weekday: "long" })} at ${time}`}.`;
    }
    return message;
  } catch {
    return statusMessage(res.status);
  }
}

/** Plain-English messages for failures that otherwise surface as browser jargon ("Failed to fetch", JSON syntax errors). */
export const OFFLINE_MESSAGE = "Couldn't reach Orbis. Check your internet connection and try again.";
export const GARBLED_MESSAGE = "Orbis received a reply it couldn't read. Please try again.";

/** fetch, with network failures (not user aborts) turned into a readable message. */
async function request(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new Error(OFFLINE_MESSAGE);
  }
}

/** One NDJSON line; a line that isn't valid JSON fails the stream with a readable message. */
export function parseNdjsonLine<T>(line: string): T {
  try {
    return JSON.parse(line) as T;
  } catch {
    throw new Error(GARBLED_MESSAGE);
  }
}

/** POST JSON and iterate NDJSON events from the response. */
export async function* postNdjson<T = Record<string, unknown>>(
  url: string,
  body: unknown,
  signal?: AbortSignal,
): AsyncGenerator<T> {
  const res = await request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...timeZoneHeader() },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) throw Object.assign(new Error(await readApiError(res)), { status: res.status });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (e) {
      // The connection dropped mid-reply (a stop by the user is still an abort).
      if ((e as Error).name === "AbortError") throw e;
      throw new Error(OFFLINE_MESSAGE);
    }
    if (chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield parseNdjsonLine<T>(line);
    }
  }
  if (buf.trim()) yield parseNdjsonLine<T>(buf);
}

export async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await request(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...timeZoneHeader(), ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(await readApiError(res));
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** The browser's IANA time zone, sent with every API call so server-side prompts can use the user's local time. */
function timeZoneHeader(): Record<string, string> {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz ? { "X-ORBIS-Time-Zone": tz } : {};
  } catch {
    return {};
  }
}
