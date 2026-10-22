"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Loader2, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface Command {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  keywords?: string;
  /** Keys to show, e.g. ["⌘", "⇧", "O"]. */
  keys?: string[];
  run: () => void;
}

/**
 * A searchable list of commands in a dialog: type to filter, ↑/↓ (or
 * Home/End) to move, Enter to run, Escape to close. It's a standard modal:
 * focus stays in it until it closes, then returns to where it was. The
 * active result is announced to screen readers, as is the number of results.
 */
export function CommandMenu({
  label,
  placeholder,
  commands,
  onClose,
  onQuery,
  loading,
  empty,
  footer,
  limit = 60,
}: {
  label: string;
  placeholder: string;
  commands: Command[];
  onClose: () => void;
  /** Called as the search changes (e.g. to search the server too). */
  onQuery?: (q: string) => void;
  /** Extra results are being fetched. */
  loading?: boolean;
  /** What to show when nothing matches. */
  empty?: (query: string) => ReactNode;
  footer?: ReactNode;
  limit?: number;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();

  // Focus the search box, and give focus back to where it was on close.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => {
      if (before && before.isConnected && before !== document.body) before.focus({ preventScroll: true });
    };
  }, []);

  const results = useMemo(() => {
    const q = query.trim();
    return q ? rankCommands(commands, q) : commands.slice(0, limit);
  }, [commands, query, limit]);
  const index = Math.min(active, Math.max(0, results.length - 1));
  const current = results[index];

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const runAt = (i: number) => {
    const c = results[i];
    if (!c) return;
    onClose();
    c.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const n = results.length;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "Tab") {
      // A modal: move between the search box and the close button; Escape always leaves.
      e.preventDefault();
      (document.activeElement === inputRef.current ? closeRef.current : inputRef.current)?.focus();
    } else if (!n) {
      return;
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((index + 1) % n);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((index - 1 + n) % n);
    } else if (e.key === "Home" && document.activeElement !== inputRef.current) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End" && document.activeElement !== inputRef.current) {
      e.preventDefault();
      setActive(n - 1);
    } else if (e.key === "PageDown") {
      e.preventDefault();
      setActive(Math.min(n - 1, index + 8));
    } else if (e.key === "PageUp") {
      e.preventDefault();
      setActive(Math.max(0, index - 8));
    } else if (e.key === "Enter" && document.activeElement === inputRef.current) {
      e.preventDefault();
      runAt(index);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-start justify-center bg-black/30 px-2 pt-[max(8px,env(safe-area-inset-top))] backdrop-blur-[2px] sm:px-4 sm:pt-[12vh]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onKeyDown={onKeyDown}
        className="glass-strong glass-solid glass-edge s-pop flex max-h-[calc(100dvh-16px)] w-full max-w-[600px] flex-col overflow-hidden rounded-[22px] text-s-ink"
      >
        <div className="flex shrink-0 items-center gap-2.5 border-b border-s-line pl-4 pr-2">
          <Search className="h-4 w-4 shrink-0 text-s-ink-3" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
              onQuery?.(e.target.value);
            }}
            role="combobox"
            aria-label={placeholder}
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={current ? `${listId}-${current.id}` : undefined}
            placeholder={placeholder}
            enterKeyHint="go"
            autoComplete="off"
            spellCheck={false}
            className="h-14 min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-s-ink-3 sm:text-[15px]"
          />
          {loading && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-s-ink-3" aria-hidden />}
          <kbd className="hidden rounded-md border border-s-line px-1.5 py-0.5 text-[11px] text-s-ink-3 sm:inline">Esc</kbd>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-s-ink-3 outline-none transition hover:bg-s-hover hover:text-s-ink focus-visible:ring-2 focus-visible:ring-[var(--s-ring)] sm:h-8 sm:w-8"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="sr-only" role="status" aria-live="polite">
          {query.trim() ? (results.length ? `${results.length} result${results.length === 1 ? "" : "s"}` : "No results") : ""}
        </p>
        <ul id={listId} ref={listRef} role="listbox" aria-label="Results" className="s-scroll min-h-0 flex-1 overflow-y-auto p-2 sm:max-h-[min(60vh,460px)]">
          {results.length === 0 && <li className="px-3 py-6 text-center text-[13.5px] text-s-ink-3">{empty ? empty(query.trim()) : "No matches"}</li>}
          {results.map((c, i) => {
            const header = i === 0 || results[i - 1]!.group !== c.group ? c.group : null;
            const on = i === index;
            return (
              <li key={c.id} role="presentation">
                {header && (
                  <div role="presentation" className="px-3 pb-1 pt-2.5 text-[11px] font-medium uppercase tracking-[0.08em] text-s-ink-3">
                    {header}
                  </div>
                )}
                <div
                  id={`${listId}-${c.id}`}
                  role="option"
                  aria-selected={on}
                  aria-describedby={c.keys ? `${listId}-${c.id}-keys` : undefined}
                  data-index={i}
                  onMouseMove={() => !on && setActive(i)}
                  onClick={() => runAt(i)}
                  className={cn(
                    "flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-[14px] sm:min-h-0 [&_svg]:h-4 [&_svg]:w-4",
                    on && "bg-s-hover shadow-[inset_0_0_0_1.5px_var(--s-ring)]",
                  )}
                >
                  <span className="text-s-ink-2" aria-hidden>
                    {c.icon}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{c.label}</span>
                  {c.hint && <span className="hidden max-w-[40%] truncate text-[12px] text-s-ink-3 sm:inline">{c.hint}</span>}
                  {c.keys && (
                    <span id={`${listId}-${c.id}-keys`} className="hidden shrink-0 items-center gap-0.5 sm:flex">
                      <span className="sr-only">Shortcut: </span>
                      {c.keys.map((k) => (
                        <kbd key={k} className="min-w-[20px] rounded-md border border-s-line px-1 text-center text-[11px] leading-[18px] text-s-ink-3">
                          {k}
                        </kbd>
                      ))}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {footer && <div className="shrink-0 border-t border-s-line px-4 py-2 text-[11.5px] text-s-ink-3">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * Matches for a search, best first: a name that starts with the search, then a
 * name that contains it, then matches only in keywords or descriptions (so
 * "missions" opens Missions, not a page whose description mentions missions).
 * Groups stay together, ordered by their best match.
 */
export function rankCommands<T extends { label: string; group: string; keywords?: string; hint?: string }>(commands: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  const words = q.split(/\s+/);
  const scored = commands
    .map((c, i) => {
      const label = c.label.toLowerCase();
      const hay = `${label} ${c.group} ${c.keywords ?? ""} ${c.hint ?? ""}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return null;
      return { c, i, score: label.startsWith(q) ? 0 : label.includes(q) ? 1 : 2 };
    })
    .filter((x) => x !== null);
  const best = new Map<string, number>();
  for (const x of scored) best.set(x.c.group, Math.min(best.get(x.c.group) ?? 9, x.score));
  const order = [...best.keys()];
  return scored.sort((a, b) => best.get(a.c.group)! - best.get(b.c.group)! || order.indexOf(a.c.group) - order.indexOf(b.c.group) || a.score - b.score || a.i - b.i).map((x) => x.c);
}
