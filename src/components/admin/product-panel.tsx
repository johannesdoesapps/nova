"use client";
import { useCallback, useEffect, useState } from "react";
import { CircleAlert, RefreshCw } from "lucide-react";
import { jsonFetch } from "@/hooks/use-ndjson";
import { METRICS } from "@/lib/analytics/events";
import type { MetricRow, RawMetrics } from "@/lib/analytics/metrics";
import { findTemplate } from "@/lib/templates/registry";
import { cn } from "@/lib/utils";

/**
 * Admin product metrics: the measurement plan with real figures from the
 * database, each with what it's based on. Figures that can't be worked out
 * yet show why instead of a number. Admins and test accounts are excluded.
 */
export function ProductPanel() {
  const [data, setData] = useState<{ raw: RawMetrics; rows: MetricRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(
    (d: number) =>
      jsonFetch<{ raw: RawMetrics; rows: MetricRow[] }>(`/api/admin/product?days=${d}`)
        .then(
          (r) => {
            setData(r);
            setError(null);
          },
          (e: Error) => setError(e.message),
        )
        .finally(() => setLoading(false)),
    [],
  );
  const load = (d: number) => {
    setLoading(true);
    setDays(d);
    void fetchData(d);
  };
  useEffect(() => {
    void fetchData(30);
  }, [fetchData]);

  const rows = new Map(data?.rows.map((r) => [r.id, r]));
  return (
    <section aria-labelledby="product-h" className="glass rounded-[22px] p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="product-h" className="text-[15px] font-semibold">
            Product
          </h2>
          <p className="mt-1 max-w-2xl text-[13px] text-s-ink-3">
            Whether people get value from Orbis and where they get stuck, from usage records, feedback and a few product events (never message text). Your own and test accounts are left out.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select value={days} onChange={(e) => load(Number(e.target.value))} aria-label="Period" className="h-9 rounded-xl border border-s-line-strong bg-s-bg px-2 text-[13px] text-s-ink">
            {[7, 30, 90, 365].map((d) => (
              <option key={d} value={d}>
                Last {d} days
              </option>
            ))}
          </select>
          <button type="button" onClick={() => load(days)} aria-label="Refresh" className="grid h-9 w-9 place-items-center rounded-xl border border-s-line-strong text-s-ink-2 hover:bg-s-hover">
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-4 flex items-center gap-2 text-[13px] text-s-danger">
          <CircleAlert className="h-4 w-4" /> {error}
        </p>
      )}
      {!data && !error && <div className="s-skeleton mt-4 h-40 rounded-2xl" />}

      {data && (
        <>
          <p className="mt-4 text-[12.5px] text-s-ink-3">
            {data.raw.people} people in total · {data.raw.signups} signed up in the period · {data.raw.active_users} used AI in the period · {data.raw.projects_created} projects created
          </p>
          <dl className="mt-3 divide-y divide-s-line rounded-2xl border border-s-line">
            {METRICS.map((m) => {
              const r = rows.get(m.id);
              return (
                <div key={m.id} className="grid gap-1 px-4 py-3 sm:grid-cols-[minmax(0,220px)_minmax(0,1fr)] sm:gap-4">
                  <dt>
                    <div className="text-[13.5px] font-medium">{m.name}</div>
                    <div className="mt-0.5 text-[12px] leading-snug text-s-ink-3">{m.definition}</div>
                  </dt>
                  <dd className="min-w-0">
                    <div className={cn("text-[18px] font-semibold", !r?.value && "text-[14px] font-normal text-s-ink-3")}>{r?.value ?? "Not measurable yet"}</div>
                    {r && <div className="mt-0.5 text-[12.5px] text-s-ink-2">{r.detail}</div>}
                    {r?.note && <div className="mt-0.5 text-[12px] text-s-ink-3">{r.note}</div>}
                    <div className="mt-0.5 text-[11.5px] text-s-ink-3">Source: {m.source}</div>
                  </dd>
                </div>
              );
            })}
          </dl>

          {data.raw.workflows.length > 0 && (
            <div className="mt-5">
              <h3 className="text-[13px] font-medium">Templates</h3>
              <table className="mt-2 w-full text-left text-[12.5px]">
                <thead className="text-s-ink-3">
                  <tr>
                    <th className="py-1 font-medium">Template</th>
                    <th className="py-1 text-right font-medium">Started</th>
                    <th className="py-1 text-right font-medium">Finished</th>
                    <th className="py-1 text-right font-medium">Failed</th>
                  </tr>
                </thead>
                <tbody>
                  {data.raw.workflows.map((w) => (
                    <tr key={w.template ?? "?"} className="border-t border-s-line">
                      <td className="py-1.5">{(w.template && findTemplate(w.template)?.name) ?? w.template ?? "Unknown"}</td>
                      <td className="py-1.5 text-right">{w.started}</td>
                      <td className="py-1.5 text-right">{w.completed}</td>
                      <td className="py-1.5 text-right">{w.failed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {data.raw.feedback_by_feature.length > 0 && (
            <div className="mt-5">
              <h3 className="text-[13px] font-medium">Ratings by feature</h3>
              <ul className="mt-2 space-y-1 text-[12.5px] text-s-ink-2">
                {data.raw.feedback_by_feature.map((f) => (
                  <li key={f.feature}>
                    {f.feature}: {f.helpful} helpful of {f.total}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-[12px] text-s-ink-3">Notes people wrote with their ratings are in the response_feedback table in Supabase; read them before deciding what to fix first.</p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
