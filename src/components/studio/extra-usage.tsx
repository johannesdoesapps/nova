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
      {offer?.available && offer.pack && <AutoTopup pack={offer.pack} />}
    </section>
  );
}

type TopupState = {
  available: boolean;
  pack: { units: number; priceUsd: number } | null;
  settings: { enabled: boolean; packs: number; belowUnits: number; monthlyCapUsd: number; cardSaved: boolean; disabledReason: string | null } | null;
  thisMonth: { spentUsd: number; count: number };
};

/**
 * Automatic top-ups (opt-in): buy extra usage when the balance falls below a chosen level, up to a monthly limit,
 * charged to a card saved for this. The exact terms are shown before agreeing, and it can be turned off any time.
 */
function AutoTopup({ pack }: { pack: { units: number; priceUsd: number } }) {
  const [state, setState] = useState<TopupState | null>(null);
  const [editing, setEditing] = useState(false);
  const [packs, setPacks] = useState(1);
  const [below, setBelow] = useState(Math.round(pack.units / 4));
  const [cap, setCap] = useState(Math.max(20, Math.ceil(pack.priceUsd * 3)));
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    jsonFetch<TopupState>("/api/usage/topup")
      .then((j) => {
        if (!alive) return;
        setState(j);
        if (j.settings) {
          setPacks(j.settings.packs);
          setBelow(j.settings.belowUnits);
          setCap(j.settings.monthlyCapUsd);
        }
      })
      .catch(() => alive && setState(null));
    return () => {
      alive = false;
    };
  }, [reload]);

  if (!state?.available) return null;
  const on = !!state.settings?.enabled;
  const price = Math.round(pack.priceUsd * packs * 100) / 100;
  const units = pack.units * packs;
  const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
  const terms = `Orbis will charge your saved card $${price.toFixed(2)} (plus any tax) for ${fmt(units)} units each time your extra usage falls below ${fmt(below)} units, up to $${cap.toFixed(2)} per calendar month. You’ll get a receipt for every charge and can turn this off at any time here.`;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const j = await jsonFetch<{ url?: string; enabled?: boolean }>("/api/usage/topup", { method: "POST", body: JSON.stringify({ packs, belowUnits: below, monthlyCapUsd: cap, consent: true }) });
      if (j.url) {
        window.location.assign(j.url);
        return;
      }
      setEditing(false);
      setAgreed(false);
      setReload((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };
  const turnOff = async () => {
    setBusy(true);
    setError(null);
    try {
      await jsonFetch("/api/usage/topup", { method: "DELETE" });
      setReload((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };

  const input = "h-9 w-28 rounded-xl border border-s-line-strong bg-transparent px-2.5 text-[13px] text-s-ink outline-none focus:border-s-accent";
  return (
    <div className="mt-4 rounded-xl border border-s-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-[13px] font-semibold">Automatic top-up</h4>
        <span className="text-[12px] text-s-ink-3">{on ? "On" : "Off"}</span>
      </div>
      {on && state.settings && !editing ? (
        <>
          <p className="mt-1 text-[12.5px] leading-relaxed text-s-ink-2">
            Buys {fmt(pack.units * state.settings.packs)} units for ${(pack.priceUsd * state.settings.packs).toFixed(2)} when your extra usage falls below {fmt(state.settings.belowUnits)} units, up to
            ${state.settings.monthlyCapUsd.toFixed(2)} a month. This month: ${state.thisMonth.spentUsd.toFixed(2)} in {state.thisMonth.count} top-up{state.thisMonth.count === 1 ? "" : "s"}.
          </p>
          <div className="mt-2 flex gap-2">
            <button type="button" className="h-8 rounded-lg border border-s-line-strong px-3 text-[12.5px] hover:bg-s-hover" onClick={() => setEditing(true)} disabled={busy}>
              Change
            </button>
            <button type="button" className="h-8 rounded-lg border border-s-line-strong px-3 text-[12.5px] hover:bg-s-hover" onClick={() => void turnOff()} disabled={busy}>
              Turn off
            </button>
          </div>
        </>
      ) : !editing ? (
        <>
          <p className="mt-1 text-[12.5px] leading-relaxed text-s-ink-3">
            Optional: keep extra usage from running out by buying it automatically when it gets low, up to a monthly limit you choose. Off unless you turn it on.
            {state.settings?.disabledReason && state.settings.disabledReason !== "Turned off by you." ? ` It was turned off: ${state.settings.disabledReason}` : ""}
          </p>
          <button type="button" className="mt-2 h-8 rounded-lg border border-s-line-strong px-3 text-[12.5px] hover:bg-s-hover" onClick={() => setEditing(true)}>
            Set up automatic top-up
          </button>
        </>
      ) : (
        <div className="mt-2 space-y-3">
          <div className="flex flex-wrap gap-3">
            <label className="text-[12.5px] text-s-ink-2">
              <span className="block">Buy each time</span>
              <select value={packs} onChange={(e) => setPacks(Number(e.target.value))} className={input}>
                {[1, 2, 3, 5, 10].map((n) => (
                  <option key={n} value={n}>
                    {fmt(pack.units * n)} units · ${(pack.priceUsd * n).toFixed(2)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[12.5px] text-s-ink-2">
              <span className="block">When below (units)</span>
              <input type="number" min={0} value={below} onChange={(e) => setBelow(Math.max(0, Math.round(Number(e.target.value) || 0)))} className={input} />
            </label>
            <label className="text-[12.5px] text-s-ink-2">
              <span className="block">Monthly limit ($)</span>
              <input type="number" min={1} value={cap} onChange={(e) => setCap(Math.max(1, Number(e.target.value) || 1))} className={input} />
            </label>
          </div>
          <label className="flex items-start gap-2 text-[12.5px] leading-relaxed text-s-ink-2">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5" />
            <span>{terms}</span>
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy || !agreed || cap < price}
              onClick={() => void save()}
              className="inline-flex h-9 items-center rounded-xl bg-s-accent px-3.5 text-[13px] font-medium text-s-accent-ink hover:brightness-110 disabled:opacity-50"
            >
              {busy ? "Saving…" : state.settings?.cardSaved ? "Agree and turn on" : "Agree and save a card"}
            </button>
            <button type="button" className="h-9 rounded-xl px-3 text-[13px] text-s-ink-2 hover:bg-s-hover" onClick={() => setEditing(false)}>
              Cancel
            </button>
            {cap < price && <span className="text-[12px] text-s-ink-3">The monthly limit must cover at least one top-up.</span>}
          </div>
          {!state.settings?.cardSaved && <p className="text-[12px] text-s-ink-3">You’ll save a card on Stripe’s page; nothing is charged until your balance falls below the level above.</p>}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[12.5px] text-s-danger">
          {error}
        </p>
      )}
    </div>
  );
}
