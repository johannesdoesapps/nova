import { Instrument_Serif } from "next/font/google";
import { SiteFooter } from "@/components/marketing/parts";
import { SiteHeader } from "@/components/marketing/site-header";

const serif = Instrument_Serif({ subsets: ["latin"], weight: "400", variable: "--font-instrument-serif", display: "swap" });

/** Public pages: home, features, pricing, docs and security. Static, crawlable and indexable. */
export default function MarketingLayout({ children }: LayoutProps<"/">) {
  return (
    <div id="marketing-root" className={`relative isolate flex min-h-dvh flex-col ${serif.variable}`}>
      {/* The glow stays the size of the screen instead of stretching down long pages. */}
      <div aria-hidden className="orbis-glow pointer-events-none fixed inset-0 -z-10" />
      <a href="#main" className="sr-only z-50 rounded-lg bg-accent px-4 py-2 text-sm text-accent-fg focus:not-sr-only focus:fixed focus:top-3 focus:left-3">
        Skip to content
      </a>
      <SiteHeader />
      <main id="main" className="flex-1">
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
