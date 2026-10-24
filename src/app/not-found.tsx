import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/layout/logo";

export const metadata: Metadata = { title: "Page not found", robots: { index: false } };

export default function NotFound() {
  return (
    <div className="orbis-glow grid min-h-dvh place-items-center px-4 text-center">
      <main>
        <Logo className="justify-center" />
        <h1 className="mt-10 text-2xl font-semibold">Page not found</h1>
        <p className="mt-2 text-sm text-muted">It may have been moved, deleted, or never existed.</p>
        <Link href="/" className="mt-6 inline-flex min-h-10 items-center rounded-xl bg-accent px-4 py-2 text-sm font-medium text-accent-fg">Back home</Link>
      </main>
    </div>
  );
}
