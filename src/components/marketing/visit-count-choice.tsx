"use client";
import { useAnalyticsChoice } from "@/components/common/analytics-choice";

/** The visit-count choice for this browser, on the Cookie Policy page. */
export function VisitCountChoice() {
  const { counted, browserSignal, setCounted } = useAnalyticsChoice();
  return (
    <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-panel p-5">
      <div className="min-w-0 sm:max-w-[70%]">
        <h2 className="text-sm font-medium text-fg">Anonymous visit counts on this browser</h2>
        <p className="mt-1 text-sm text-muted" aria-live="polite">
          {browserSignal
            ? "Your browser asks sites not to track it, so visits from this browser aren't counted."
            : counted
              ? "On. Visits are counted without cookies and never linked to you."
              : "Off. Nothing is counted from this browser."}
        </p>
      </div>
      {!browserSignal && (
        <button
          type="button"
          onClick={() => setCounted(!counted)}
          aria-pressed={!counted}
          className="inline-flex h-10 shrink-0 items-center rounded-full border border-border-strong px-4 text-sm font-medium text-fg transition hover:bg-panel-2"
        >
          {counted ? "Turn off" : "Turn on"}
        </button>
      )}
    </div>
  );
}
