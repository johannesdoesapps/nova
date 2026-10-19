"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { cn } from "@/lib/utils";

type Action = "upgrade" | "change" | "manage";

/**
 * Subscribe (Stripe Checkout), change an existing subscription's plan or
 * billing interval, or open Stripe's billing portal. Checkout and the portal
 * are Stripe's hosted pages; card details never touch NOVA.
 */
export function BillingButton({
  action,
  plan = "pro",
  interval = "month",
  confirm,
  className,
  children,
}: {
  action: Action;
  /** Asked before a change that cancels or charges right away. */
  confirm?: string;
  plan?: "free" | "pro" | "max";
  interval?: "month" | "year";
  className?: string;
  children?: React.ReactNode;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const go = async () => {
    if (confirm && !window.confirm(confirm)) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const url = action === "upgrade" ? "/api/billing/checkout" : action === "change" ? "/api/billing/change" : "/api/billing/portal";
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: action === "manage" ? undefined : JSON.stringify({ plan, interval }),
      });
      if (res.status === 401) {
        router.push(`/login?mode=signup&next=${encodeURIComponent(`/pricing?plan=${plan}`)}`);
        return;
      }
      const j = (await res.json().catch(() => null)) as { url?: string; message?: string; error?: { message?: string } } | null;
      if (!res.ok) throw new Error(j?.error?.message ?? "Something went wrong. Please try again.");
      if (j?.url) {
        window.location.assign(j.url);
        return;
      }
      setDone(j?.message ?? "Done.");
      setBusy(false);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  const label = action === "manage" ? "Manage subscription" : action === "change" ? "Change plan" : "Upgrade";
  return (
    <div>
      <button type="button" onClick={() => void go()} disabled={busy} aria-busy={busy} className={cn("disabled:opacity-60", className)}>
        {busy ? (action === "change" ? "Updating your plan…" : "Opening secure checkout…") : (children ?? label)}
      </button>
      {error && (
        <p role="alert" className="mt-2 text-[13px] text-red-500">
          {error}
        </p>
      )}
      {done && (
        <p role="status" className="mt-2 text-[13px] text-success">
          {done}
        </p>
      )}
    </div>
  );
}
