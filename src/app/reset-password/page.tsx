import type { Metadata } from "next";
import Link from "next/link";
import { Instrument_Serif } from "next/font/google";
import { ResetPasswordForm } from "@/components/common/reset-password-form";
import { Logo } from "@/components/layout/logo";
import { Notice } from "@/components/ui/primitives";
import { getAuth } from "@/lib/auth";
import { publicEnv } from "@/lib/env";

export const metadata: Metadata = {
  title: "Choose a new password",
  robots: { index: false, follow: false },
};

const serif = Instrument_Serif({ subsets: ["latin"], weight: "400", variable: "--font-instrument-serif", display: "swap" });

/**
 * Where a password reset email lands: /auth/callback has already exchanged the
 * link's code for a recovery session, so the user is signed in here.
 */
export default async function ResetPasswordPage() {
  const configured = Boolean(publicEnv.supabaseUrl && publicEnv.supabaseKey);
  const auth = configured ? await getAuth() : null;

  return (
    <div className={`orbis-glow grid min-h-dvh place-items-center px-4 py-10 ${serif.variable}`}>
      <div className="w-full max-w-sm">
        <Link href="/" className="mb-8 flex justify-center"><Logo /></Link>
        <div className="lux-card rounded-[26px] p-7">
          {auth?.mode === "authenticated" ? (
            <ResetPasswordForm url={publicEnv.supabaseUrl!} supabaseKey={publicEnv.supabaseKey!} email={auth.user.email} />
          ) : (
            <>
              <h1 className="font-serif text-[34px] leading-[1.05] tracking-[-0.01em]">Reset link expired</h1>
              <Notice tone="warning" className="mt-4">
                This password reset link has expired, was already used, or was opened in another browser.{" "}
                <Link href="/login" className="text-accent hover:underline">Go to sign in</Link> and choose “Forgot password?” to get a new one.
              </Notice>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
