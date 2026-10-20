import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { Logo } from "@/components/layout/logo";
import { FEATURES, GUIDES, STATUS_LABEL, type Status } from "@/content/site";
import { cn } from "@/lib/utils";
import { SIGN_IN_HREF, SIGN_UP_HREF } from "./links";

const STATUS_DOT: Record<Status, string> = {
  available: "bg-success",
  beta: "bg-accent-2",
  preview: "bg-warning",
  planned: "bg-muted",
};

/** Status label: coloured dot for quick scanning, normal-contrast text for reading. */
export function StatusBadge({ status, className }: { status: Status; className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border-strong bg-panel-2 px-2.5 py-0.5 text-[11.5px] font-medium text-fg", className)}>
      <span className={cn("h-1.5 w-1.5 rounded-full", STATUS_DOT[status])} aria-hidden />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function SectionHeading({ eyebrow, title, intro, id, center }: { eyebrow?: string; title: string; intro?: ReactNode; id?: string; center?: boolean }) {
  return (
    <div className={cn("max-w-2xl", center && "mx-auto text-center")}>
      {eyebrow && <p className="text-xs font-medium tracking-[0.18em] text-muted uppercase">{eyebrow}</p>}
      <h2 id={id} className="text-balance mt-3 font-serif text-[34px] leading-[1.08] tracking-[-0.01em] text-fg sm:text-[42px]">
        {title}
      </h2>
      {intro && <p className="mt-4 text-[17px] leading-relaxed text-muted">{intro}</p>}
    </div>
  );
}

export function PrimaryCta({ children = "Get started free", href = SIGN_UP_HREF, className }: { children?: ReactNode; href?: string; className?: string }) {
  return (
    <Link href={href} className={cn("inline-flex h-12 items-center gap-2 rounded-full bg-accent px-6 text-[15px] font-medium text-accent-fg shadow-[0_10px_30px_-12px_var(--accent)] transition hover:brightness-110", className)}>
      {children}
      <ArrowRight className="h-4 w-4" aria-hidden />
    </Link>
  );
}

export function SecondaryCta({ children, href, className }: { children: ReactNode; href: string; className?: string }) {
  return (
    <Link href={href} className={cn("inline-flex h-12 items-center rounded-full border border-border-strong px-6 text-[15px] text-fg transition hover:bg-panel-2", className)}>
      {children}
    </Link>
  );
}

export function CtaBand({ title = "Start with Orbis today", text = "Create a free account in under a minute. No credit card needed." }: { title?: string; text?: string }) {
  return (
    <section aria-labelledby="cta-title" className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
      <div className="lux-card rounded-[28px] px-6 py-14 text-center sm:px-12">
        <h2 id="cta-title" className="text-balance font-serif text-[34px] leading-tight sm:text-[42px]">
          {title}
        </h2>
        <p className="mx-auto mt-3 max-w-lg text-muted">{text}</p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <PrimaryCta />
          <SecondaryCta href="/docs/getting-started">Read the getting-started guide</SecondaryCta>
        </div>
      </div>
    </section>
  );
}

export function SiteFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="border-t border-border">
      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-14 sm:px-8 md:grid-cols-[1.3fr_1fr_1fr_1fr]">
        <div>
          <Link href="/" aria-label="Orbis home" className="inline-block rounded-lg">
            <Logo />
          </Link>
          <p className="mt-4 max-w-xs text-sm leading-relaxed text-muted">
            One workspace for AI chat, coding and agents — with every model named and every change reviewable.
          </p>
        </div>
        <FooterColumn title="Product" links={[{ href: "/features", label: "All features" }, ...FEATURES.map((f) => ({ href: `/features/${f.slug}`, label: f.name }))]} />
        <FooterColumn
          title="Resources"
          links={[{ href: "/docs", label: "Documentation" }, ...GUIDES.slice(0, 4).map((g) => ({ href: `/docs/${g.slug}`, label: g.short }))]}
        />
        <FooterColumn
          title="Orbis"
          links={[
            { href: "/pricing", label: "Pricing" },
            { href: "/security", label: "Security & data" },
            { href: SIGN_IN_HREF, label: "Sign in" },
            { href: SIGN_UP_HREF, label: "Create an account" },
          ]}
        />
      </div>
      <div className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-6 text-xs text-muted sm:px-8">
          <p>© {year} Orbis. AI can make mistakes — check important information.</p>
          <nav aria-label="Legal" className="flex gap-5">
            <Link href="/privacy" className="transition-colors hover:text-fg">
              Privacy Policy
            </Link>
            <Link href="/terms" className="transition-colors hover:text-fg">
              Terms of Service
            </Link>
          </nav>
        </div>
      </div>
    </footer>
  );
}

function FooterColumn({ title, links }: { title: string; links: { href: string; label: string }[] }) {
  return (
    <nav aria-label={title}>
      <h2 className="text-sm font-medium text-fg">{title}</h2>
      <ul className="mt-4 space-y-2.5">
        {links.map((l) => (
          <li key={l.href}>
            <Link href={l.href} className="text-sm text-muted transition-colors hover:text-fg">
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Breadcrumb trail for feature and guide pages (visible, with matching structured data). */
export function Breadcrumbs({ items }: { items: { href?: string; label: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="text-sm text-muted">
      <ol className="flex flex-wrap items-center gap-1.5">
        {items.map((it, i) => (
          <li key={it.label} className="flex items-center gap-1.5">
            {i > 0 && <span aria-hidden>/</span>}
            {it.href ? (
              <Link href={it.href} className="hover:text-fg">
                {it.label}
              </Link>
            ) : (
              <span aria-current="page" className="text-muted">
                {it.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
