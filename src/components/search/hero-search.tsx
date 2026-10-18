"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowRight, Search } from "lucide-react";

export const SUGGESTED_PROMPTS = [
  "Find the latest developments in open-source AI.",
  "Compare the best AI models for coding.",
  "Research business opportunities in Europe.",
  "Explain a complex topic with cited sources.",
  "Analyze the pros and cons of launching a startup.",
];

export function HeroSearch({ autoFocus }: { autoFocus?: boolean }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const go = (query: string) => {
    const t = query.trim();
    if (t.length >= 2) router.push(`/search?q=${encodeURIComponent(t)}`);
  };
  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          go(q);
        }}
        className="group relative flex items-center rounded-2xl border border-border-strong bg-panel/90 p-1.5 shadow-[0_20px_60px_-30px_var(--accent)] focus-within:border-accent/60"
      >
        <Search className="ml-3 h-5 w-5 shrink-0 text-faint group-focus-within:text-accent" aria-hidden />
        <input
          autoFocus={autoFocus}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          maxLength={500}
          placeholder="Ask anything — answers come with sources"
          aria-label="Search question"
          className="h-12 min-w-0 flex-1 bg-transparent px-3 text-base text-fg placeholder:text-faint focus:outline-none focus-visible:outline-none"
        />
        <button
          type="submit"
          disabled={q.trim().length < 2}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent text-white transition hover:brightness-110 disabled:opacity-40"
          aria-label="Search"
        >
          <ArrowRight className="h-5 w-5" />
        </button>
      </form>
      <div className="mt-4 flex flex-wrap gap-2">
        {SUGGESTED_PROMPTS.map((p) => (
          <button
            key={p}
            onClick={() => go(p)}
            className="rounded-full border border-border bg-panel/60 px-3 py-1.5 text-left text-[13px] text-muted transition hover:border-accent/40 hover:text-fg"
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}
