"use client";
import Link from "next/link";
import type { ComponentProps } from "react";
import { track } from "@vercel/analytics";

/**
 * A link whose clicks are counted (anonymously, by Vercel Web Analytics) with
 * where on the page it was, e.g. which call to action people use.
 */
export function TrackedLink({ event, where, onClick, ...props }: ComponentProps<typeof Link> & { event: string; where: string }) {
  return (
    <Link
      {...props}
      onClick={(e) => {
        try {
          track(event, { where });
        } catch {
          /* not counted */
        }
        onClick?.(e);
      }}
    />
  );
}
