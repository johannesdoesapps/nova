import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, Check, Info } from "lucide-react";
import { Breadcrumbs, CtaBand, PrimaryCta, SecondaryCta, StatusBadge } from "@/components/marketing/parts";
import { FEATURES, featureBySlug, guideBySlug } from "@/content/site";
import { absoluteUrl, jsonLd, pageMetadata } from "@/lib/seo";

export const dynamicParams = false;

export function generateStaticParams() {
  return FEATURES.map((f) => ({ slug: f.slug }));
}

export async function generateMetadata({ params }: PageProps<"/features/[slug]">) {
  const f = featureBySlug((await params).slug);
  if (!f) return {};
  return pageMetadata({ title: f.title, description: f.description, path: `/features/${f.slug}` });
}

export default async function FeaturePage({ params }: PageProps<"/features/[slug]">) {
  const f = featureBySlug((await params).slug);
  if (!f) notFound();
  const guide = f.guide ? guideBySlug(f.guide) : undefined;
  const others = FEATURES.filter((x) => x.slug !== f.slug).slice(0, 3);
  const preview = f.status === "preview";
  const crumbs = { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: "Features", item: absoluteUrl("/features") },
    { "@type": "ListItem", position: 2, name: f.name, item: absoluteUrl(`/features/${f.slug}`) },
  ] };

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(crumbs) }} />
      <article>
        <header className="mx-auto max-w-4xl px-5 pt-14 pb-10 sm:px-8 sm:pt-20">
          <Breadcrumbs items={[{ href: "/features", label: "Features" }, { label: f.name }]} />
          <div className="mt-6 flex items-center gap-3">
            <StatusBadge status={f.status} />
          </div>
          <h1 className="text-balance mt-4 font-serif text-[40px] leading-[1.05] tracking-[-0.01em] text-fg sm:text-[56px]">{f.name}</h1>
          <p className="mt-5 text-[19px] leading-relaxed text-muted">{f.tagline}</p>
          <p className="mt-4 text-[15px] leading-relaxed text-muted">
            <span className="text-fg">Who it&rsquo;s for:</span> {f.audience}
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            {preview ? <SecondaryCta href={guide ? `/docs/${guide.slug}` : "/docs"}>Read how it works</SecondaryCta> : <PrimaryCta>Get started free</PrimaryCta>}
            {!preview && guide && <SecondaryCta href={`/docs/${guide.slug}`}>Read the guide</SecondaryCta>}
          </div>
        </header>

        <section aria-labelledby="what" className="mx-auto max-w-4xl px-5 py-10 sm:px-8">
          <h2 id="what" className="text-2xl font-medium text-fg">What it does</h2>
          <ul className="mt-6 grid gap-4 sm:grid-cols-2">
            {f.highlights.map((h) => (
              <li key={h.title} className="rounded-2xl border border-border bg-panel p-6">
                <h3 className="font-medium text-fg">{h.title}</h3>
                <p className="mt-2 text-[15px] leading-relaxed text-muted">{h.text}</p>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="how" className="mx-auto max-w-4xl px-5 py-10 sm:px-8">
          <h2 id="how" className="text-2xl font-medium text-fg">How to use it</h2>
          <ol className="mt-6 space-y-3">
            {f.steps.map((s, i) => (
              <li key={s} className="flex gap-4 text-[15px] leading-relaxed text-muted">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-border-strong text-xs text-fg" aria-hidden>{i + 1}</span>
                <span className="pt-0.5">{s}</span>
              </li>
            ))}
          </ol>
          {!preview && (
            <p className="mt-6 text-sm text-muted">
              Already have an account?{" "}
              <Link href={f.appPath} className="text-fg underline underline-offset-4">{f.appLabel}</Link>
            </p>
          )}
        </section>

        <section aria-labelledby="limits" className="mx-auto max-w-4xl px-5 py-10 sm:px-8">
          <h2 id="limits" className="text-2xl font-medium text-fg">Good to know</h2>
          <ul className="mt-6 space-y-3 rounded-2xl border border-border bg-panel p-6">
            {f.limits.map((l) => (
              <li key={l} className="flex gap-3 text-[15px] leading-relaxed text-muted">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-faint" aria-hidden />
                {l}
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="more" className="mx-auto max-w-4xl px-5 py-10 sm:px-8">
          <h2 id="more" className="text-2xl font-medium text-fg">More from NOVA</h2>
          <ul className="mt-6 grid gap-4 sm:grid-cols-3">
            {others.map((o) => (
              <li key={o.slug}>
                <Link href={`/features/${o.slug}`} className="group flex h-full flex-col rounded-2xl border border-border bg-panel p-5 transition hover:bg-panel-2">
                  <span className="flex items-center gap-2 font-medium text-fg">
                    <Check className="h-4 w-4 text-faint" aria-hidden />
                    {o.name}
                  </span>
                  <span className="mt-2 flex-1 text-sm leading-relaxed text-muted">{o.tagline}</span>
                  <ArrowRight className="mt-3 h-3.5 w-3.5 text-faint transition group-hover:translate-x-0.5" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </article>
      <CtaBand />
    </>
  );
}
