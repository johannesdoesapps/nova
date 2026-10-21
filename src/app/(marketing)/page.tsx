import { getImageProps } from "next/image";
import Link from "next/link";
import { ArrowRight, Check, ServerCog, ShieldCheck, Undo2 } from "lucide-react";
import { CtaBand, PrimaryCta, SecondaryCta, SectionHeading, StatusBadge } from "@/components/marketing/parts";
import { ProductTour } from "@/components/marketing/product-tour";
import { DEMOS, HERO_SHOT } from "@/content/demos";
import { FAQ, PILLARS, PRICING, featuresIn } from "@/content/site";
import { jsonLd, pageMetadata, siteUrl } from "@/lib/seo";

export const metadata = pageMetadata({
  title: "Orbis — an AI coding agent that checks its own work",
  description:
    "Describe a website or a fix. Orbis's coding agent builds it on a private computer, runs the tests, checks websites in a real browser and shows you every change. Claude and GPT chat included. Free to start.",
  path: "/",
  absoluteTitle: true,
});

const PROOF = ["No credit card to start", "Websites checked in a real browser", "Every change reviewable and undoable"];

const TRUST = [
  {
    icon: ShieldCheck,
    title: "It asks before it acts",
    text: "The coding agent runs tests, builds and its preview on its own but asks before other commands, and never deploys or pushes. Changes to connected apps always wait for your confirmation.",
  },
  {
    icon: Undo2,
    title: "Every change can be undone",
    text: "Each session lists the files it changed as diffs. Revert a whole session or a single file from the Changes panel.",
  },
  {
    icon: ServerCog,
    title: "Code runs in isolation",
    text: "Commands and previews run on a short-lived computer for your project, with internet limited to package registries and none of Orbis's keys inside.",
  },
];

