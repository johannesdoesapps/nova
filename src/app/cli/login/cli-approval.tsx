"use client";
import { useState } from "react";
import { Button, Notice } from "@/components/ui/primitives";
import { cliCallbackUrl } from "@/lib/cli-login";
import { browserSupabase } from "@/lib/supabase/client";

type Tokens = { access_token: string; refresh_token: string; expires_at?: number | null };

/** A separate session for the terminal app; the browser's own session when the site can't open one. */
async function sessionForCli(url: string, supabaseKey: string): Promise<{ tokens: Tokens; shared: boolean }> {
  const res = await fetch("/api/cli/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  if (res.ok) return { tokens: (await res.json()) as Tokens, shared: false };
  const j = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  if (j?.error?.code !== "not_configured") throw new Error(j?.error?.message ?? "The terminal app couldn't be signed in. Please try again.");
  const { data } = await browserSupabase(url, supabaseKey).auth.getSession();
  if (!data.session) throw new Error("You're no longer signed in. Reload this page and sign in again.");
  return { tokens: { access_token: data.session.access_token, refresh_token: data.session.refresh_token, expires_at: data.session.expires_at ?? null }, shared: true };
}

/** "Allow" hands a session to the terminal app on 127.0.0.1; "Cancel" tells it nothing was shared. */
export function CliApproval({ port, state, url, supabaseKey }: { port: number; state: string; url: string; supabaseKey: string }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<"allowed" | "cancelled" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const allow = async () => {
    setBusy(true);
    setError(null);
    try {
      const { tokens } = await sessionForCli(url, supabaseKey);
      setDone("allowed");
      // Only this computer's loopback address; the tokens travel in the fragment, which never reaches a server.
      window.location.assign(cliCallbackUrl(port, tokens, state));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const cancel = () => {
    setDone("cancelled");
    window.location.assign(`http://127.0.0.1:${port}/callback#${new URLSearchParams({ error: "cancelled", state }).toString()}`);
  };

  if (done === "cancelled")
    return (
      <Notice tone="info" className="mt-4">
        Cancelled. Nothing was shared with the terminal app; you can close this tab.
      </Notice>
    );

  return (
    <div className="mt-3 space-y-4">
      <p className="text-sm leading-relaxed text-muted">Allow the Orbis terminal app on this computer to use your account?</p>
      <ul className="space-y-1.5 rounded-xl border border-border bg-panel-2 p-3.5 text-[13.5px] leading-snug text-muted">
        <li>It will run Orbis Code in a folder on this computer and use your plan&apos;s allowance.</li>
        <li>It stays signed in until you run <code className="font-mono text-fg">orbis logout</code>.</li>
        <li>Only allow this if you just ran <code className="font-mono text-fg">orbis login</code> yourself.</li>
      </ul>
      {error && <Notice tone="danger">{error}</Notice>}
      {done === "allowed" ? (
        <Notice tone="success">Signed in. Return to your terminal; you can close this tab.</Notice>
      ) : (
        <div className="flex gap-2">
          <Button onClick={() => void allow()} loading={busy} className="flex-1">
            Allow
          </Button>
          <Button variant="secondary" onClick={cancel} disabled={busy} className="flex-1">
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
