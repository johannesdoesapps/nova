import Image, { getImageProps } from "next/image";
import Link from "next/link";
import { ArrowRight, Check, CircleCheck, CircleMinus, Minus } from "lucide-react";
import { CtaBand, PrimaryCta, SecondaryCta, SectionHeading } from "@/components/marketing/parts";
import { buildHref } from "@/components/marketing/links";
import { TrackedLink } from "@/components/marketing/tracked-link";
import { DEMOS, HERO_SHOT } from "@/content/demos";
import { BROWSER_CHECKS, DIFFERENTIATORS, PLAN_LIMITS, PROOF_SHOTS, RUN_CHECKED, RUN_NOT_CHECKED, RUN_STAGES, TRUST_POINTS, USE_CASES } from "@/content/landing";
import { FAQ } from "@/content/site";
import { billingConfigured } from "@/lib/billing/stripe";
import { jsonLd, pageMetadata, siteUrl } from "@/lib/seo";

// Regenerated hourly, so the pricing note follows whether payments are switched on.
export const revalidate = 3600;

export const metadata = pageMetadata({
  title: "Orbis — AI that builds, tests and shows its work",
  description:
    "An AI coding agent that writes code, runs it on its own computer, checks websites in a real browser and reports what it verified. Claude and GPT. Free to start.",
  path: "/",
  absoluteTitle: true,
});