export default function HomePage() {
  const url = siteUrl();
  const { props: { srcSet: heroWide } } = getImageProps({ src: HERO_SHOT.wide.src, width: HERO_SHOT.wide.width, height: HERO_SHOT.wide.height, alt: "", sizes: "(min-width: 1100px) 1024px, 100vw" });
  const { props: heroNarrow } = getImageProps({ src: HERO_SHOT.narrow.src, width: HERO_SHOT.narrow.width, height: HERO_SHOT.narrow.height, alt: "", sizes: "100vw", loading: "eager" });
  const structured = [
    { "@context": "https://schema.org", "@type": "WebSite", name: "Orbis", url },
    {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "Orbis",
      url,
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web",
      description: "AI workspace with Claude and GPT models, a coding agent with an isolated workspace, model comparison, custom agents and project planning.",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: "Free plan" },
    },
  ];

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(structured) }} />

      {/* Hero */}
      <section aria-labelledby="hero-title" className="mx-auto max-w-6xl px-5 pt-14 pb-12 sm:px-8 sm:pt-20">
        <div className="mx-auto max-w-3xl text-center">
          <p className="mk-rise inline-flex items-center gap-2 rounded-full border border-border bg-panel-2 px-3 py-1 text-xs text-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />
            AI coding agent and workspace · Free to start
          </p>
          <h1 id="hero-title" className="text-balance mk-rise mt-6 font-serif text-[42px] leading-[1.02] tracking-[-0.015em] text-fg sm:text-[66px]">
            Describe it. Orbis builds it and checks its own work.
          </h1>
          <p className="mk-rise mx-auto mt-6 max-w-2xl text-[17px] leading-relaxed text-muted sm:text-[19px]">
            The coding agent writes the code on a private computer, runs the tests, opens websites in a real browser at desktop and phone sizes, and shows you exactly what changed — and what it
            couldn&apos;t verify. Claude and GPT models for everything else, in the same workspace.
          </p>
          <div className="mk-rise mt-9 flex flex-wrap items-center justify-center gap-3">
            <PrimaryCta />
            <SecondaryCta href="#see-it-work">Explore Orbis</SecondaryCta>
          </div>
          <ul className="mk-rise mt-7 flex flex-wrap justify-center gap-x-6 gap-y-2 text-[13.5px] text-muted" aria-label="At a glance">
            {PROOF.map((p) => (
              <li key={p} className="inline-flex items-center gap-1.5">
                <Check className="h-3.5 w-3.5 text-success" aria-hidden />
                {p}
              </li>
            ))}
          </ul>
        </div>

        <figure className="mx-auto mt-14 max-w-5xl">
          <div className="lux-card overflow-hidden rounded-[22px] p-1.5 sm:p-2">
            {/* Phones get a crop of the agent panel, which stays readable at that size. One <picture>, so only the image that fits is downloaded. */}
            <picture>
              <source media="(min-width: 640px)" srcSet={heroWide} sizes="(min-width: 1100px) 1024px, 100vw" />
              <img {...heroNarrow} alt={HERO_SHOT.wide.alt} fetchPriority="high" className="aspect-[780/1227] h-auto w-full rounded-[16px] sm:aspect-[2400/1457]" />
            </picture>
          </div>
          <figcaption className="mt-3 text-center text-xs text-muted">{HERO_SHOT.caption}</figcaption>
        </figure>
      </section>

      {/* See it work */}
      <section id="see-it-work" aria-labelledby="tour-title" className="mx-auto max-w-6xl scroll-mt-20 px-5 py-20 sm:px-8">
        <SectionHeading
          id="tour-title"
          eyebrow="See it work"
          title="Real runs, not mock-ups"
          intro="Captured from Orbis itself. Pick a workflow to see what you'd do and what you'd get back."
          center
        />
        <div className="mt-10">
          <ProductTour demos={DEMOS} />
        </div>
      </section>

      {/* Three pillars */}
      <section aria-labelledby="pillars-title" className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
        <SectionHeading id="pillars-title" eyebrow="What you can do" title="Think, build and execute in one place" intro="Everything in Orbis serves one of three jobs. Each feature shows whether you can use it today." />
        <div className="mt-12 grid gap-5 lg:grid-cols-3">
          {PILLARS.map((p) => (
            <article key={p.id} aria-labelledby={`pillar-${p.id}`} className="lux-card flex flex-col rounded-[22px] p-7">
              <p className="text-xs font-medium tracking-[0.18em] text-accent-2 uppercase">{p.label}</p>
              <h3 id={`pillar-${p.id}`} className="text-balance mt-3 font-serif text-[30px] leading-[1.08] text-fg">
                {p.title}
              </h3>
              <p className="mt-3 text-[15px] leading-relaxed text-muted">{p.text}</p>
              <ul className="mt-6 flex-1 space-y-2">
                {featuresIn(p.id).map((f) => (
                  <li key={f.slug}>
                    <Link href={`/features/${f.slug}`} className="group flex items-center gap-3 rounded-xl border border-border bg-panel px-3.5 py-2.5 transition hover:border-border-strong hover:bg-panel-2">
                      <span className="min-w-0 flex-1 text-[15px] text-fg">{f.name}</span>
                      <StatusBadge status={f.status} />
                      <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted transition group-hover:translate-x-0.5 group-hover:text-fg" aria-hidden />
                    </Link>
                  </li>
                ))}
              </ul>
              <Link href={p.href} className="mt-6 inline-flex items-center gap-1.5 text-sm text-fg underline-offset-4 hover:underline">
                {p.cta} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            </article>
          ))}
        </div>
      </section>

      {/* Trust */}
      <section aria-labelledby="trust-title" className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
        <SectionHeading
          id="trust-title"
          eyebrow="Trust"
          title="Built so you can check its work"
          intro={
            <>
              What Orbis stores, where your messages go and what agents may do — in plain language on{" "}
              <Link href="/security" className="text-fg underline underline-offset-4 hover:text-accent-2">
                Security &amp; data
              </Link>
              .
            </>
          }
        />
        <ul className="mt-12 grid gap-4 sm:grid-cols-3">
          {TRUST.map((t) => (
            <li key={t.title} className="rounded-2xl border border-border bg-panel p-6">
              <t.icon className="h-5 w-5 text-accent-2" aria-hidden />
              <h3 className="mt-4 font-medium text-fg">{t.title}</h3>
              <p className="mt-1.5 text-[15px] leading-relaxed text-muted">{t.text}</p>
            </li>
          ))}
        </ul>
      </section>

      {/* Pricing */}
      <section aria-labelledby="pricing-title" className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
        <SectionHeading
          id="pricing-title"
          eyebrow="Pricing"
          title="Start free. Upgrade when you need more"
          intro={`Every account starts on Free. Pro ($${PRICING.pro.price}/month) and Max ($${PRICING.max.price}/month) add usage and larger models. No plan is unlimited, and nothing is charged without you choosing a plan.`}
        />
        <div className="mt-12 grid gap-5 md:grid-cols-3">
          {(["free", "pro", "max"] as const).map((id) => {
            const p = PRICING[id];
            return (
              <div key={id} className={id === "pro" ? "rounded-[22px] border-2 border-accent bg-panel p-7" : "lux-card rounded-[22px] p-7"}>
                <h3 className="text-xl font-medium text-fg">{p.name}</h3>
                <p className="mt-3 font-serif text-[44px] leading-none text-fg">
                  ${p.price}
                  <span className="font-sans text-base text-muted">{p.price > 0 ? " / month" : " forever"}</span>
                </p>
                <ul className="mt-6 space-y-2.5 text-[15px] text-muted">
                  {[`${p.window} usage units per 5-hour window`, `${p.weekly.toLocaleString("en-US")} units per week`, p.models, p.code].map((x) => (
                    <li key={x} className="flex gap-2.5">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
                      {x}
                    </li>
                  ))}
                </ul>
                {id === "free" ? (
                  <PrimaryCta className="mt-8 w-full justify-center" />
                ) : (
                  <Link href={`/pricing?plan=${id}`} className="mt-8 inline-flex items-center gap-1.5 text-sm text-fg underline-offset-4 hover:underline">
                    Compare {p.name} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                  </Link>
                )}
              </div>
            );
          })}
        </div>
        <p className="mt-6 text-center text-sm text-muted">
          <Link href="/pricing" className="text-fg underline underline-offset-4 hover:text-accent-2">
            See full pricing, a plan comparison and how usage is counted
          </Link>
        </p>
      </section>

      {/* FAQ */}
      <section aria-labelledby="faq-title" className="mx-auto max-w-3xl px-5 py-20 sm:px-8">
        <SectionHeading id="faq-title" eyebrow="FAQ" title="Questions people ask" center />
        <div className="mt-10 divide-y divide-border rounded-2xl border border-border bg-panel">
          {FAQ.map((f) => (
            <details key={f.q} className="group px-6 py-5 [&_summary::-webkit-details-marker]:hidden">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded text-[16px] font-medium text-fg">
                {f.q}
                <span className="text-xl leading-none text-faint transition group-open:rotate-45" aria-hidden>
                  +
                </span>
              </summary>
              <p className="mt-3 text-[15px] leading-relaxed text-muted">{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      <CtaBand title="Get your first result in a minute" text="Create a free account, ask a question or open Code, and see what Orbis does. No credit card needed." />
    </>
  );
}
