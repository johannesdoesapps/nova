"use client";
import { useEffect, useState } from "react";
import { Markdown } from "@/components/common/markdown";
import { DEPTHS } from "@/lib/research/research";
import type { ResearchView } from "@/lib/research/server";

/** A plain, printable page of one report (the browser's Print → Save as PDF makes the PDF). */
export function ResearchPrint({ id }: { id: string }) {
  const [run, setRun] = useState<ResearchView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/research/${id}`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j?.error?.message ?? "Couldn't load the report.");
        setRun(j.run);
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);

  if (error) return <main className="mx-auto max-w-3xl p-8 text-[15px]">{error}</main>;
  if (!run) return <main className="mx-auto max-w-3xl p-8 text-[15px]">Loading…</main>;
  const cited = new Set(run.report_check?.cited ?? []);
  return (
    <div className="min-h-dvh bg-white">
      <main className="mx-auto max-w-3xl bg-white p-8 text-[15px] leading-relaxed text-black print:p-0">
        <div className="mb-6 flex items-center gap-3 print:hidden">
          <button type="button" onClick={() => window.print()} className="h-10 rounded-full bg-black px-5 text-[14px] font-medium text-white">
            Print or save as PDF
          </button>
          <span className="text-[13px] text-neutral-600">In the print dialog, choose “Save as PDF” as the destination.</span>
        </div>
        <h1 className="text-[26px] font-semibold leading-snug">{run.question}</h1>
        <p className="mt-1 text-[13px] text-neutral-600">
          Deep Research by Orbis · {new Date(run.created_at).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })} · {DEPTHS[run.depth].label}
          {run.usage.modelName ? ` · ${run.usage.modelName}` : ""}
          {run.usage.searches ? ` · ${run.usage.searches} web searches` : ""}. AI-written from the sources listed; check important facts against them.
        </p>
        <div className="mt-6">
          <Markdown text={run.report ?? "_No report was written._"} validCitations={new Set(run.sources.map((s) => s.n))} className="orbis-prose text-[15px]" />
        </div>
        <h2 className="mt-8 text-[20px] font-semibold">Sources</h2>
        <ol className="mt-3 space-y-3 text-[13px]">
          {run.sources
            .filter((s) => !run.report || cited.has(s.n))
            .map((s) => (
              <li key={s.n} className="break-inside-avoid">
                <span className="font-mono">[{s.n}]</span> {s.title} — {s.domain}
                {s.pageAge ? `, ${s.pageAge}` : ""}
                <br />
                <span className="break-all text-neutral-600">{s.url}</span>
                {s.quotes.slice(0, 3).map((q, i) => (
                  <blockquote key={i} className="mt-1 border-l-2 border-neutral-300 pl-2 italic text-neutral-700">
                    “{q}”
                  </blockquote>
                ))}
              </li>
            ))}
        </ol>
      </main>
    </div>
  );
}
