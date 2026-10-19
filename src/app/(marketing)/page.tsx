import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Bot, Check, Eye, Layers, Lock, MessagesSquare, ServerCog, ShieldCheck } from "lucide-react";
import { CtaBand, PrimaryCta, SecondaryCta, SectionHeading, StatusBadge } from "@/components/marketing/parts";
import { FAQ, FEATURES, PRICING } from "@/content/site";
import { jsonLd, pageMetadata, siteUrl } from "@/lib/seo";
import chatShot from "../../../public/product/chat.webp";

export const metadata = pageMetadata({
  title: "NOVA — AI assistant, custom agents and multi-model workspace",
  description:
    "Chat with Claude and GPT models, use specialised or custom AI agents, compare models side by side, plan projects and check your own site and code — free to start.",
  path: "/",
  absoluteTitle: true,
});

const BENEFITS = [
  {
    icon: Layers,
    title: "Several leading models, one workspace",
    text: "Claude and GPT models side by side. Leave it on Auto and NOVA picks a model for each message — and tells you why.",
  },
  {
    icon: Bot,
    title: "Agents for the job",
    text: "Research, Coding, Writing, Data and more — or build your own agent with your instructions, default model and starter prompts.",
  },
  {
    icon: Eye,
    title: "Built to be checked",
    text: "See which model answered, compare models before you rely on one, and get security findings with evidence. AI never marks your work done for you.",
  },
];

const STEPS = [
  { title: "Create a free account", text: "Sign up with your email address. You start on the Free plan — no credit card." },
  { title: "Ask, or pick an agent", text: "Type a question and let the Smart Router choose a model, or open an agent that's set up for the task." },
  { title: "Check, compare and keep", text: "Cross-check answers with Council or Arena, turn goals into plans in Mission Control, and keep everything in your history." },
];

const TRUST = [
  { icon: Lock, title: "Private to your account", text: "Conversations, agents and missions are stored per account with database row-level security; other users can't read them." },
  { icon: MessagesSquare, title: "Clear about where data goes", text: "Your messages are sent to the provider of the model that answers — such as Anthropic or OpenAI — and each reply names that model." },
  { icon: ShieldCheck, title: "Agents don't act on their own", text: "Assistants and agents write, explain, plan and review. They don't send emails, buy things or change your systems." },
  { icon: ServerCog, title: "Isolated code execution", text: "The Autonomous Developer (private preview) runs code in a sandbox that loses network access after setup and never pushes changes for you." },
];

