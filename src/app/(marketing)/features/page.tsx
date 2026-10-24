import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { CtaBand, SectionHeading, StatusBadge } from "@/components/marketing/parts";
import { PILLARS, STATUS_LABEL, featuresIn } from "@/content/site";
import { pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata({
  title: "Features",
  description: "Everything Orbis can do: AI chat, model comparison, a coding agent, custom agents, Mission Control, Connectors and security agents, with each feature's status.",
  path: "/features",
});

export default function FeaturesPage() {
  return (
    <>
      <section className="mx-auto max-w-6xl px-5 pt-16 pb-8 sm:px-8 sm:pt-20">
        <h1 className="text-balance max-w-3xl font-serif text-[44px] leading-[1.05] tracking-[-0.01em] text-fg sm:text-[56px]">Orbis features</h1>
        <p className="mt-5 max-w-2xl text-[17px] leading-relaxed text-muted">
          What each part of Orbis does, who it&rsquo;s for and what its limits are. Every feature is labelled{" "}
          {Object.values(STATUS_LABEL).join(", ").replace(/, ([^,]*)$/, " or $1")}.
        </p>
      </section>
      {PILLARS.map((p) => (
        <section key={p.id} aria-labelledby={`group-${p.id}`} className="mx-auto max-w-6xl px-5 pb-14 sm:px-8">
          <p className="text-xs font-medium tracking-[0.18em] text-accent-2 uppercase">{p.label}</p>
          <h2 id={`group-${p.id}`} className="mt-2 font-serif text-[32px] leading-tight text-fg">
            {p.title}
          </h2>
          <ul className="mt-6 grid gap-4 md:grid-cols-2">
            {featuresIn(p.id).map((f) => (
              <li key={f.slug} className="min-w-0">
                <Link href={`/features/${f.slug}`} className="group flex h-full flex-col rounded-2xl border border-border bg-panel p-5 transition sm:p-7 hover:border-border-strong hover:bg-panel-2">
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                    <h3 className="text-xl font-medium text-fg">{f.name}</h3>
                    <StatusBadge status={f.status} />
                  </div>
                  <p className="mt-3 flex-1 text-[15px] leading-relaxed text-muted">{f.description}</p>
                  <span className="mt-5 inline-flex items-center gap-1.5 text-sm text-fg">
                    Read more about {f.name} <ArrowRight className="h-3.5 w-3.5 transition group-hover:translate-x-0.5" aria-hidden />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <section className="mx-auto max-w-6xl px-5 py-12 sm:px-8">
        <SectionHeading title="Coming later" intro="Ideas on Orbis's roadmap that you can't use today: a knowledge graph, visual workflows, conversation branching and a privacy center. They'll appear here with a status when they're ready to try." />
      </section>
      <CtaBand />
    </>
  );
}
