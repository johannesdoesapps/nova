import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { Badge, Card } from "@/components/ui/primitives";

/** Consistent, honest placeholder for features on the roadmap. Nothing here is interactive. */
export function ComingSoon({
  icon: Icon,
  title,
  tagline,
  planned,
  stage,
  note,
}: {
  icon: LucideIcon;
  title: string;
  tagline: string;
  planned: string[];
  stage: string;
  note?: string;
}) {
  return (
    <div className="mx-auto max-w-3xl px-4 pb-16 pt-12 sm:px-6">
      <div className="flex items-center gap-3">
        <span className="grid h-12 w-12 place-items-center rounded-2xl bg-accent-soft text-accent"><Icon className="h-6 w-6" /></span>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            <Badge tone="warning">Coming soon</Badge>
          </div>
          <p className="text-sm text-muted">{tagline}</p>
        </div>
      </div>
      <Card className="mt-8 p-5">
        <div className="text-xs font-medium uppercase tracking-wider text-faint">Planned for {stage}</div>
        <ul className="mt-3 space-y-2">
          {planned.map((p) => (
            <li key={p} className="flex gap-2.5 text-sm text-muted">
              <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-accent/60" />
              {p}
            </li>
          ))}
        </ul>
        {note && <p className="mt-4 border-t border-border pt-4 text-xs text-faint">{note}</p>}
      </Card>
      <p className="mt-6 text-sm text-faint">
        This section is not functional yet. In the meantime, try <Link href="/search" className="text-accent hover:underline">AI Search</Link> or{" "}
        <Link href="/chat" className="text-accent hover:underline">AI Chat</Link>.
      </p>
    </div>
  );
}
