"use client";
import { useEffect, useState } from "react";
import type { ModelWithStatus } from "@/lib/ai/types";
import { Select } from "@/components/ui/primitives";

let cache: Promise<ModelWithStatus[]> | null = null;

export function fetchModels(): Promise<ModelWithStatus[]> {
  cache ??= fetch("/api/models")
    .then((r) => (r.ok ? r.json() : { models: [] }))
    .then((j: { models: ModelWithStatus[] }) => j.models)
    .catch(() => {
      cache = null;
      return [];
    });
  return cache;
}

export function useModels() {
  const [models, setModels] = useState<ModelWithStatus[] | null>(null);
  useEffect(() => {
    let alive = true;
    void fetchModels().then((m) => alive && setModels(m));
    return () => {
      alive = false;
    };
  }, []);
  return models;
}

export function defaultModelId(models: ModelWithStatus[] | null): string | undefined {
  if (!models) return undefined;
  return (models.find((m) => m.available && m.provider !== "demo") ?? models.find((m) => m.available))?.id;
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
