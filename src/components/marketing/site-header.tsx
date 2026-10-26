"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/layout/logo";
import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { StaggeredMenu } from "@/components/ui/staggered-menu";
import { cn } from "@/lib/utils";
import { BUILD_HREF, NAV, SIGN_IN_HREF } from "./links";
import { TrackedLink } from "./tracked-link";

/** The phone and tablet menu's sliding layers: the Orbis loop's violet and magenta. */
const MENU_LAYERS = ["#7c3aed", "#d946ef"];

export function SiteHeader() {
  const pathname = usePathname();
  const active = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <header className="sticky top-0 z-40 border-b border-border pt-[env(safe-area-inset-top)] bg-bg/80 backdrop-blur-xl supports-[backdrop-filter]:bg-bg/65">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-5 sm:px-8">
        <Link href="/" aria-label="Orbis home" className="rounded-lg py-1">
          <Logo />
        </Link>
        <nav aria-label="Main" className="hidden lg:block">
          <ul className="flex items-center gap-1">
            {NAV.map((n) => (
              <li key={n.href}>
                <Link
                  href={n.href}
                  aria-current={active(n.href) ? "page" : undefined}
                  className={cn(
                    "rounded-lg px-3 py-2 text-sm transition-colors hover:text-fg",
                    active(n.href) ? "text-fg" : "text-muted",
                  )}
                >
                  {n.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="ml-auto flex items-center gap-1 lg:gap-2">
          <AnimatedThemeToggler />
          <div className="hidden items-center gap-2 lg:flex">
            <Link href={SIGN_IN_HREF} className="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:text-fg">
              Sign in
            </Link>
            <TrackedLink href={BUILD_HREF} event="landing_cta" where="header" className="inline-flex h-9 items-center rounded-full bg-accent px-4 text-sm font-medium text-accent-fg transition hover:brightness-110">
              Start building free
            </TrackedLink>
          </div>
          <div className="lg:hidden">
            <StaggeredMenu
              className="lg:hidden"
              portalContainer="#marketing-root"
              position="right"
              colors={MENU_LAYERS}
              accentColor="var(--accent-2)"
              items={NAV.map((n) => ({ label: n.label, link: n.href }))}
              activeHref={NAV.find((n) => active(n.href))?.href}
              displaySocials={false}
              footer={
                <div className="grid gap-2">
                  <TrackedLink href={BUILD_HREF} event="landing_cta" where="header-menu" className="inline-flex h-11 items-center justify-center rounded-full bg-accent text-sm font-medium text-accent-fg">
                    Start building free
                  </TrackedLink>
                  <Link href={SIGN_IN_HREF} className="inline-flex h-11 items-center justify-center rounded-full border border-border-strong text-sm text-fg">
                    Sign in
                  </Link>
                </div>
              }
              toggleClassName="text-fg hover:bg-panel-2"
            />
          </div>
        </div>
      </div>
    </header>
  );
}
