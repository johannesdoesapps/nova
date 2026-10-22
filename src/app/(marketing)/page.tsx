import Image, { getImageProps } from "next/image";
import Link from "next/link";
import { ArrowRight, Check, CircleCheck, Terminal, FilePen, Search, ListChecks, ClipboardCheck } from "lucide-react";
import { CtaBand, PrimaryCta, SecondaryCta, SectionHeading } from "@/components/marketing/parts";
import { RoutingDemo } from "@/components/marketing/routing-demo";
import { DEMOS, HERO_SHOT } from "@/content/demos";
import { OUTCOMES, PLAN_LIMITS, TRUST_POINTS, UNIT_EXAMPLES } from "@/content/landing";
import { FAQ } from "@/content/site";
import { billingConfigured } from "@/lib/billing/stripe";
import { jsonLd, pageMetadata, siteUrl } from "@/lib/seo";

// Regenerated hourly, so the pricing note follows whether payments are switched on.
export const revalidate = 3600;

export const metadata = pageMetadata({
  title: "Orbis — the right AI for each task, with work you can check",
  description:
    "Orbis picks the right Claude or GPT model for each request, lets you compare answers when it matters, and runs agents that build, test and plan — showing which model answered and every change. Free to start.",
  path: "/",
  absoluteTitle: true,
});

const PROOF = ["No credit card to start", "Every reply names its model", "Every agent change reviewable and undoable"];

const STEPS = [
  { icon: FilePen, title: "Enter a task", text: "Ask a question, paste a document or code, or pick a ready-made template." },
  { icon: Search, title: "Orbis picks a model or workflow", text: "Auto sends everyday requests to a fast, low-cost model and harder ones to a stronger model, within your plan. The reply says which and why." },
  { icon: ListChecks, title: "Compare or review when it matters", text: "Ask several models in Council or Arena, or check an answer's claims against sources in Verify." },
  { icon: ClipboardCheck, title: "Get a result you can use", text: "Copy it, save it to a project, turn it into a task, or download it. The coding agent finishes with a report of what it built and what it checked." },
];

