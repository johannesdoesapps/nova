import type { Metadata } from "next";
import Link from "next/link";
import { Instrument_Serif } from "next/font/google";
import { redirect } from "next/navigation";
import { ConsentForm } from "@/components/common/consent-form";
import { Logo } from "@/components/layout/logo";
import { LEGAL } from "@/content/legal-meta";
import { getAuth } from "@/lib/auth";
import { afterSignIn } from "@/lib/auth-flow";

export const metadata: Metadata = {
  title: "Before you continue",
  robots: { index: false, follow: false },
};

const serif = Instrument_Serif({ subsets: ["latin"], weight: "400", variable: "--font-instrument-serif", display: "swap" });

/** Shown to signed-in users who haven't accepted the current Terms of Service and Privacy Policy. */
export default async function ConsentPage({ searchParams }: PageProps<"/consent">) {
  const sp = await searchParams;
  const next = afterSignIn(typeof sp.next === "string" ? sp.next : undefined);
  const auth = await getAuth();
  if (auth.mode !== "authenticated") redirect(`/login?next=${encodeURIComponent(next)}`);
  const { count } = await auth.supabase.from("legal_acceptances").select("id", { count: "exact", head: true });
  const updated = (count ?? 0) > 0;

  return (
    <div className={`orbis-glow grid min-h-dvh place-items-center px-4 py-10 ${serif.variable}`}>
      <main className="w-full max-w-md">
        <Link href="/" className="mb-8 flex justify-center">
          <Logo />
        </Link>
        <div className="lux-card rounded-[26px] p-7">
          <h1 className="font-serif text-[34px] leading-[1.05] tracking-[-0.01em]">{updated ? "We've updated our terms" : "Before you continue"}</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            {updated
              ? `Our Terms of Service and Privacy Policy changed on ${LEGAL.updated}. Please read and accept them to keep using Orbis.`
              : "To use Orbis, please read and accept our Terms of Service and Privacy Policy."}
          </p>
          <ConsentForm next={next} version={LEGAL.version} />
          <form action="/auth/signout" method="post" className="mt-4 text-center">
            <button type="submit" className="min-h-6 px-1 text-xs text-muted underline-offset-2 hover:text-fg hover:underline">
              Don&apos;t accept — sign out
            </button>
          </form>
        </div>
      </main>
    </div>
  );
}
