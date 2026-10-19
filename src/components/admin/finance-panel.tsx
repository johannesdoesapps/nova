"use client";
import { useCallback, useEffect, useState } from "react";
import { CircleAlert, RefreshCw } from "lucide-react";
import { jsonFetch } from "@/hooks/use-ndjson";
import type { FinanceReport } from "@/lib/billing/finance";
import { cn } from "@/lib/utils";

const usd = (x: number, d = 2) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: d, maximumFractionDigits: d }).format(x);
const dayLabel = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const day = (iso: string) => dayLabel.format(new Date(`${iso.slice(0, 10)}T00:00:00Z`));
const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);

/** Admin finance: revenue, AI costs, margins, model usage, heavy users, projections and alerts. */
export function FinancePanel() {
  const [report, setReport] = useState<FinanceReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);

  const fetchReport = useCallback(
    (d: number) =>
      jsonFetch<{ report: FinanceReport }>(`/api/admin/finance?days=${d}`)
        .then(
          (r) => {
            setReport(r.report);
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
    void fetchReport(d);
  };

  useEffect(() => {
    void fetchReport(30);
  }, [fetchReport]);

  const maxDaily = Math.max(0.0001, ...(report?.daily.map((d) => d.costUsd) ?? [0]));
  return (
    <section aria-labelledby="finance-h" className="glass rounded-[22px] p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="finance-h" className="text-[15px] font-semibold">
            Finance
          </h2>
          <p className="mt-1 text-[13px] text-s-ink-3">Estimates from recorded usage at official API prices and your fee and hosting assumptions. Stripe is the record for money received.</p>
        </div>
        <div className="flex items-center gap-2">
          <select value={days} onChange={(e) => load(Number(e.target.value))} aria-label="Period" className="h-9 rounded-xl border border-s-line-strong bg-s-bg px-2 text-[13px] text-s-ink">
            {[7, 30, 90].map((d) => (
              <option key={d} value={d}>
                Last {d} days
              </option>
            ))}
          </select>
          <button type="button" onClick={() => load(days)} aria-label="Refresh finance figures" aria-busy={loading} className="grid h-9 w-9 place-items-center rounded-xl hover:bg-s-hover">
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} aria-hidden />
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-3 text-[13px] text-s-danger">
          {error} Use refresh to try again.
        </p>
      )}
      {report && (
        <div className="mt-4 space-y-5">
          {report.alerts.length > 0 && (
            <ul className="space-y-1.5">
              {report.alerts.map((a, i) => (
                <li key={i} className={cn("flex gap-2 rounded-xl border px-3 py-2 text-[13px]", a.level === "critical" ? "border-s-danger/40 text-s-danger" : "border-s-line-strong text-s-ink-2")}>
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  {a.text}
                </li>
              ))}
            </ul>
          )}

          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ["Monthly recurring revenue", usd(report.totals.mrrUsd), `${usd(report.totals.arrUsd, 0)} a year`],
              [`AI cost, ${report.periodDays} days`, usd(report.totals.aiCostUsd), `${report.totals.subscribers} paying of ${report.totals.users} users`],
              [`Profit, ${report.periodDays} days`, usd(report.totals.profitUsd), `margin ${pct(report.totals.margin)}`],
              ["Projected month", usd(report.projection.profitUsd), `AI ${usd(report.projection.aiCostUsd)} · margin ${pct(report.projection.margin)}`],
            ].map(([k, v, sub]) => (
              <div key={k} className="rounded-xl border border-s-line px-3 py-2.5">
                <dt className="text-[12px] text-s-ink-3">{k}</dt>
                <dd className="mt-0.5 text-[18px] font-semibold tabular-nums">{v}</dd>
                <dd className="text-[11.5px] text-s-ink-3">{sub}</dd>
              </div>
            ))}
          </dl>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-[13px] tabular-nums">
              <thead className="text-[12px] text-s-ink-3">
                <tr>
                  {["Plan", "Users", "Canceling", "MRR", "Fees", "Hosting", "AI cost", "AI budget", "Profit", "Margin"].map((h) => (
                    <th key={h} className="px-2 py-1.5 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.plans.map((p) => (
                  <tr key={p.plan} className="border-t border-s-line">
                    <td className="px-2 py-1.5 font-medium">{p.label}</td>
                    <td className="px-2 py-1.5">{p.subscribers}</td>
                    <td className="px-2 py-1.5">{p.canceling}</td>
                    <td className="px-2 py-1.5">{usd(p.mrrUsd)}</td>
                    <td className="px-2 py-1.5">{usd(p.feesUsd)}</td>
                    <td className="px-2 py-1.5">{usd(p.overheadUsd)}</td>
                    <td className="px-2 py-1.5">{usd(p.aiCostUsd, 4)}</td>
                    <td className="px-2 py-1.5">{usd(p.aiBudgetUsd)}</td>
                    <td className={cn("px-2 py-1.5", p.profitUsd < 0 && "text-s-danger")}>{usd(p.profitUsd)}</td>
                    <td className="px-2 py-1.5">{pct(p.margin)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-1 text-[11.5px] text-s-ink-3">
              {report.pastDue} past due · {report.canceledRecently} canceled in this period. Projection basis: {report.projection.basis}.
            </p>
          </div>

          {report.daily.length > 0 && (
            <div>
              <h3 className="text-[13px] font-medium">Daily AI cost (30 days)</h3>
              <div
                className="mt-2 flex h-24 items-end gap-[3px]"
                role="img"
                aria-label={`Daily AI cost from ${day(report.daily[0]!.day)} to ${day(report.daily.at(-1)!.day)}, highest ${usd(maxDaily)}`}
              >
                {report.daily.map((d) => (
                  <div key={d.day} title={`${day(d.day)}: ${usd(d.costUsd, 4)}, ${d.runs} requests`} className="min-w-[4px] flex-1 rounded-t bg-s-accent/70" style={{ height: `${Math.max(2, (d.costUsd / maxDaily) * 100)}%` }} />
                ))}
              </div>
            </div>
          )}

          <div className="grid gap-5 lg:grid-cols-2">
            <div>
              <h3 className="text-[13px] font-medium">Model usage</h3>
              <table className="mt-2 w-full text-left text-[12.5px] tabular-nums">
                <tbody>
                  {report.models.slice(0, 12).map((m) => (
                    <tr key={m.model} className="border-t border-s-line">
                      <td className="max-w-[180px] truncate py-1.5 pr-2" title={m.model} translate="no">
                        {m.model}
                      </td>
                      <td className="py-1.5 pr-2 text-s-ink-3">{m.runs.toLocaleString("en-US")} req</td>
                      <td className="py-1.5 text-right">{usd(m.costUsd, 4)}</td>
                    </tr>
                  ))}
                  {!report.models.length && (
                    <tr>
                      <td className="py-2 text-s-ink-3">No requests in this period.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div>
              <h3 className="text-[13px] font-medium">Heaviest users</h3>
              <table className="mt-2 w-full text-left text-[12.5px] tabular-nums">
                <tbody>
                  {report.topUsers.slice(0, 12).map((u, i) => (
                    <tr key={i} className="border-t border-s-line">
                      <td className="max-w-[170px] truncate py-1.5 pr-2" title={u.email ?? undefined}>
                        {u.email ?? "—"}
                      </td>
                      <td className="py-1.5 pr-2 text-s-ink-3">{u.admin ? "admin" : u.plan}</td>
                      <td className="py-1.5 pr-2 text-right">{usd(u.costUsd, 4)}</td>
                      <td className={cn("py-1.5 text-right", (u.budgetShare ?? 0) >= 0.8 ? "text-s-danger" : "text-s-ink-3")}>{u.budgetShare === null ? "—" : `${Math.round(u.budgetShare * 100)}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
      {!report && !error && <div className="s-skeleton mt-4 h-32 rounded-xl" />}
    </section>
  );
}
