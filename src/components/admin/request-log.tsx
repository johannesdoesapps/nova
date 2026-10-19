"use client";
import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { jsonFetch } from "@/hooks/use-ndjson";
import { cn } from "@/lib/utils";

interface RequestRow {
  created_at: string;
  request_id: string | null;
  user_email: string | null;
  purpose: string | null;
  requested_model: string | null;
  model_id: string;
  served_model: string | null;
  fallback_from: string | null;
  routing_reason: string | null;
  status: "success" | "error";
  error_code: string | null;
  latency_ms: number | null;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  units: number | string | null;
  entitlement: string | null;
  estimated_cost: number | string | null;
  tools: string[] | null;
}

const field =
  "h-9 rounded-xl border border-s-line-strong bg-transparent px-3 text-[13px] text-s-ink outline-none transition placeholder:text-s-ink-3 focus:border-[color-mix(in_srgb,var(--s-accent)_45%,transparent)]";

/** Admin diagnostics: why each request used the model and units it did. No prompts or replies. */
export function RequestLog() {
  const [rows, setRows] = useState<RequestRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(true);

  const fetchRows = useCallback(
    (filter: string) =>
      jsonFetch<{ requests: RequestRow[] }>(`/api/admin/diagnostics?${new URLSearchParams({ limit: "100", ...(filter.trim() ? { email: filter.trim() } : {}) })}`).then(
        (r) => {
          setRows(r.requests);
          setError(null);
        },
        (e: Error) => setError(e.message),
      ).finally(() => setLoading(false)),
    [],
  );
  const load = (filter: string) => {
    setLoading(true);
    void fetchRows(filter);
  };

  useEffect(() => {
    void fetchRows("");
  }, [fetchRows]);

  return (
    <section aria-labelledby="requests-h" className="glass rounded-[22px] p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="requests-h" className="text-[15px] font-semibold">
          Request log
        </h2>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void load(email);
          }}
        >
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Filter by email" aria-label="Filter by email" className={cn(field, "w-48")} />
          <button type="submit" disabled={loading} aria-label="Refresh" className="grid h-9 w-9 place-items-center rounded-xl border border-s-line-strong transition hover:bg-s-hover disabled:opacity-50">
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </button>
        </form>
      </div>
      <p className="mt-1 text-[12.5px] text-s-ink-3">
        Which model answered each request, why, and the units it was charged. Prompts and replies are not shown. Failed requests with no output are charged 0 units.
      </p>
      {error && <p className="mt-3 text-[13px] text-s-danger">{error}</p>}
      {rows && rows.length === 0 && <p className="mt-3 text-[13px] text-s-ink-3">No requests yet.</p>}
      {rows && rows.length > 0 && (
        <ul className="mt-3 divide-y divide-s-line">
          {rows.map((r, i) => (
            <li key={`${r.request_id ?? ""}-${r.created_at}-${i}`} className="py-3 text-[12.5px]">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <time dateTime={r.created_at} className="text-s-ink-3">
                  {new Date(r.created_at).toLocaleString()}
                </time>
                <span className="text-s-ink-2">{r.user_email ?? "unknown user"}</span>
                <span className="rounded-full border border-s-line-strong px-1.5 py-px text-[11px] text-s-ink-3">{r.purpose ?? "—"}</span>
                <span className={cn("rounded-full px-1.5 py-px text-[11px]", r.status === "success" ? "bg-s-hover text-s-ink-2" : "text-s-danger")}>{r.status}</span>
                <span className="ml-auto font-medium text-s-ink">
                  {Number(r.units ?? 0)} unit{Number(r.units) === 1 ? "" : "s"}
                  {r.entitlement === "admin_unlimited" ? " · admin, not counted" : r.entitlement ? ` · ${r.entitlement.replace("plan:", "")}` : ""}
                </span>
              </div>
              <p className="mt-1 text-s-ink">
                <span className="text-s-ink-3">{r.requested_model ?? "?"} → </span>
                <code className="text-[12px]">{r.model_id}</code>
                {r.fallback_from && <span className="text-s-ink-3"> (fallback from {r.fallback_from})</span>}
                {r.tools?.length ? <span className="text-s-ink-3"> · tools: {r.tools.join(", ")}</span> : null}
              </p>
              {r.routing_reason && <p className="mt-0.5 text-s-ink-3">{r.routing_reason}</p>}
              <p className="mt-0.5 text-s-ink-3">
                {r.latency_ms != null ? `${(r.latency_ms / 1000).toFixed(1)} s` : "—"} · {r.input_tokens ?? "?"} in{r.cached_input_tokens ? ` (${r.cached_input_tokens} cached)` : ""} / {r.output_tokens ?? "?"} out tokens
                {r.estimated_cost != null ? ` · $${Number(r.estimated_cost).toFixed(5)}` : ""}
                {r.request_id ? ` · request ${r.request_id.slice(0, 8)}` : ""}
              </p>
              {r.error_code && <p className="mt-0.5 text-s-danger">{r.error_code}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
