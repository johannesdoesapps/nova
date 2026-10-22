"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Menu, X } from "lucide-react";
import { Logo } from "@/components/layout/logo";
import { cn } from "@/lib/utils";
import { NAV, SIGN_IN_HREF, SIGN_UP_HREF } from "./links";

export function SiteHeader() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [openedAt, setOpenedAt] = useState(pathname);
  const button = useRef<HTMLButtonElement>(null);
  // Close the mobile menu after navigating.
  if (open && openedAt !== pathname) {
    setOpen(false);
    setOpenedAt(pathname);
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const active = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-bg/80 backdrop-blur-xl supports-[backdrop-filter]:bg-bg/65">
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
        <div className="ml-auto hidden items-center gap-2 lg:flex">
          <Link href={SIGN_IN_HREF} className="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:text-fg">
            Sign in
          </Link>
          <Link href={SIGN_UP_HREF} className="inline-flex h-9 items-center rounded-full bg-accent px-4 text-sm font-medium text-accent-fg transition hover:brightness-110">
            Get started free
          </Link>
        </div>
        <button
          ref={button}
          type="button"
          className="ml-auto inline-grid h-10 w-10 place-items-center rounded-lg text-fg hover:bg-panel-2 lg:hidden"
          aria-expanded={open}
          aria-controls="mobile-nav"
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => {
            setOpen(!open);
            setOpenedAt(pathname);
          }}
        >
          {open ? <X className="h-5 w-5" aria-hidden /> : <Menu className="h-5 w-5" aria-hidden />}
        </button>
      </div>
      <nav id="mobile-nav" aria-label="Main" hidden={!open} className="border-t border-border px-5 pb-5 lg:hidden">
        <ul className="py-2">
          {NAV.map((n) => (
            <li key={n.href}>
              <Link href={n.href} aria-current={active(n.href) ? "page" : undefined} className="block rounded-lg px-2 py-3 text-base text-fg hover:bg-panel-2">
                {n.label}
              </Link>
            </li>
          ))}
        </ul>
        <div className="grid gap-2">
          <Link href={SIGN_UP_HREF} className="inline-flex h-11 items-center justify-center rounded-full bg-accent text-sm font-medium text-accent-fg">
            Get started free
          </Link>
          <Link href={SIGN_IN_HREF} className="inline-flex h-11 items-center justify-center rounded-full border border-border-strong text-sm text-fg">
            Sign in
          </Link>
        </div>
      </nav>
    </header>
  );
}