export default function HomePage() {
  const url = siteUrl();
  const structured = [
    { "@context": "https://schema.org", "@type": "WebSite", name: "NOVA", url },
    {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "NOVA",
      url,
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web",
      description: "AI workspace with Claude and GPT models, specialised and custom agents, model comparison, project planning and security agents.",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: "Free plan" },
    },
  ];

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(structured) }} />

      {/* Hero */}
      <section aria-labelledby="hero-title" className="mx-auto max-w-6xl px-5 pt-16 pb-10 sm:px-8 sm:pt-24">
        <div className="mx-auto max-w-3xl text-center">
          <p className="inline-flex items-center gap-2 rounded-full border border-border bg-panel-2 px-3 py-1 text-xs text-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />
            Free to start · Claude and GPT models
          </p>
          <h1 id="hero-title" className="text-balance mk-rise mt-6 font-serif text-[44px] leading-[1.02] tracking-[-0.015em] text-fg sm:text-[68px]">
            <span className="block">One AI workspace.</span>
            <span className="block">Agents that help you get work done.</span>
          </h1>
          <p className="mk-rise mx-auto mt-6 max-w-2xl text-[17px] leading-relaxed text-muted sm:text-[19px]">
            NOVA brings leading AI models, specialised agents and planning tools together — for research, writing, coding and security checks — and shows you which model answered and why.
          </p>
          <div className="mk-rise mt-9 flex flex-wrap items-center justify-center gap-3">
            <PrimaryCta />
            <SecondaryCta href="#how-it-works">See how it works</SecondaryCta>
          </div>
        </div>

        <figure className="mx-auto mt-16 max-w-5xl">
          <div className="lux-card overflow-hidden rounded-[22px] p-1.5 sm:p-2">
            <Image
              src={chatShot}
              alt="NOVA's chat studio: a question about multi-tenant database security answered by Claude Sonnet 5.5, with the reply's model name shown above it and saved conversations listed in the sidebar."
              priority
              sizes="(min-width: 1100px) 1024px, 100vw"
              className="h-auto w-full rounded-[16px]"
            />
          </div>
          <figcaption className="mt-3 text-center text-xs text-muted">NOVA&rsquo;s chat studio with an example conversation.</figcaption>
        </figure>
      </section>

      {/* Benefits */}
      <section aria-labelledby="why-title" className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
        <SectionHeading id="why-title" eyebrow="Why NOVA" title="Use the right model for each task — and see its work" />
        <ul className="mt-12 grid gap-5 md:grid-cols-3">
          {BENEFITS.map((b) => (
            <li key={b.title} className="rounded-2xl border border-border bg-panel p-6">
              <b.icon className="h-5 w-5 text-accent-2" aria-hidden />
              <h3 className="mt-4 text-lg font-medium text-fg">{b.title}</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-muted">{b.text}</p>
            </li>
          ))}
        </ul>
      </section>

      {/* Features */}
      <section id="features" aria-labelledby="features-title" className="mx-auto max-w-6xl scroll-mt-20 px-5 py-20 sm:px-8">
        <SectionHeading
          id="features-title"
          eyebrow="Features"
          title="What you can do with NOVA today"
          intro="Each feature is marked with its status. Anything not generally available says so."
        />
        <ul className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <li key={f.slug}>
              <Link href={`/features/${f.slug}`} className="group flex h-full flex-col rounded-2xl border border-border bg-panel p-6 transition hover:border-border-strong hover:bg-panel-2">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-lg font-medium text-fg">{f.name}</h3>
                  <StatusBadge status={f.status} />
                </div>
                <p className="mt-2 flex-1 text-[15px] leading-relaxed text-muted">{f.tagline}</p>
                <span className="mt-5 inline-flex items-center gap-1.5 text-sm text-fg">
                  Learn about {f.name}
                  <ArrowRight className="h-3.5 w-3.5 transition group-hover:translate-x-0.5" aria-hidden />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {/* How it works */}
      <section id="how-it-works" aria-labelledby="how-title" className="mx-auto max-w-6xl scroll-mt-20 px-5 py-20 sm:px-8">
        <SectionHeading id="how-title" eyebrow="How it works" title="From sign-up to a useful answer in a minute" />
        <ol className="mt-12 grid gap-5 md:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s.title} className="rounded-2xl border border-border bg-panel p-6">
              <span className="grid h-8 w-8 place-items-center rounded-full border border-border-strong text-sm text-fg" aria-hidden>
                {i + 1}
              </span>
              <h3 className="mt-4 text-lg font-medium text-fg">{s.title}</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-muted">{s.text}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* Trust */}
      <section aria-labelledby="trust-title" className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
        <SectionHeading
          id="trust-title"
          eyebrow="Security & data"
          title="Straight answers about your data"
          intro={
            <>
              What NOVA stores, where your messages go and what agents are allowed to do.{" "}
              <Link href="/security" className="text-fg underline underline-offset-4 hover:text-accent-2">
                Read Security &amp; data
              </Link>
              .
            </>
          }
        />
        <ul className="mt-12 grid gap-5 sm:grid-cols-2">
          {TRUST.map((t) => (
            <li key={t.title} className="flex gap-4 rounded-2xl border border-border bg-panel p-6">
              <t.icon className="mt-0.5 h-5 w-5 shrink-0 text-accent-2" aria-hidden />
              <div>
                <h3 className="font-medium text-fg">{t.title}</h3>
                <p className="mt-1.5 text-[15px] leading-relaxed text-muted">{t.text}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* Pricing */}
      <section aria-labelledby="pricing-title" className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
        <SectionHeading id="pricing-title" eyebrow="Pricing" title="Free to start. Pro and Max when you need more" intro={`Everyone starts on Free. Pro is $${PRICING.pro.price} and Max $${PRICING.max.price} a month (USD), with more usage and larger models.`} />
        <div className="mt-12 grid gap-5 md:grid-cols-3">
          {(["free", "pro", "max"] as const).map((id) => {
            const p = PRICING[id];
            return (
              <div key={id} className={id === "pro" ? "rounded-[22px] border-2 border-accent bg-panel p-7" : "lux-card rounded-[22px] p-7"}>
                <div className="flex items-center justify-between">
                  <h3 className="text-xl font-medium text-fg">{p.name}</h3>
                  {id === "free" && <StatusBadge status="available" />}
                </div>
                <p className="mt-3 font-serif text-[44px] leading-none text-fg">
                  ${p.price}
                  {p.price > 0 && <span className="font-sans text-base text-muted"> / month</span>}
                </p>
                <ul className="mt-6 space-y-2.5 text-[15px] text-muted">
                  {[`${p.window} usage units per 5-hour window`, `${p.weekly.toLocaleString("en-US")} per week`, p.models].map((x) => (
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
                    See {p.name} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                  </Link>
                )}
              </div>
            );
          })}
        </div>
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

      <CtaBand />
    </>
  );
}
