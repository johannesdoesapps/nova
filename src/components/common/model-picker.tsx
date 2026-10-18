"use client";
import { useEffect, useState } from "react";
import type { ModelWithStatus } from "@/lib/ai/types";
import { Select } from "@/components/ui/primitives";

export interface ModelCatalog {
  models: ModelWithStatus[];
  /** Whether Auto mode can be chosen, and why not when it can't. */
  auto: { enabled: boolean; reason: string | null };
}

const EMPTY_CATALOG: ModelCatalog = { models: [], auto: { enabled: false, reason: "Models could not be loaded." } };
let cache: Promise<ModelCatalog> | null = null;

export function fetchCatalog(): Promise<ModelCatalog> {
  cache ??= fetch("/api/models")
    .then((r) => (r.ok ? r.json() : EMPTY_CATALOG))
    .then((j: Partial<ModelCatalog>) => ({ models: j.models ?? [], auto: j.auto ?? EMPTY_CATALOG.auto }))
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
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  useEffect(() => {
    let alive = true;
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

/** The admin's default when set (it comes first), else the first available real model. */
export function defaultModelId(models: ModelWithStatus[] | null): string | undefined {
  if (!models) return undefined;
  return (models.find((m) => m.available && m.isDefault) ?? models.find((m) => m.available && m.provider !== "demo") ?? models.find((m) => m.available))?.id;
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
