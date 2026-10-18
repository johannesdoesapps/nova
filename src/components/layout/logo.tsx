import { cn } from "@/lib/utils";

/** Text-based wordmark. Swap the mark <span> for an SVG icon when one exists. */
export function Logo({ collapsed, className }: { collapsed?: boolean; className?: string }) {
  return (
    <span className={cn("flex items-center gap-2.5 select-none", className)}>
      {/* Same mark as the chat studio: a pearl tile, the N cut out, the brand dot. */}
      <svg viewBox="0 0 32 32" className="h-7 w-7 shrink-0 text-fg" aria-hidden="true">
        <rect x="1" y="1" width="30" height="30" rx="9" fill="currentColor" />
        <path d="M10.5 22.5V10l11 12.5V9.5" fill="none" stroke="var(--bg)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="26.5" cy="5.5" r="2.6" fill="var(--accent-2)" />
      </svg>
      {!collapsed && (
        <span className="text-[15px] font-semibold tracking-[0.22em]">NOVA</span>
      )}
    </span>
  );
}
