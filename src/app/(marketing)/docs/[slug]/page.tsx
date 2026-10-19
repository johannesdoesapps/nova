import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Breadcrumbs, CtaBand, StatusBadge } from "@/components/marketing/parts";
import { GUIDES, featureBySlug, guideBySlug } from "@/content/site";
import { absoluteUrl, jsonLd, pageMetadata } from "@/lib/seo";

export const dynamicParams = false;

export function generateStaticParams() {
  return GUIDES.map((g) => ({ slug: g.slug }));
}

export async function generateMetadata({ params }: PageProps<"/docs/[slug]">) {
  const g = guideBySlug((await params).slug);
  if (!g) return {};
  return pageMetadata({ title: g.title, description: g.description, path: `/docs/${g.slug}` });
}

export default async function GuidePage({ params }: PageProps<"/docs/[slug]">) {
  const g = guideBySlug((await params).slug);
  if (!g) notFound();
  const feature = g.feature ? featureBySlug(g.feature) : undefined;
  const i = GUIDES.findIndex((x) => x.slug === g.slug);
  const prev = GUIDES[i - 1];
  const next = GUIDES[i + 1];
  const structured = [
    { "@context": "https://schema.org", "@type": "TechArticle", headline: g.title, description: g.description, url: absoluteUrl(`/docs/${g.slug}`), about: feature?.name },
    { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "Docs", item: absoluteUrl("/docs") },
      { "@type": "ListItem", position: 2, name: g.title, item: absoluteUrl(`/docs/${g.slug}`) },
    ] },
  ];

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(structured) }} />
      <article className="mx-auto max-w-3xl px-5 pt-14 pb-6 sm:px-8 sm:pt-20">
        <Breadcrumbs items={[{ href: "/docs", label: "Docs" }, { label: g.title }]} />
        <h1 className="text-balance mt-6 font-serif text-[38px] leading-[1.08] tracking-[-0.01em] text-fg sm:text-[50px]">{g.title}</h1>
        <p className="mt-4 text-[17px] leading-relaxed text-muted">{g.description}</p>
        {feature && (
          <p className="mt-5 flex flex-wrap items-center gap-2 text-sm text-muted">
            Feature: <Link href={`/features/${feature.slug}`} className="text-fg underline underline-offset-4">{feature.name}</Link>
            <StatusBadge status={feature.status} />
          </p>
        )}
        {g.sections.map((s) => (
          <section key={s.heading} className="mt-10">
            <h2 className="text-2xl font-medium text-fg">{s.heading}</h2>
            {s.body.map((p) => (
              <p key={p} className="mt-3 text-[16px] leading-[1.75] text-muted">{p}</p>
            ))}
          </section>
        ))}
        <nav aria-label="More guides" className="mt-14 grid gap-3 border-t border-border pt-8 sm:grid-cols-2">
          {prev ? (
            <Link href={`/docs/${prev.slug}`} className="group rounded-2xl border border-border p-4 hover:bg-panel-2">
              <span className="flex items-center gap-1.5 text-xs text-muted"><ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Previous</span>
              <span className="mt-1 block text-sm text-fg">{prev.title}</span>
            </Link>
          ) : <span />}
          {next && (
            <Link href={`/docs/${next.slug}`} className="group rounded-2xl border border-border p-4 text-right hover:bg-panel-2">
              <span className="flex items-center justify-end gap-1.5 text-xs text-muted">Next <ArrowRight className="h-3.5 w-3.5" aria-hidden /></span>
              <span className="mt-1 block text-sm text-fg">{next.title}</span>
            </Link>
          )}
        </nav>
      </article>
      <CtaBand />
    </>
  );
}
