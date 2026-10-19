import type { Metadata } from "next";
import Link from "next/link";
import { Instrument_Serif } from "next/font/google";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/common/login-form";
import { Logo } from "@/components/layout/logo";
import { Notice } from "@/components/ui/primitives";
import { getAuth } from "@/lib/auth";
import { loginMessage, safeNext } from "@/lib/auth-flow";
import { authProviders } from "@/lib/auth-providers";
import { publicEnv } from "@/lib/env";

export const metadata: Metadata = { title: "Sign in" };

const serif = Instrument_Serif({ subsets: ["latin"], weight: "400", variable: "--font-instrument-serif", display: "swap" });

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const sp = await searchParams;
  const next = safeNext(sp.next);
  const configured = Boolean(publicEnv.supabaseUrl && publicEnv.supabaseKey);
  if (configured) {
    const auth = await getAuth();
    if (auth.mode === "authenticated") redirect(next);
  }
  // Only known message codes are shown, never free text from the URL.
  const message = loginMessage(sp.msg);
  const initialMode = sp.mode === "signup" ? "signup" : "signin";
  const providers = configured ? await authProviders() : { google: false };

  return (
    <div className={`nova-glow grid min-h-dvh place-items-center px-4 py-10 ${serif.variable}`}>
      <div className="w-full max-w-sm">
        <Link href="/" className="mb-8 flex justify-center"><Logo /></Link>
        <div className="lux-card rounded-[26px] p-7">
          {message && <Notice tone={message.tone} className="mb-4">{message.text}</Notice>}
          {configured ? (
            <LoginForm url={publicEnv.supabaseUrl!} supabaseKey={publicEnv.supabaseKey!} next={next} siteUrl={publicEnv.siteUrl} initialMode={initialMode} google={providers.google} />
          ) : (
            <Notice tone="warning" title="Authentication is not configured">
              Set <code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code>, apply the migrations, and restart.{" "}
              <Link href="/" className="text-accent hover:underline">Continue in demo mode</Link>
            </Notice>
          )}
        </div>
      </div>
    </div>
  );
}
