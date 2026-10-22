"use client";
import Link from "next/link";
import { useState } from "react";
import { Button, Notice } from "@/components/ui/primitives";

/** Both boxes ticked, then the acceptance is recorded and the user continues where they were going. */
export function ConsentForm({ next, version }: { next: string; version: string }) {
  const [terms, setTerms] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = async () => {
    if (!terms || !privacy) {
      setError("Tick both boxes to continue.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/legal/accept", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version, terms, privacy }) });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(j?.error?.message ?? "Your acceptance couldn't be saved. Please try again.");
      }
      window.location.assign(new URL(next, window.location.origin).toString());
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <form
      className="mt-5 space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void accept();
      }}
    >
      <fieldset className="space-y-2.5 rounded-xl border border-border bg-panel-2 p-3.5 text-[13.5px] leading-snug">
        <legend className="sr-only">Agreements</legend>
        <label className="flex items-start gap-2.5">
          <input type="checkbox" required checked={terms} onChange={(e) => setTerms(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]" />
          <span>
            I agree to the{" "}
            <Link href="/terms" target="_blank" className="text-fg underline underline-offset-2 hover:text-accent">
              Terms of Service
            </Link>
            .
          </span>
        </label>
        <label className="flex items-start gap-2.5">
          <input type="checkbox" required checked={privacy} onChange={(e) => setPrivacy(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]" />
          <span>
            I have read the{" "}
            <Link href="/privacy" target="_blank" className="text-fg underline underline-offset-2 hover:text-accent">
              Privacy Policy
            </Link>{" "}
            and{" "}
            <Link href="/cookies" target="_blank" className="text-fg underline underline-offset-2 hover:text-accent">
              Cookie Policy
            </Link>
            , which explain how Orbis uses my data.
          </span>
        </label>
        <p className="text-xs text-muted">You must be 13 or older. If you&apos;re under 18, you need a parent&apos;s or guardian&apos;s permission.</p>
      </fieldset>
      {error && <Notice tone="danger">{error}</Notice>}
      <Button type="submit" className="w-full" loading={busy}>
        Accept and continue
      </Button>
    </form>
  );
}
