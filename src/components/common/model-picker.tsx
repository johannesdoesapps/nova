"use client";
import { useEffect, useState } from "react";
import type { ModelWithStatus } from "@/lib/ai/types";
import { Select } from "@/components/ui/primitives";
import { cheapestModel } from "@/lib/ai/router";

export interface ModelCatalog {
  models: ModelWithStatus[];
  /** Whether Auto mode can be chosen, and why not when it can't. */
  auto: { enabled: boolean; reason: string | null };
}

const EMPTY_CATALOG: ModelCatalog = { models: [], auto: { enabled: false, reason: "Models could not be loaded." } };
let cache: Promise<ModelCatalog> | null = null;
// The last list this tab loaded, so pages opened later show it at once.
let latest: ModelCatalog | null = null;
// The last good list is kept in this browser too, so the model picker has a name to show on the
// first paint of the next visit; the fresh list from the server replaces it a moment later.
const STORED_KEY = "orbis:catalog:v1";

function readStored(): ModelCatalog | null {
  try {
    const v = JSON.parse(localStorage.getItem(STORED_KEY) ?? "null") as Partial<ModelCatalog> | null;
    return v && Array.isArray(v.models) && v.models.length && v.auto ? { models: v.models, auto: v.auto } : null;
  } catch {
    return null;
  }
}

export function fetchCatalog(): Promise<ModelCatalog> {
  cache ??= fetch("/api/models")
    .then((r) => (r.ok ? r.json() : EMPTY_CATALOG))
    .then((j: Partial<ModelCatalog>) => {
      const c = { models: j.models ?? [], auto: j.auto ?? EMPTY_CATALOG.auto };
      if (c.models.length) {
        latest = c;
        try {
          localStorage.setItem(STORED_KEY, JSON.stringify(c));
        } catch {
          /* storage full or blocked: only the first paint is slower */
        }
      }
      return c;
    })
    .catch(() => {
      cache = null;
      return EMPTY_CATALOG;
    });
  return cache;
}

export function fetchModels(): Promise<ModelWithStatus[]> {
  return fetchCatalog().then((c) => c.models);
}

export function useCatalog(): ModelCatalog | null {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(latest);
  useEffect(() => {
    let alive = true;
    // The stored list, if any, until the fresh one arrives (read after mount: the server has no storage).
    if (!latest) void Promise.resolve().then(() => alive && setCatalog((c) => c ?? readStored()));
    void fetchCatalog().then((c) => alive && setCatalog(c));
    return () => {
      alive = false;
    };
  }, []);
  return catalog;
}

export function useModels() {
  return useCatalog()?.models ?? null;
}

/** The admin's default when set, else the lowest-cost available model (same rule as the server). */
export function defaultModelId(models: ModelWithStatus[] | null): string | undefined {
  if (!models) return undefined;
  return (models.find((m) => m.available && m.isDefault) ?? cheapestModel(models))?.id;
}

export function ModelPicker({
  value,
  onChange,
  models,
  className,
}: {
  value: string | undefined;
  onChange: (id: string) => void;
  models: ModelWithStatus[] | null;
  className?: string;
}) {
  return (
    <Select value={value ?? ""} onChange={(e) => onChange(e.target.value)} className={className} aria-label="Model" disabled={!models}>
      {!models && <option value="">Loading models…</option>}
      {models?.map((m) => (
        <option key={m.id} value={m.id} disabled={!m.available}>
          {m.displayName}
          {m.available ? "" : " — needs API key"}
        </option>
      ))}
    </Select>
  );
}