const STEP_ICON = { inspect: Search, plan: ListChecks, approval: CircleCheck, command: Terminal, edit: FilePen, summary: ClipboardCheck } as const;

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

  const onSale = billingConfigured();
  const codeSteps = DEMOS.find((d) => d.id === "code")?.steps ?? [];

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(structured) }} />

      {/* Hero */}
      <section aria-labelledby="hero-title" className="mx-auto max-w-6xl px-5 pt-12 pb-12 sm:px-8 sm:pt-20">
        <div className="mx-auto max-w-3xl text-center">
          <p className="mk-rise inline-flex items-center gap-2 rounded-full border border-border bg-panel-2 px-3 py-1 text-xs text-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />
            AI workspace with Claude and GPT · Free to start
          </p>
          <h1 id="hero-title" className="text-balance mk-rise mt-6 font-serif text-[40px] leading-[1.04] tracking-[-0.015em] text-fg sm:text-[64px]">
            The right AI for each task, with work you can check.
          </h1>
          <p className="mk-rise mx-auto mt-6 max-w-2xl text-[17px] leading-relaxed text-muted sm:text-[19px]">
            Orbis picks a suitable model for every request, lets you compare answers when it matters, and runs agents that build, test and plan — telling you which model answered, what changed
            and what it couldn&apos;t verify.
          </p>
          <div className="mk-rise mt-9 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
            <PrimaryCta where="hero" className="justify-center" />
            <SecondaryCta href="#how-it-works" className="justify-center">
              See how it works
            </SecondaryCta>
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

      {/* How it works: the steps, and the routing step working for real */}
      <section id="how-it-works" aria-labelledby="how-title" className="mx-auto max-w-6xl scroll-mt-20 px-5 py-20 sm:px-8">
        <SectionHeading id="how-title" eyebrow="How it works" title="From a task to a result you can rely on" intro="Four steps, whatever the job. Try the second one below: it's Orbis's actual model routing, running in your browser." />
        <div className="mt-12 grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-12">
          <ol className="space-y-6">
            {STEPS.map((st, i) => (
              <li key={st.title} className="flex gap-4">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-border-strong bg-panel-2 text-[15px] font-medium text-fg" aria-hidden>
                  {i + 1}
                </span>
                <div>
                  <h3 className="flex items-center gap-2 text-[17px] font-medium text-fg">
                    <st.icon className="h-4 w-4 text-accent-2" aria-hidden />
                    <span>
                      <span className="sr-only">Step {i + 1}: </span>
                      {st.title}
                    </span>
                  </h3>
                  <p className="mt-1 text-[15px] leading-relaxed text-muted">{st.text}</p>
                </div>
              </li>
            ))}
          </ol>
          <RoutingDemo />
        </div>
      </section>

      {/* What you can do, by outcome */}
      <section id="features" aria-labelledby="features-title" className="mx-auto max-w-6xl scroll-mt-20 px-5 py-20 sm:px-8">
        <SectionHeading
          id="features-title"
          eyebrow="What you can do"
          title="Built around getting things done"
          intro={
            <>
              Screens below are captures of real runs on tryorbis.app.{" "}
              <Link href="/features" className="text-fg underline underline-offset-4 hover:text-accent-2">
                See every feature and its status
              </Link>
              .
            </>
          }
        />
        <div className="mt-14 space-y-20">
          {OUTCOMES.map((o, i) => (
            <article key={o.id} aria-labelledby={`outcome-${o.id}`} className="grid grid-cols-1 items-center gap-8 lg:grid-cols-2 lg:gap-12">
              <div className={i % 2 ? "lg:order-2" : undefined}>
                <p className="text-xs font-medium tracking-[0.18em] text-accent-2 uppercase">{o.eyebrow}</p>
                <h3 id={`outcome-${o.id}`} className="text-balance mt-3 font-serif text-[30px] leading-[1.1] text-fg sm:text-[34px]">
                  {o.title}
                </h3>
                <p className="mt-4 text-[16px] leading-relaxed text-muted">{o.text}</p>
                <ul className="mt-5 space-y-2 text-[15px] text-muted">
                  {o.points.map((pt) => (
                    <li key={pt} className="flex gap-2.5">
                      <Check className="mt-1 h-4 w-4 shrink-0 text-success" aria-hidden />
                      {pt}
                    </li>
                  ))}
                </ul>
                {o.id === "agents" && codeSteps.length > 0 && (
                  <div className="mt-6 rounded-2xl border border-border bg-panel p-4">
                    <p className="text-[12.5px] font-medium text-muted">From the activity log of the run pictured:</p>
                    <ol className="mt-2 space-y-1.5 text-[14px] text-fg">
                      {codeSteps.map((st) => {
                        const Icon = STEP_ICON[st.kind];
                        return (
                          <li key={st.text} className="flex gap-2">
                            <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
                            <span>
                              {st.text}
                              {st.result === "pass" && <span className="ml-1.5 text-[12px] text-success">· passed</span>}
                            </span>
                          </li>
                        );
                      })}
                    </ol>
                  </div>
                )}
                <p className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-sm">
                  {o.links.map((l) => (
                    <Link key={l.href} href={l.href} className="inline-flex items-center gap-1.5 text-fg underline-offset-4 hover:underline">
                      {l.label} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                    </Link>
                  ))}
                </p>
              </div>
              {o.image && (
                <figure className={i % 2 ? "lg:order-1" : undefined}>
                  <div className="lux-card overflow-hidden rounded-[20px] p-1.5">
                    <Image src={o.image.src} alt={o.image.alt} width={o.image.width} height={o.image.height} sizes="(min-width: 1024px) 560px, 100vw" className="h-auto w-full rounded-[14px]" />
                  </div>
                  {o.caption && <figcaption className="mt-2.5 text-xs text-muted">{o.caption}</figcaption>}
                </figure>
              )}
            </article>
          ))}

          {/* Usage, in real figures */}
          <article aria-labelledby="outcome-usage" className="grid grid-cols-1 gap-8 lg:grid-cols-2 lg:gap-12">
            <div>
              <p className="text-xs font-medium tracking-[0.18em] text-accent-2 uppercase">Usage and privacy</p>
              <h3 id="outcome-usage" className="text-balance mt-3 font-serif text-[30px] leading-[1.1] text-fg sm:text-[34px]">
                Know what you&apos;re using and where your data goes
              </h3>
              <p className="mt-4 text-[16px] leading-relaxed text-muted">
                Usage is counted in units: the model you use decides how many a message takes, and Orbis shows an estimate before anything bigger runs. The Usage page lists what&apos;s left,
                when it resets and every request. Before you send, the message box shows which provider will receive your message.
              </p>
              <p className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-sm">
                <Link href="/pricing" className="inline-flex items-center gap-1.5 text-fg underline-offset-4 hover:underline">
                  How usage is counted <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </Link>
                <Link href="/security" className="inline-flex items-center gap-1.5 text-fg underline-offset-4 hover:underline">
                  Security &amp; data <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </Link>
              </p>
            </div>
            <div className="overflow-hidden rounded-2xl border border-border">
              <table className="w-full text-left text-[14.5px]">
                <caption className="border-b border-border bg-panel-2 px-4 py-2.5 text-left text-[13px] text-muted">What tasks use (from Orbis&apos;s current settings)</caption>
                <thead className="sr-only">
                  <tr>
                    <th scope="col">Task</th>
                    <th scope="col">Usage units</th>
                  </tr>
                </thead>
                <tbody>
                  {UNIT_EXAMPLES.map((u) => (
                    <tr key={u.task} className="border-b border-border last:border-0">
                      <td className="px-4 py-3 text-fg">{u.task}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-right font-medium text-fg">{u.units}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>
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
              What Orbis stores, where your messages go and what agents may do, in plain language on{" "}
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
        <ul className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {TRUST_POINTS.map((t) => (
            <li key={t.title} className="rounded-2xl border border-border bg-panel p-6">
              <h3 className="flex items-center gap-2 font-medium text-fg">
                <CircleCheck className="h-4 w-4 shrink-0 text-accent-2" aria-hidden />
                {t.title}
              </h3>
              <p className="mt-2 text-[15px] leading-relaxed text-muted">{t.text}</p>
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
          intro="Every account starts on Free, with no credit card. Paid plans add usage and larger models, billed monthly or yearly. No plan is unlimited."
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
          <li>Limits reset on their own: every 5 hours and over a rolling week. When you reach one, Orbis tells you which and when it resets.</li>
          <li>Nothing is charged automatically and your plan never changes without you.</li>
        </ul>
        <p className="mt-6 text-center text-sm text-muted">
          <Link href="/pricing" className="text-fg underline underline-offset-4 hover:text-accent-2">
            Full pricing, a plan comparison and how usage is counted
          </Link>
        </p>
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

      <CtaBand where="footer" title="Get your first result in a minute" text="Create a free account, ask a question or pick a template, and see what Orbis does. No credit card needed." />
    </>
  );
}
