"use client";
import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { diffHunks, diffStats } from "@/lib/code/diff";
import type { FileChange } from "@/lib/code/projects";
import { cn } from "@/lib/utils";

/**
 * One file's change: added lines green, removed red, with a few lines of
 * context. With `onToggle` it has a checkbox to include it; `actions` adds
 * buttons to its header.
 */
export function FileDiff({
  change,
  checked,
  onToggle,
  stale,
  actions,
  note,
  defaultOpen = true,
}: {
  change: FileChange;
  checked?: boolean;
  onToggle?: () => void;
  stale?: boolean;
  actions?: ReactNode;
  note?: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const before = change.before ?? "";
  const after = change.after ?? "";
  const hunks = useMemo(() => diffHunks(before, after), [before, after]);
  const stats = useMemo(() => diffStats(before, after), [before, after]);
  const kind = change.before === null ? "New file" : change.after === null ? "Deleted" : null;
  return (
    <div className="overflow-hidden rounded-xl border border-s-line">
      <div className="flex items-center gap-2 bg-s-hover/60 px-2.5 py-1.5">
        {onToggle && <input type="checkbox" checked={!!checked} onChange={onToggle} aria-label={`Include ${change.path}`} />}
        <button type="button" onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-1 text-left" aria-expanded={open}>
          {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
          <span className="truncate font-mono text-[12px]">{change.path}</span>
        </button>
        {kind && <span className="shrink-0 rounded-full border border-s-line px-1.5 text-[10.5px] text-s-ink-3">{kind}</span>}
        <span className="shrink-0 font-mono text-[11px] text-emerald-600 dark:text-emerald-400">+{stats.added}</span>
        <span className="shrink-0 font-mono text-[11px] text-s-danger">−{stats.removed}</span>
        {actions}
      </div>
      {note && <div className="border-t border-s-line px-2.5 py-1 text-[11.5px] text-s-ink-3">{note}</div>}
      {stale && <p className="border-t border-s-line px-2.5 py-1 text-[11.5px] text-s-danger">You changed this file after asking. Accepting replaces your newer edits.</p>}
      {open && (
        <div className="s-scroll max-h-72 overflow-auto border-t border-s-line bg-[var(--s-code,transparent)] font-mono text-[11.5px] leading-[1.55]">
          {hunks.length === 0 && <div className="px-2.5 py-1.5 text-s-ink-3">{change.after === null ? "Removes an empty file." : "Empty file."}</div>}
          {hunks.map((h, i) => (
            <div key={i} className={cn(i > 0 && "border-t border-dashed border-s-line")}>
              {h.lines.map((l, j) => (
                <div
                  key={j}
                  className={cn(
                    "flex whitespace-pre",
                    l.kind === "add" && "bg-emerald-500/12",
                    l.kind === "del" && "bg-red-500/12",
                  )}
                >
                  <span className="w-9 shrink-0 select-none pr-1.5 text-right text-s-ink-3">{l.oldNo ?? ""}</span>
                  <span className="w-9 shrink-0 select-none pr-1.5 text-right text-s-ink-3">{l.newNo ?? ""}</span>
                  <span className="w-4 shrink-0 select-none text-center text-s-ink-3">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
                  <span className="pr-3">{l.text || " "}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
