"use client";
import { useEffect, useId, useState } from "react";
import { Feather } from "lucide-react";
import { DEFAULT_NATURAL, INTENSITIES, INTENSITY_INFO, NATURAL_STYLES, naturalSettings, STYLE_INFO, type NaturalSettings } from "@/lib/writing/natural";
import { cn } from "@/lib/utils";

const KEY = "orbis.natural-writing";

/** The Writing Agent's Natural Writing controls, remembered in this browser (a convenience; the server validates every request). */
export function useNaturalWriting(): { on: boolean; settings: NaturalSettings; setOn: (v: boolean) => void; set: (p: Partial<NaturalSettings>) => void } {
  const [state, setState] = useState<{ on: boolean; settings: NaturalSettings }>({ on: false, settings: DEFAULT_NATURAL });
  useEffect(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as { on?: boolean; settings?: unknown } | null;
      const parsed = naturalSettings.safeParse(raw?.settings ?? {});
      // Reading this browser's saved choice once, after mount (localStorage isn't available while rendering on the server).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (raw) setState({ on: !!raw.on, settings: parsed.success ? parsed.data : DEFAULT_NATURAL });
    } catch {
      /* private window or blocked storage: start from the defaults */
    }
  }, []);
  const save = (next: { on: boolean; settings: NaturalSettings }) => {
    setState(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* not remembered; still applies to this page */
    }
  };
  return { ...state, setOn: (on) => save({ ...state, on }), set: (p) => save({ ...state, settings: { ...state.settings, ...p } }) };
}

/**
 * Natural Writing: rewrite text so it reads naturally for its audience, keeping its meaning, facts, citations
 * and voice. A style, a rewrite intensity and (for "Match my writing style") a sample of the author's writing.
 */
export function NaturalWritingBar({ nw, disabled }: { nw: ReturnType<typeof useNaturalWriting>; disabled?: boolean }) {
  const id = useId();
  const { on, settings: s } = nw;
  return (
    <div className="mb-2 s-card rounded-2xl bg-s-glass px-3 py-2 text-[13px]">
      <label className="flex cursor-pointer items-center gap-2">
        <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => nw.setOn(e.target.checked)} className="h-4 w-4 accent-[var(--s-accent)]" />
        <Feather className="h-3.5 w-3.5 text-s-ink-3" aria-hidden />
        <span className="font-medium">Natural writing</span>
        <span className="text-s-ink-3">{on ? `${INTENSITY_INFO[s.intensity].label} · ${STYLE_INFO[s.style].label}` : "Rewrite text so it reads naturally, keeping its meaning and facts"}</span>
      </label>
      {on && (
        <div className="mt-2 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={`${id}-style`} className="text-s-ink-3">
              Style
            </label>
            <select
              id={`${id}-style`}
              value={s.style}
              disabled={disabled}
              onChange={(e) => nw.set({ style: e.target.value as NaturalSettings["style"] })}
              className="h-8 rounded-lg border border-s-line-strong bg-s-bg px-2 text-[13px]"
            >
              {NATURAL_STYLES.map((v) => (
                <option key={v} value={v}>
                  {STYLE_INFO[v].label}
                </option>
              ))}
            </select>
            <span className="text-s-ink-3" id={`${id}-int`}>
              Rewrite
            </span>
            <div role="radiogroup" aria-labelledby={`${id}-int`} className="inline-flex rounded-lg border border-s-line-strong p-0.5">
              {INTENSITIES.map((v) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={s.intensity === v}
                  title={INTENSITY_INFO[v].scope}
                  disabled={disabled}
                  onClick={() => nw.set({ intensity: v })}
                  className={cn("h-7 rounded-md px-2.5 text-[12.5px]", s.intensity === v ? "bg-s-ink text-s-bg" : "text-s-ink-2 hover:bg-s-hover")}
                >
                  {INTENSITY_INFO[v].label}
                </button>
              ))}
            </div>
            <label className="ml-auto inline-flex items-center gap-1.5 text-s-ink-2">
              <input type="checkbox" checked={s.explain} disabled={disabled} onChange={(e) => nw.set({ explain: e.target.checked })} className="h-3.5 w-3.5 accent-[var(--s-accent)]" />
              Explain changes
            </label>
          </div>
          {s.style === "my_style" && (
            <div>
              <label htmlFor={`${id}-sample`} className="block text-s-ink-3">
                A sample of your own writing (optional, up to 4,000 characters). Without one, the rewrite keeps the voice of the text you give it.
              </label>
              <textarea
                id={`${id}-sample`}
                value={s.sample ?? ""}
                maxLength={4000}
                rows={3}
                disabled={disabled}
                onChange={(e) => nw.set({ sample: e.target.value || undefined })}
                className="mt-1 w-full resize-y rounded-lg border border-s-line-strong bg-s-bg px-2.5 py-1.5 text-[13px]"
              />
            </div>
          )}
          <p className="text-[12px] text-s-ink-3">
            Paste the text to rewrite below. Facts, numbers, citations, quotes and links are kept, and a writing check compares the result with your original (open it under the reply to compare or
            copy the original back). It improves the writing; it doesn&apos;t promise anything about AI detectors.
          </p>
        </div>
      )}
    </div>
  );
}
