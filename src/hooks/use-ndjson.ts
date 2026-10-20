"use client";

export type ApiErrorBody = { error?: { code?: string; message?: string; details?: { resetsAt?: string } } };

export async function readApiError(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as ApiErrorBody;
    const message = j.error?.message ?? `Request failed (${res.status}).`;
    const resetsAt = j.error?.details?.resetsAt ? new Date(j.error.details.resetsAt) : null;
    if (resetsAt && !Number.isNaN(resetsAt.getTime())) {
      const sameDay = resetsAt.toDateString() === new Date().toDateString();
      const time = resetsAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      return `${message} It resets ${sameDay ? `at ${time}` : `on ${resetsAt.toLocaleDateString([], { weekday: "long" })} at ${time}`}.`;
    }
    return message;
  } catch {
    return `Request failed (${res.status}).`;
  }
}

/** POST JSON and iterate NDJSON events from the response. */
export async function* postNdjson<T = Record<string, unknown>>(
  url: string,
  body: unknown,
  signal?: AbortSignal,
): AsyncGenerator<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...timeZoneHeader() },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(await readApiError(res));
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield JSON.parse(line) as T;
    }
  }
  if (buf.trim()) yield JSON.parse(buf) as T;
}

export async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
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
