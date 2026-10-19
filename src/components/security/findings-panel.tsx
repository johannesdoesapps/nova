"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ChevronRight, Download, Search } from "lucide-react";
import { jsonFetch } from "@/hooks/use-ndjson";
import { cn } from "@/lib/utils";
import { AGENT_NAME, AgentBadge, ConfidenceBadge, FINDING_STATUS_LABEL, FindingStatus, fmtTime, ICON_OF, SeverityBadge } from "./bits";
import { inputCls } from "./forms";

export interface FindingSummary {
  id: string;
  agent: string;
  title: string;
  severity: string;
  confidence: string;
  asset: string;
  location: string | null;
  status: string;
  verification: string;
  duplicate_of: string | null;
  evidence_source: string;
  occurrences: number;
  last_seen: string;
}

export interface FindingFilters {
  agent: string;
  severity: string;
  status: string;
  asset: string;
  q: string;
  sort: "severity" | "recent" | "oldest";
  includeDuplicates: boolean;
}
export const EMPTY_FILTERS: FindingFilters = { agent: "", severity: "", status: "", asset: "", q: "", sort: "severity", includeDuplicates: false };

const selectCls = "h-9 rounded-xl border border-s-line bg-transparent px-2.5 text-[13px] text-s-ink outline-none focus:border-s-line-strong";

export function FindingsPanel({ filters, onFilters, assets, version }: { filters: FindingFilters; onFilters: (f: FindingFilters) => void; assets: string[]; version: number }) {
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; findings: FindingSummary[]; error?: string }>({ status: "loading", findings: [] });
  const [q, setQ] = useState(filters.q);

  useEffect(() => {
    const t = setTimeout(() => q !== filters.q && onFilters({ ...filters, q }), 300);
    return () => clearTimeout(t);
  }, [q, filters, onFilters]);

  useEffect(() => {
    let alive = true;
    const p = new URLSearchParams();
    for (const k of ["agent", "severity", "status", "asset", "q", "sort"] as const) if (filters[k]) p.set(k, filters[k]);
    if (filters.includeDuplicates) p.set("includeDuplicates", "1");
    jsonFetch<{ findings: FindingSummary[] }>(`/api/security/findings?${p}`)
      .then((r) => alive && setState({ status: "ready", findings: r.findings }))
      .catch((e: Error) => alive && setState({ status: "error", findings: [], error: e.message }));
    return () => {
      alive = false;
    };
  }, [filters, version]);

  const set = (patch: Partial<FindingFilters>) => onFilters({ ...filters, ...patch });
  const active = Object.entries(filters).some(([k, v]) => k !== "sort" && v);

  return (
    <div>
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="relative lg:w-[260px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-s-ink-3" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search findings" aria-label="Search findings" className={cn(inputCls, "h-9 pl-9 text-[13px]")} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Agent" value={filters.agent} onChange={(e) => set({ agent: e.target.value })} className={selectCls}>
            <option value="">All agents</option>
            {["sentinel", "threat_hunter", "code_guardian"].map((a) => (
              <option key={a} value={a}>
                {AGENT_NAME[a]}
              </option>
            ))}
          </select>
          <select aria-label="Severity" value={filters.severity} onChange={(e) => set({ severity: e.target.value })} className={selectCls}>
            <option value="">All severities</option>
            {["critical", "high", "medium", "low", "info"].map((s) => (
              <option key={s} value={s}>
                {s[0]!.toUpperCase() + s.slice(1)}
              </option>
            ))}
          </select>
          <select aria-label="Status" value={filters.status} onChange={(e) => set({ status: e.target.value })} className={selectCls}>
            <option value="">All statuses</option>
            {Object.entries(FINDING_STATUS_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <select aria-label="Asset" value={filters.asset} onChange={(e) => set({ asset: e.target.value })} className={cn(selectCls, "max-w-[180px]")}>
            <option value="">All assets</option>
            {assets.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <select aria-label="Sort" value={filters.sort} onChange={(e) => set({ sort: e.target.value as FindingFilters["sort"] })} className={selectCls}>
            <option value="severity">Most severe first</option>
            <option value="recent">Recently seen</option>
            <option value="oldest">Oldest first</option>
          </select>
          <label className="flex items-center gap-1.5 text-[12.5px] text-s-ink-2">
            <input type="checkbox" checked={filters.includeDuplicates} onChange={(e) => set({ includeDuplicates: e.target.checked })} className="accent-[var(--s-accent)]" /> Show duplicates
          </label>
          {active && (
            <button
              type="button"
              onClick={() => {
                setQ("");
                onFilters(EMPTY_FILTERS);
              }}
              className="text-[12.5px] text-s-ink-2 underline underline-offset-2"
            >
              Clear
            </button>
          )}
        </div>
        <div className="flex gap-1.5 lg:ml-auto">
          <a href="/api/security/export?format=md" className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-s-line px-3 text-[12.5px] transition hover:bg-s-hover">
            <Download className="h-3.5 w-3.5" /> Report (.md)
          </a>
          <a href="/api/security/export?format=json" className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-s-line px-3 text-[12.5px] transition hover:bg-s-hover">
            <Download className="h-3.5 w-3.5" /> JSON
          </a>
        </div>
      </div>

      <div className="mt-4">
        {state.status === "loading" ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="s-skeleton h-[68px] rounded-2xl" />
            ))}
          </div>
        ) : state.status === "error" ? (
          <p role="alert" className="text-[13.5px] text-s-danger">
            {state.error}
          </p>
        ) : state.findings.length === 0 ? (
          <div className="rounded-[22px] border border-dashed border-s-line-strong px-6 py-10 text-center">
            <p className="text-[15px] font-medium">{active ? "No findings match these filters" : "No findings yet"}</p>
            <p className="mt-1 text-[13.5px] text-s-ink-2">{active ? "Try clearing a filter." : "Run an agent above. Findings appear here only after a real scan, investigation or audit."}</p>
          </div>
        ) : (
          <ul className="space-y-2">
            {state.findings.map((f) => (
              <li key={f.id}>
                <Link href={`/agents/security/findings/${f.id}`} className="glass group flex items-center gap-3 rounded-2xl px-4 py-3 transition hover:border-s-line-strong hover:bg-s-glass-strong">
                  <AgentBadge agent={f.agent} icon={ICON_OF[f.agent]!} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-medium">
                      {f.title}
                      {f.duplicate_of && <span className="ml-2 text-[11.5px] font-normal text-s-ink-3">duplicate</span>}
                    </p>
                    <p className="mt-0.5 truncate text-[12.5px] text-s-ink-3">
                      {f.asset}
                      {f.location ? ` · ${f.location}` : ""} · {f.evidence_source} · seen {fmtTime(f.last_seen)}
                      {f.occurrences > 1 ? ` · ${f.occurrences}×` : ""}
                    </p>
                  </div>
                  <div className="hidden shrink-0 items-center gap-1.5 sm:flex">
                    <SeverityBadge severity={f.severity} />
                    <ConfidenceBadge confidence={f.confidence} />
                    <FindingStatus status={f.status} />
                  </div>
                  <div className="sm:hidden">
                    <SeverityBadge severity={f.severity} />
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 text-s-ink-3 transition group-hover:translate-x-0.5" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
