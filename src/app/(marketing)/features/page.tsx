import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { CtaBand, SectionHeading, StatusBadge } from "@/components/marketing/parts";
import { FEATURES, STATUS_LABEL } from "@/content/site";
import { pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata({
  title: "Features",
  description: "Everything NOVA can do today — AI assistant, coding assistant, custom agents, model comparison, Mission Control, security agents and the Autonomous Developer preview — with each feature's status.",
  path: "/features",
});

export default function FeaturesPage() {
  return (
    <>
      <section className="mx-auto max-w-6xl px-5 pt-16 pb-8 sm:px-8 sm:pt-20">
        <h1 className="text-balance max-w-3xl font-serif text-[44px] leading-[1.05] tracking-[-0.01em] text-fg sm:text-[56px]">NOVA features</h1>
        <p className="mt-5 max-w-2xl text-[17px] leading-relaxed text-muted">
          What each part of NOVA does, who it&rsquo;s for and what its limits are. Every feature is labelled{" "}
          {Object.values(STATUS_LABEL).slice(0, 3).join(", ").replace(/, ([^,]*)$/, " or $1")}.
        </p>
      </section>
      <section aria-labelledby="all-features" className="mx-auto max-w-6xl px-5 pb-12 sm:px-8">
        <h2 id="all-features" className="sr-only">All features</h2>
        <ul className="grid gap-4 md:grid-cols-2">
          {FEATURES.map((f) => (
            <li key={f.slug}>
              <Link href={`/features/${f.slug}`} className="group flex h-full flex-col rounded-2xl border border-border bg-panel p-7 transition hover:border-border-strong hover:bg-panel-2">
                <div className="flex items-center justify-between gap-3">
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
      <section className="mx-auto max-w-6xl px-5 py-12 sm:px-8">
        <SectionHeading title="Not built yet" intro="Ideas on NOVA's roadmap that you can't use today: a knowledge graph, visual workflows, conversation branching and a privacy center. They'll appear here with a status when they're ready to try." />
      </section>
      <CtaBand />
    </>
  );
}
