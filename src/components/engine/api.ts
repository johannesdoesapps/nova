"use client";
import { useCallback, useEffect, useState } from "react";
import { jsonFetch } from "@/hooks/use-ndjson";

/** Browser → Next.js → Python engine. Paths are engine paths, e.g. "lab/workflows". */
export const engine = {
  get: <T,>(path: string) => jsonFetch<T>(`/api/engine/${path}`),
  post: <T,>(path: string, body: unknown = {}) => jsonFetch<T>(`/api/engine/${path}`, { method: "POST", body: JSON.stringify(body) }),
  put: <T,>(path: string, body: unknown) => jsonFetch<T>(`/api/engine/${path}`, { method: "PUT", body: JSON.stringify(body) }),
  patch: <T,>(path: string, body: unknown) => jsonFetch<T>(`/api/engine/${path}`, { method: "PATCH", body: JSON.stringify(body) }),
  del: <T,>(path: string) => jsonFetch<T>(`/api/engine/${path}`, { method: "DELETE" }),
};

/** Load an engine resource; `reload` refetches. `poll` (ms) refreshes while `pollWhile` is true. */
export function useEngine<T>(path: string | null, opts: { poll?: number; pollWhile?: (d: T) => boolean } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const reload = useCallback(async () => {
    if (!path) return;
    try {
      const d = await engine.get<T>(path);
      setData(d);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    // Fetching on mount/path change is the purpose of this hook.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);
  const { poll, pollWhile } = opts;
  useEffect(() => {
    if (!poll || !data || (pollWhile && !pollWhile(data))) return;
    const t = setTimeout(() => void reload(), poll);
    return () => clearTimeout(t);
  }, [data, poll, pollWhile, reload]);
  return { data, error, loading, reload, setData };
}
