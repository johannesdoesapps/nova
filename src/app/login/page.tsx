import type { Metadata } from "next";
import Link from "next/link";
import { Instrument_Serif } from "next/font/google";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/common/login-form";
import { Logo } from "@/components/layout/logo";
import { Notice } from "@/components/ui/primitives";
import { getAuth } from "@/lib/auth";
import { publicEnv } from "@/lib/env";

export const metadata: Metadata = { title: "Sign in" };

const serif = Instrument_Serif({ subsets: ["latin"], weight: "400", variable: "--font-instrument-serif", display: "swap" });

function safeNext(n: string | string[] | undefined): string {
  const v = Array.isArray(n) ? n[0] : n;
  // Only allow same-site relative paths to prevent open redirects.
  return v && v.startsWith("/") && !v.startsWith("//") && !v.startsWith("/\\") ? v : "/";
}

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const sp = await searchParams;
  const next = safeNext(sp.next);
  const configured = Boolean(publicEnv.supabaseUrl && publicEnv.supabaseKey);
  if (configured) {
    const auth = await getAuth();
    if (auth.mode === "authenticated") redirect(next);
  }
  const error = typeof sp.error === "string" ? sp.error : null;
  const notice = typeof sp.notice === "string" ? sp.notice : null;

  return (
    <div className={`nova-glow grid min-h-dvh place-items-center px-4 py-10 ${serif.variable}`}>
      <div className="w-full max-w-sm">
        <Link href="/" className="mb-8 flex justify-center"><Logo /></Link>
        <div className="lux-card rounded-[26px] p-7">
          <h1 className="font-serif text-[34px] leading-[1.05] tracking-[-0.01em]">Welcome to NOVA</h1>
          <p className="mt-1 text-sm text-muted">Sign in to save conversations, searches and projects.</p>
          {error && <Notice tone="danger" className="mt-4">{error}</Notice>}
          {notice && <Notice tone="success" className="mt-4">{notice}</Notice>}
          {configured ? (
            <LoginForm url={publicEnv.supabaseUrl!} supabaseKey={publicEnv.supabaseKey!} next={next} siteUrl={publicEnv.siteUrl} />
          ) : (
            <Notice tone="warning" className="mt-4" title="Authentication is not configured">
              Set <code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code>, apply the migrations, and restart.{" "}
              <Link href="/" className="text-accent hover:underline">Continue in demo mode</Link>
            </Notice>
          )}
        </div>
      </div>
    </div>
  );
}