/** Each one is something the product enforces, not a promise of quality. */
const PROOF = ["Runs your site and checks it in a real browser", "Asks before unfamiliar commands, never deploys", "Every change listed and undoable"];

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
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Web",
      description: "AI coding agent that builds websites and applications in an isolated workspace, checks them in a real browser and reports what it verified. Also chat with Claude and GPT models and compare their answers.",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: "Free plan" },
    },
  ];

  const onSale = billingConfigured();
  const run = DEMOS.find((d) => d.id === "code")!;

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(structured) }} />

      {/* Hero */}
      <section aria-labelledby="hero-title" className="mx-auto max-w-6xl px-5 pt-12 pb-12 sm:px-8 sm:pt-20">
        <div className="mx-auto max-w-3xl text-center">
          <p className="mk-rise inline-flex items-center gap-2 rounded-full border border-border bg-panel-2 px-3 py-1 text-xs text-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />
            Coding agent · Claude and GPT models · Free to start
          </p>
          <h1 id="hero-title" className="text-balance mk-rise mt-6 font-serif text-[40px] leading-[1.04] tracking-[-0.015em] text-fg sm:text-[64px]">
            AI that builds, tests, and shows its work.
          </h1>
          <p className="mk-rise mx-auto mt-6 max-w-2xl text-[17px] leading-relaxed text-muted sm:text-[19px]">
            Build websites and applications with an AI coding agent that can execute tasks, inspect its results in a real browser, and show you what changed. Review the work, understand
            what was verified, and stay in control.
          </p>
          <div className="mk-rise mt-9 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
            <PrimaryCta where="hero" className="justify-center" />
            <SecondaryCta href="#demo" className="justify-center">
              See a real run
            </SecondaryCta>
          </div>
          <p className="mk-rise mt-4 text-[13.5px] text-muted">Start for free. No credit card required.</p>
          <ul className="mk-rise mt-6 flex flex-wrap justify-center gap-x-6 gap-y-2 text-[13.5px] text-muted" aria-label="At a glance">
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

      {/* A real run, stage by stage */}
      <section id="demo" aria-labelledby="demo-title" className="mx-auto max-w-6xl scroll-mt-20 px-5 py-20 sm:px-8">
        <SectionHeading
          id="demo-title"
          eyebrow="A real run"
          title="From one prompt to a checked page"
          intro="The run pictured above, on tryorbis.app, stage by stage. The lines in each box are copied from its activity log. Nothing in this section is simulated."
        />
        <div className="mt-12 grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-14">
          <ol className="relative space-y-7 border-l border-border pl-6">
            {RUN_STAGES.map((st, i) => (
              <li key={st.id} className="relative">
                <span className="absolute top-0.5 -left-[37px] grid h-6 w-6 place-items-center rounded-full border border-border-strong bg-bg text-[12px] font-medium text-fg" aria-hidden>
                  {i + 1}
                </span>
                <h3 className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-[17px] font-medium text-fg">
                  <span>
                    <span className="sr-only">Stage {i + 1}: </span>
                    {st.label}
                  </span>
                  <span className="rounded-full border border-border px-2 py-0.5 text-[11.5px] font-normal text-muted">{st.kind}</span>
                </h3>
                <p className="mt-1.5 text-[15px] leading-relaxed text-muted">{st.text}</p>
                {st.steps.length > 0 && (
                  <ul className="mt-2.5 space-y-1.5 rounded-xl border border-border bg-panel px-3.5 py-2.5 text-[13.5px] text-fg" aria-label={`${st.label}: from the activity log`}>
                    {st.steps.map((s) => (
                      <li key={s} className="flex gap-2">
                        <Minus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
                        {s}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>

          <div className="space-y-6 lg:sticky lg:top-24 lg:self-start">
            <figure>
              <div className="lux-card overflow-hidden rounded-[20px] p-1.5">
                <Image src={run.image.src} alt={run.image.alt} width={run.image.width} height={run.image.height} sizes="(min-width: 1024px) 540px, 100vw" className="h-auto w-full rounded-[14px]" />
              </div>
              <figcaption className="mt-2.5 text-xs text-muted">{run.caption}</figcaption>
            </figure>
            <div className="grid gap-4 rounded-2xl border border-border bg-panel p-5 sm:grid-cols-2">
              <div>
                <h3 className="text-[14px] font-medium text-fg">Checked in this run</h3>
                <ul className="mt-2.5 space-y-2 text-[14px] text-muted">
                  {RUN_CHECKED.map((x) => (
                    <li key={x} className="flex gap-2">
                      <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
                      {x}
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="text-[14px] font-medium text-fg">Not checked</h3>
                <ul className="mt-2.5 space-y-2 text-[14px] text-muted">
                  {RUN_NOT_CHECKED.map((x) => (
                    <li key={x} className="flex gap-2">
                      <CircleMinus className="mt-0.5 h-4 w-4 shrink-0 text-faint" aria-hidden />
                      {x}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-12 rounded-2xl border border-border bg-panel-2 p-5 sm:p-6">
          <h3 className="font-medium text-fg">What the browser check looks at</h3>
          <ul className="mt-3 grid gap-x-8 gap-y-2 text-[14.5px] text-muted sm:grid-cols-2">
            {BROWSER_CHECKS.map((x) => (
              <li key={x} className="flex gap-2">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-accent-2" aria-hidden />
                {x}
              </li>
            ))}
          </ul>
          <p className="mt-4 text-[14px] leading-relaxed text-muted">
            A browser check is an inspection, not a test suite. When a project has automated tests, the agent runs them as a separate step and shows each result, and it says so when a
            check couldn&apos;t run.
          </p>
        </div>
      </section>

      {/* Why Orbis */}
      <section aria-labelledby="why-title" className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
        <SectionHeading id="why-title" eyebrow="Why Orbis" title="An agent you can actually check" />
        <ul className="mt-12 grid gap-x-12 gap-y-10 md:grid-cols-2">
          {DIFFERENTIATORS.map((d, i) => (
            <li key={d.id} className="border-t border-border pt-6">
              <p className="font-serif text-[22px] leading-none text-muted" aria-hidden>
                0{i + 1}
              </p>
              <h3 className="mt-3 text-[19px] font-medium text-fg">{d.title}</h3>
              <p className="mt-2 text-[15.5px] leading-relaxed text-muted">{d.text}</p>
            </li>
          ))}
        </ul>
      </section>

      {/* Use cases */}
      <section aria-labelledby="uses-title" className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
        <SectionHeading id="uses-title" eyebrow="Use cases" title="What people build with it" intro="Start from an example request (you can edit it before sending) or bring your own project." />
        <ul className="mt-12 grid gap-4 sm:grid-cols-2">
          {USE_CASES.map((u) => (
            <li key={u.id} className="flex flex-col rounded-2xl border border-border bg-panel p-6">
              <h3 className="font-medium text-fg">{u.title}</h3>
              <p className="mt-2 flex-1 text-[15px] leading-relaxed text-muted">{u.text}</p>
              {u.idea ? (
                <TrackedLink href={buildHref(u.idea)} event="landing_cta" where={`usecase:${u.id}`} className="mt-5 inline-flex items-center gap-1.5 self-start text-sm text-fg underline-offset-4 hover:underline">
                  {u.cta} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </TrackedLink>
              ) : (
                <Link href={u.href!} className="mt-5 inline-flex items-center gap-1.5 self-start text-sm text-fg underline-offset-4 hover:underline">
                  {u.cta} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </Link>
              )}
            </li>
          ))}
        </ul>
      </section>

      {/* Proof: more real captures */}
      <section aria-labelledby="proof-title" className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
        <SectionHeading
          id="proof-title"
          eyebrow="Beyond code"
          title="The rest of the workspace, from real sessions"
          intro={
            <>
              Each screen is a capture of a real session on tryorbis.app; the caption says when.{" "}
              <Link href="/features" className="text-fg underline underline-offset-4 hover:text-accent-2">
                See every feature and its status
              </Link>
              .
            </>
          }
        />
        <ul className="mt-12 grid gap-6 md:grid-cols-3">
          {PROOF_SHOTS.map((p) => (
            <li key={p.id}>
              <figure>
                <div className="lux-card overflow-hidden rounded-[18px] p-1">
                  <Image src={p.image.src} alt={p.image.alt} width={p.image.width} height={p.image.height} sizes="(min-width: 768px) 360px, 100vw" className="h-auto w-full rounded-[14px]" />
                </div>
                <figcaption className="mt-3">
                  <Link href={p.href} className="font-medium text-fg underline-offset-4 hover:underline">
                    {p.title}
                  </Link>
                  <span className="mt-1 block text-xs text-muted">{p.caption}</span>
                </figcaption>
              </figure>
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
          intro="Every account starts on Free, with no credit card. Free includes the coding agent, though a full website can take more than one 5-hour allowance. Paid plans add usage, larger models and more computer time. No plan is unlimited."
        />
        {!onSale && (
          <p className="mt-6 rounded-2xl border border-border bg-panel-2 px-4 py-3 text-[14.5px] text-fg" role="note">
            Paid plans aren&apos;t on sale yet while payments are being set up. Everything on Free works today.
          </p>
        )}
        <div className="mt-8 grid gap-5 md:grid-cols-3">
          {PLAN_LIMITS.map((p) => (
            <div key={p.id} className={p.id === "pro" ? "rounded-[22px] border-2 border-accent bg-panel p-6 sm:p-7" : "lux-card rounded-[22px] p-6 sm:p-7"}>
              <h3 className="text-xl font-medium text-fg">{p.name}</h3>
              <p className="mt-3 font-serif text-[44px] leading-none text-fg">
                ${p.price}
                <span className="font-sans text-base text-muted">{p.price > 0 ? " / month" : " forever"}</span>
              </p>
              <p className="mt-2 min-h-[20px] text-[13.5px] text-muted">{p.price > 0 ? `or $${p.yearly.toLocaleString("en-US")} a year (save ${p.discount}%)` : "No credit card needed"}</p>
              <ul className="mt-5 space-y-2.5 text-[15px] text-muted">
                {p.lines.map((x) => (
                  <li key={x} className="flex gap-2.5">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
                    {x}
                  </li>
                ))}
              </ul>
              {p.id === "free" ? (
                <PrimaryCta where="pricing" className="mt-8 w-full justify-center" />
              ) : (
                <Link href={`/pricing?plan=${p.id}`} className="mt-8 inline-flex items-center gap-1.5 text-sm text-fg underline-offset-4 hover:underline">
                  Compare {p.name} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </Link>
              )}
            </div>
          ))}
        </div>
        <ul className="mx-auto mt-8 max-w-3xl space-y-1.5 text-[14px] text-muted">
          <li>Prices are in US dollars, plus tax where it applies. Yearly plans are paid up front.</li>
          <li>Limits reset on their own: five hours after your first message, and once a week. When you reach one, Orbis tells you which and when it resets.</li>
          <li>
            Paid plans renew until you cancel. Nothing else is charged unless you buy extra usage, or turn on automatic top-ups with a monthly limit you set. Your plan never changes
            without you.
          </li>
          <li>Teams: Pro or Max for two or more people, billed together, with each person&apos;s own allowance.</li>
        </ul>
        <p className="mt-6 text-center text-sm text-muted">
          <Link href="/pricing" className="text-fg underline underline-offset-4 hover:text-accent-2">
            Full pricing, a plan comparison and how usage is counted
          </Link>
        </p>
      </section>

      {/* Trust */}
      <section aria-labelledby="trust-title" className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
        <SectionHeading
          id="trust-title"
          eyebrow="Security and control"
          title="What the agent can and can't do"
          intro={
            <>
              The details, in plain language, are on{" "}
              <Link href="/security" className="text-fg underline underline-offset-4 hover:text-accent-2">
                Security &amp; data
              </Link>{" "}
              and in the{" "}
              <Link href="/privacy" className="text-fg underline underline-offset-4 hover:text-accent-2">
                Privacy Policy
              </Link>
              .
            </>
          }
        />
        <ul className="mt-10 grid gap-x-12 md:grid-cols-2">
          {TRUST_POINTS.map((t) => (
            <li key={t.title} className="border-t border-border py-5">
              <h3 className="flex items-center gap-2 font-medium text-fg">
                <CircleCheck className="h-4 w-4 shrink-0 text-accent-2" aria-hidden />
                {t.title}
              </h3>
              <p className="mt-1.5 text-[15px] leading-relaxed text-muted">{t.text}</p>
            </li>
          ))}
        </ul>
      </section>

      {/* FAQ */}
      <section aria-labelledby="faq-title" className="mx-auto max-w-3xl px-5 py-20 sm:px-8">
        <SectionHeading id="faq-title" eyebrow="FAQ" title="Questions people ask" center />
        <div className="mt-10 divide-y divide-border rounded-2xl border border-border bg-panel">
          {FAQ.map((f) => (
            <details key={f.q} className="group px-5 py-5 sm:px-6 [&_summary::-webkit-details-marker]:hidden">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded text-[16px] font-medium text-fg">
                {f.q}
                <span className="text-xl leading-none text-faint transition group-open:rotate-45 motion-reduce:transition-none" aria-hidden>
                  +
                </span>
              </summary>
              <p className="mt-3 text-[15px] leading-relaxed text-muted">{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      <CtaBand
        where="footer"
        title="Describe it. Watch it get built and checked."
        text="Create a free account, describe a website or a change, and read the agent's report of what it built and what it checked. No credit card required."
      />
    </>
  );
}
