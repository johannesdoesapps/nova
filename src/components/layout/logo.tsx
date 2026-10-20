import { cn } from "@/lib/utils";

/** Text-based wordmark. Swap the mark <span> for an SVG icon when one exists. */
export function Logo({ collapsed, className }: { collapsed?: boolean; className?: string }) {
  return (
    <span className={cn("flex items-center gap-2.5 select-none", className)}>
      {/* Same mark as the chat studio: a pearl tile with an orbit and its moon. */}
      <svg viewBox="0 0 32 32" className="h-7 w-7 shrink-0 text-fg" aria-hidden="true">
        <rect x="1" y="1" width="30" height="30" rx="9" fill="currentColor" />
        <circle cx="16" cy="16" r="7" fill="none" stroke="var(--bg)" strokeWidth="2.4" />
        <circle cx="20.95" cy="11.05" r="2.9" fill="var(--accent-2)" stroke="currentColor" strokeWidth="1.6" />
      </svg>
      {!collapsed && (
        <span className="text-[15px] font-semibold tracking-[0.22em]">ORBIS</span>
      )}
    </span>
  );
}
