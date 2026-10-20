import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { CtaBand } from "@/components/marketing/parts";
import { FEATURES, GUIDES } from "@/content/site";
import { pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata({
  title: "Documentation and guides",
  description: "Step-by-step guides for Orbis: getting started, choosing a model, building custom agents, comparing models, planning with Mission Control and running security checks.",
  path: "/docs",
});

export default function DocsPage() {
  return (
    <>
      <section className="mx-auto max-w-5xl px-5 pt-16 pb-8 sm:px-8 sm:pt-20">
        <h1 className="text-balance font-serif text-[44px] leading-[1.05] tracking-[-0.01em] text-fg sm:text-[56px]">Documentation</h1>
        <p className="mt-5 max-w-2xl text-[17px] leading-relaxed text-muted">Practical guides to getting more out of Orbis, written for the features that exist today.</p>
      </section>
      <section aria-labelledby="guides" className="mx-auto max-w-5xl px-5 pb-12 sm:px-8">
        <h2 id="guides" className="text-xl font-medium text-fg">Guides</h2>
        <ul className="mt-5 grid gap-4 md:grid-cols-2">
          {GUIDES.map((g) => {
            const f = FEATURES.find((x) => x.slug === g.feature);
            return (
              <li key={g.slug}>
                <Link href={`/docs/${g.slug}`} className="group flex h-full flex-col rounded-2xl border border-border bg-panel p-6 transition hover:border-border-strong hover:bg-panel-2">
                  {f && <span className="text-xs tracking-wide text-muted uppercase">{f.name}</span>}
                  <h3 className="mt-2 text-lg font-medium text-fg">{g.title}</h3>
                  <p className="mt-2 flex-1 text-[15px] leading-relaxed text-muted">{g.description}</p>
                  <span className="mt-4 inline-flex items-center gap-1.5 text-sm text-fg">
                    Read the guide <ArrowRight className="h-3.5 w-3.5 transition group-hover:translate-x-0.5" aria-hidden />
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>
      <CtaBand />
    </>
  );
}
