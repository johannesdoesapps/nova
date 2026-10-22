import { ChipMark } from "@/components/brand/chip";
import { cn } from "@/lib/utils";

/** The Orbis logo: the chip mark and the wordmark. */
export function Logo({ collapsed, className }: { collapsed?: boolean; className?: string }) {
  return (
    <span className={cn("flex items-center gap-2.5 select-none", className)}>
      <ChipMark className="h-7 w-7 shrink-0" />
      {!collapsed && (
        <span className="text-[15px] font-semibold tracking-[0.22em]">ORBIS</span>
      )}
    </span>
  );
}
