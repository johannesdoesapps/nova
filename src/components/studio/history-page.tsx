"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { FolderKanban, Pin, Search } from "lucide-react";
import { MODE_LABELS, type ChatMode } from "@/lib/ai/modes";
import { ago } from "@/lib/home";
import { StudioHeader, useStudio } from "./frame";
import { groupByDate, type ConvSummary } from "./history";

/** All conversations: pinned first, then the recent ones; signed in, a search across every chat by title and message text. */
export function HistoryPage() {
  const { history, conversations } = useStudio();
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ q: string; items: ConvSummary[] } | { q: string; error: string } | null>(null);
  const search = history.store.search;

  useEffect(() => {
    const q = query.trim();
    if (!q || !search) return;
    let alive = true;
    const t = setTimeout(() => {
      search(q)
        .then((items) => alive && setFound({ q, items }))
        .catch((e: Error) => alive && setFound({ q, error: e.message }));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query, search]);

  const q = query.trim();
  const list = useMemo(() => {
    if (!q) return conversations;
    if (search) return found && found.q === q && "items" in found ? found.items : null;
    return (conversations ?? []).filter((c) => c.title.toLowerCase().includes(q.toLowerCase()));
  }, [q, conversations, found, search]);
  const error = q && found?.q === q && "error" in found ? found.error : null;

  return (
    <>
      <StudioHeader>
        <h1 className="text-[14px] font-medium text-s-ink-2">Conversations</h1>
      </StudioHeader>
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[760px] px-4 pb-24 pt-2 sm:px-8">
          <h2 className="font-serif text-[clamp(30px,5vw,40px)] leading-tight">Conversations</h2>
          <p className="mt-2 text-[15px] text-s-ink-2">
            {history.store.kind === "local"
              ? "Chats kept in this browser. Sign in to keep them across devices."
              : "Pinned chats first, then the newest. Use a chat’s ⋯ menu in the sidebar to pin, rename, move it to a project, download or delete it. Archived chats are in Settings."}
          </p>
          <div className="relative mt-6">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-s-ink-3" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={search ? "Search titles and messages" : "Search chats by title"}
              aria-label="Search chats"
              className="h-10 w-full rounded-xl border border-s-line bg-transparent pl-9 pr-3 text-[14px] outline-none transition placeholder:text-s-ink-3 focus:border-s-line-strong"
            />
          </div>
          <div className="mt-4" aria-live="polite">
            {error ? (
              <p className="py-4 text-[14px] text-s-ink-3">Search failed: {error}</p>
            ) : list === null ? (
              <div className="space-y-3 py-2" role="status" aria-label={q ? "Searching" : "Loading chats"}>
                {[76, 58, 84, 66].map((w, i) => (
                  <div key={i} className="s-skeleton h-4" style={{ width: `${w}%` }} />
                ))}
              </div>
            ) : list.length === 0 ? (
              <div className="py-4 text-[14px] text-s-ink-3">
                {q ? (
                  <>
                    <p>No chats match “{q}”.</p>
                    <p className="mt-1 text-[13px]">{search ? "Titles and message text were searched. Archived chats are not included." : "Only titles are searched in a guest browser."}</p>
                  </>
                ) : (
                  <p>
                    No conversations yet.{" "}
                    <Link href="/chat?new=1" className="text-s-ink underline underline-offset-4">
                      Start one
                    </Link>
                  </p>
                )}
              </div>
            ) : (
              [...(q ? [] : [{ label: "Pinned", items: list.filter((c) => c.pinned) }]), ...groupByDate(q ? list : list.filter((c) => !c.pinned))]
                .filter((g) => g.items.length)
                .map((g) => (
                  <section key={g.label} className="mt-5 first:mt-0">
                    <h3 className="px-3 pb-1 text-[12px] font-medium text-s-ink-3">{g.label}</h3>
                    <ul className="flex flex-col">
                      {g.items.map((c) => (
                        <li key={c.id}>
                          <Link href={`/chat?c=${c.id}`} className="flex items-start gap-3 rounded-xl px-3 py-2.5 transition hover:bg-s-hover">
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1.5">
                                {c.pinned && <Pin className="h-3.5 w-3.5 shrink-0 text-s-ink-3" aria-label="Pinned" />}
                                <span className="truncate text-[14.5px]">{c.title}</span>
                              </span>
                              {q && c.snippet && <span className="mt-0.5 line-clamp-2 block text-[12.5px] leading-snug text-s-ink-3">{c.snippet}</span>}
                            </span>
                            {c.project_name ? (
                              <span
                                className="hidden max-w-[160px] shrink-0 items-center gap-1 truncate rounded-full border border-s-line px-2 py-0.5 text-[11.5px] text-s-ink-2 sm:inline-flex"
                                title={`In project ${c.project_name}`}
                              >
                                <FolderKanban className="h-3 w-3 shrink-0" />
                                <span className="truncate">{c.project_name}</span>
                              </span>
                            ) : (
                              <span className="hidden shrink-0 pt-0.5 text-[12px] text-s-ink-3 sm:inline">{MODE_LABELS[c.mode as ChatMode]?.label ?? ""}</span>
                            )}
                            <time
                              dateTime={c.updated_at}
                              title={`Last active ${new Date(c.updated_at).toLocaleString()}`}
                              className="w-20 shrink-0 pt-0.5 text-right text-[12px] text-s-ink-3"
                              suppressHydrationWarning
                            >
                              {ago(c.updated_at)}
                            </time>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))
            )}
          </div>
        </div>
      </div>
    </>
  );
}
