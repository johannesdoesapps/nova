"use client";
import { Check } from "lucide-react";
import type { ModelWithStatus } from "@/lib/ai/types";
import { ProviderMark } from "@/components/studio/model-selector";
import { cn } from "@/lib/utils";

/** Real (configured) models first; demo models only when nothing real is set up. */
export function participantPool(models: ModelWithStatus[] | null): ModelWithStatus[] {
  const avail = (models ?? []).filter((m) => m.available);
  const real = avail.filter((m) => m.provider !== "demo");
  return real.length ? real : avail;
}

/** A sensible starting set: one model per provider first, up to `n`. */
export function defaultParticipants(pool: ModelWithStatus[], n = 3): string[] {
  const picked: ModelWithStatus[] = [];
  for (const m of pool) if (picked.length < n && !picked.some((p) => p.provider === m.provider)) picked.push(m);
  for (const m of pool) if (picked.length < n && !picked.includes(m)) picked.push(m);
  return picked.map((m) => m.id);
}

export function ModelChips({
  pool,
  selected,
  onChange,
  max,
  disabled,
}: {
  pool: ModelWithStatus[];
  selected: string[];
  onChange: (ids: string[]) => void;
  max: number;
  disabled?: boolean;
}) {
  return (
    <div role="group" aria-label="Participating models" className="flex flex-wrap gap-1.5">
      {pool.map((m) => {
        const on = selected.includes(m.id);
        const full = !on && selected.length >= max;
        return (
          <button
            key={m.id}
            type="button"
            aria-pressed={on}
            disabled={disabled || full}
            title={full ? `Up to ${max} models` : m.description}
            onClick={() => onChange(on ? selected.filter((x) => x !== m.id) : [...selected, m.id])}
            className={cn(
              "inline-flex h-9 items-center gap-2 rounded-full border pl-1 pr-3 text-[13px] transition duration-200 disabled:opacity-40",
              on ? "border-[color-mix(in_srgb,var(--s-ink)_30%,transparent)] bg-s-hover text-s-ink" : "border-s-line text-s-ink-2 hover:border-s-line-strong hover:text-s-ink",
            )}
          >
            <ProviderMark provider={m.provider} className="h-7 w-7 rounded-full" />
            {m.displayName}
            {on && <Check className="h-3.5 w-3.5 text-s-ink-2" />}
          </button>
        );
      })}
    </div>
  );
}
