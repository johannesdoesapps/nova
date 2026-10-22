"use client";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { isAutoId } from "@/lib/ai/router-modes";
import type { ModelCatalog } from "@/components/common/model-picker";

const KEY = "orbis:code:model";
export const CODE_AUTO = "auto:coding";

/**
 * The model the coding agent uses, remembered on this device across the start
 * screen and every project. A model that is no longer available falls back to
 * Auto (Coding).
 */
export function useCodeModel(catalog: ModelCatalog | null): [string, (id: string) => void] {
  const [stored, setStored] = useLocalStorage(KEY);
  const wanted = stored ?? CODE_AUTO;
  const usable = isAutoId(wanted) ? !catalog || catalog.auto.enabled : !catalog || catalog.models.some((m) => m.id === wanted && m.available && !m.locked);
  return [usable ? wanted : CODE_AUTO, setStored];
}
