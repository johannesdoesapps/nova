import type { Metadata } from "next";
import Link from "next/link";
import { Instrument_Serif } from "next/font/google";
import { redirect } from "next/navigation";
import { Logo } from "@/components/layout/logo";
import { Notice } from "@/components/ui/primitives";
import { getAuth } from "@/lib/auth";
import { cliLoginPath, cliPort, cliState } from "@/lib/cli-login";
import { publicEnv } from "@/lib/env";
import { CliApproval } from "./cli-approval";

export const metadata: Metadata = {
  title: "Sign in the Orbis terminal app",
  robots: { index: false, follow: false },
};

const serif = Instrument_Serif({ subsets: ["latin"], weight: "400", variable: "--font-instrument-serif", display: "swap" });

/**
 * Opened by `orbis login`: the signed-in user allows the terminal app on this computer to use their account, and
 * the browser hands a session to the app listening on 127.0.0.1 (see src/lib/cli-login.ts).
 */
export default async function CliLoginPage({ searchParams }: PageProps<"/cli/login">) {
  const sp = await searchParams;
  const port = cliPort(sp.port);
  const state = cliState(sp.state);
  const configured = Boolean(publicEnv.supabaseUrl && publicEnv.supabaseKey);
  if (configured && port && state) {
    const auth = await getAuth();
    if (auth.mode !== "authenticated") redirect(`/login?next=${encodeURIComponent(cliLoginPath(port, state))}`);
  }

  return (
    <div className={`orbis-glow grid min-h-dvh grid-cols-[minmax(0,1fr)] place-items-center px-4 py-10 ${serif.variable}`}>
      <main className="w-full max-w-md">
        <Link href="/" className="mb-8 flex justify-center">
          <Logo />
        </Link>
        <div className="lux-card rounded-[26px] p-7">
          <h1 className="font-serif text-[34px] leading-[1.05] tracking-[-0.01em]">Orbis in your terminal</h1>
          {!configured ? (
            <Notice tone="warning" title="Accounts aren't set up" className="mt-4">
              This site has no sign-in configured, so the terminal app can&apos;t connect to it.
            </Notice>
          ) : !port || !state ? (
            <Notice tone="danger" title="This sign-in link isn't valid" className="mt-4">
              Run <code>orbis login</code> again in your terminal and use the link it opens.
            </Notice>
          ) : (
            <CliApproval port={port} state={state} url={publicEnv.supabaseUrl!} supabaseKey={publicEnv.supabaseKey!} />
          )}
        </div>
      </main>
    </div>
  );
}
