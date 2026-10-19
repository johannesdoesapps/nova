"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * "Upgrade to Pro" (Stripe Checkout) or "Manage subscription" (Stripe's
 * billing portal). Both open Stripe's hosted pages; card details never touch NOVA.
 */
export function BillingButton({ action, className, children }: { action: "upgrade" | "manage"; className?: string; children?: React.ReactNode }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(action === "upgrade" ? "/api/billing/checkout" : "/api/billing/portal", { method: "POST" });
      if (res.status === 401) {
        router.push("/login?mode=signup&next=%2Fpricing");
        return;
      }
      const j = (await res.json().catch(() => null)) as { url?: string; error?: { message?: string } } | null;
      if (!res.ok || !j?.url) throw new Error(j?.error?.message ?? "Something went wrong. Please try again.");
      window.location.assign(j.url);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div>
      <button type="button" onClick={() => void go()} disabled={busy} aria-busy={busy} className={cn("disabled:opacity-60", className)}>
        {busy ? "Opening secure checkout…" : (children ?? (action === "upgrade" ? "Upgrade to Pro" : "Manage subscription"))}
      </button>
      {error && (
        <p role="alert" className="mt-2 text-[13px] text-red-500">
          {error}
        </p>
      )}
    </div>
  );
}
