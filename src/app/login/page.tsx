import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/common/login-form";
import { Logo } from "@/components/layout/logo";
import { Notice } from "@/components/ui/primitives";
import { getAuth } from "@/lib/auth";
import { publicEnv } from "@/lib/env";

export const metadata: Metadata = { title: "Sign in" };

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

  return (
    <div className="nova-glow grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <Link href="/" className="mb-8 flex justify-center"><Logo /></Link>
        <div className="rounded-2xl border border-border bg-panel p-6">
          <h1 className="text-xl font-semibold">Welcome to NOVA</h1>
          <p className="mt-1 text-sm text-muted">Sign in to save conversations, searches and projects.</p>
          {error && <Notice tone="danger" className="mt-4">{error}</Notice>}
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
