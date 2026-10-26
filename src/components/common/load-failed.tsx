"use client";
import { cn } from "@/lib/utils";

/** Shown instead of an empty list when the list couldn't be loaded, so a failure never looks like "nothing here". */
export function LoadFailed({ what, onRetry, className }: { what: string; onRetry: () => void; className?: string }) {
  return (
    <p role="alert" className={cn("mt-2 text-[13.5px] text-s-danger", className)}>
      Couldn&apos;t load {what}.{" "}
      <button type="button" onClick={onRetry} className="font-medium underline underline-offset-4 hover:no-underline">
        Try again
      </button>
    </p>
  );
}
