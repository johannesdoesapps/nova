import { cn } from "@/lib/utils";

/** Text-based wordmark. Swap the mark <span> for an SVG icon when one exists. */
export function Logo({ collapsed, className }: { collapsed?: boolean; className?: string }) {
  return (
    <span className={cn("flex items-center gap-2.5 select-none", className)}>
      <span
        aria-hidden
        className="relative grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-accent to-accent-2 text-[13px] font-bold text-white shadow-[0_6px_20px_-8px_var(--accent)]"
      >
        N
        <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-white/90" />
      </span>
      {!collapsed && (
        <span className="text-[15px] font-semibold tracking-[0.18em]">
          NOVARA<span className="ml-1 font-normal tracking-normal text-muted">AI</span>
        </span>
      )}
    </span>
  );
}
