"use client";
import { useEffect, useState } from "react";
import { jsonFetch } from "@/hooks/use-ndjson";
import { Switch } from "./ui";

type Offer = { available: boolean; paidPlan: boolean; pack: { units: number; priceUsd: number } | null };

/**
 * Extra usage on paid plans, like Claude's usage credits: units bought
 * separately that keep requests going once a 5-hour, weekly or monthly limit
 * is reached. Shows the balance, the "use automatically" switch and, when a
 * pack is on sale, a Buy button (Stripe Checkout; credits arrive by webhook).
 */
export function ExtraUsage({ credits, bought, onChanged }: { credits: { balance: number; auto: boolean }; bought: boolean; onChanged: () => void }) {
  const [offer, setOffer] = useState<Offer | null>(null);
  const [auto, setAuto] = useState(credits.auto);
  const [packs, setPacks] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    jsonFetch<Offer>("/api/usage/credits")
      .then(setOffer)
      .catch(() => setOffer({ available: false, paidPlan: true, pack: null }));
  }, []);

  const buy = async () => {
    setBusy(true);
    setError(null);
    try {
      const { url } = await jsonFetch<{ url: string }>("/api/usage/credits", { method: "POST", body: JSON.stringify({ packs }) });
      window.location.assign(url);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const units = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return (
    <section aria-labelledby="extra-usage" className="mt-5 border-t border-s-line pt-4">
      <h3 id="extra-usage" className="text-[13.5px] font-semibold">
        Extra usage
      </h3>
      <p className="mt-1 text-[12.5px] leading-relaxed text-s-ink-3">
        Units you buy separately. When your plan&rsquo;s 5-hour, weekly or monthly limit is reached, they keep your requests going instead of waiting for the reset. They don&rsquo;t count against your
        plan&rsquo;s limits.
      </p>
      {bought && (
        <p role="status" className="mt-2 text-[12.5px] text-s-ink-2">
          Payment received. Your extra usage appears here once the payment is confirmed, usually within a minute.
        </p>
      )}
      <p className="mt-3 text-[13.5px]">
        <span className="font-medium">{units(credits.balance)} units</span> <span className="text-s-ink-3">left</span>
      </p>
      <label className="mt-2 flex items-center gap-2 text-[12.5px] text-s-ink-2">
        <Switch
          checked={auto}
          label="Use extra usage automatically"
          onChange={async (v) => {
            setAuto(v);
            try {
              await jsonFetch("/api/usage/credits", { method: "PATCH", body: JSON.stringify({ auto: v }) });
              onChanged();
            } catch (e) {
              setAuto(!v);
              setError((e as Error).message);
            }
          }}
        />
        Use extra usage automatically when a limit is reached
      </label>
      {offer?.available && offer.pack ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="extra-packs">
            Number of packs
          </label>
          <select id="extra-packs" value={packs} onChange={(e) => setPacks(Number(e.target.value))} className="h-9 rounded-xl border border-s-line-strong bg-s-bg px-2 text-[13px] text-s-ink">
            {[1, 2, 3, 5, 10].map((n) => (
              <option key={n} value={n}>
                {units(offer.pack!.units * n)} units · ${(offer.pack!.priceUsd * n).toFixed(2)}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void buy()}
            disabled={busy}
            className="inline-flex h-9 items-center rounded-xl bg-s-accent px-3.5 text-[13px] font-medium text-s-accent-ink hover:brightness-110 disabled:opacity-50"
          >
            {busy ? "Opening checkout…" : "Buy extra usage"}
          </button>
          <span className="text-[12px] text-s-ink-3">One-off payment in USD, plus tax where it applies. Paid securely with Stripe.</span>
        </div>
      ) : (
        offer && <p className="mt-3 text-[12.5px] text-s-ink-3">Extra usage isn&rsquo;t on sale yet.</p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[12.5px] text-s-danger">
          {error}
        </p>
      )}
    </section>
  );
}
