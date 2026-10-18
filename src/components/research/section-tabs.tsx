"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function SectionTabs({ tabs }: { tabs: { href: string; label: string; icon: LucideIcon }[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Section" className="mb-6 flex gap-1 overflow-x-auto border-b border-border">
      {tabs.map((t) => {
        const active = pathname === t.href;
        const Icon = t.icon;
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors",
              active ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg",
            )}
          >
            <Icon className={cn("h-4 w-4", active ? "text-accent" : "text-faint")} />
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
