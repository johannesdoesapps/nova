import { InfinityMark } from "@/components/brand/infinity";
import { wordmarkFont } from "@/components/brand/fonts";
import { cn } from "@/lib/utils";

/** The Orbis logo: the infinity loop and the "orbis" wordmark. */
export function Logo({ collapsed, className }: { collapsed?: boolean; className?: string }) {
  return (
    <span className={cn("flex items-center gap-2 select-none", className)}>
      <InfinityMark wide weight={6.5} className="h-[22px] w-[38px] shrink-0" />
      {!collapsed && <span className={cn(wordmarkFont.className, "text-[21px] font-semibold leading-none tracking-[-0.01em]")}>orbis</span>}
    </span>
  );
}
