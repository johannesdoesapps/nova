"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { CircleAlert, CircleCheck, CircleDashed, CircleHelp, CircleX, Route, ShieldCheck } from "lucide-react";
import type { StoredAnalysis } from "@/lib/security/audit-report";
import type { CompactCodeMap } from "@/lib/security/code-map";
import type { EndpointResult } from "@/lib/security/crawl";
import { CLASSIFICATION_LABEL, type Classification } from "@/lib/security/details";
import type { Surface } from "@/lib/security/surface";
import { cn } from "@/lib/utils";
import { SEVERITY_DOT } from "./bits";

/**
 * Sentinel audit results: the gate decision, posture counts, attack paths, coverage (what was and wasn't
 * assessed), and the site and code maps. Everything shown comes from the stored run; nothing is computed
 * here that the server didn't record.
 */

export function Section({ title, children, note, id }: { title: string; children: ReactNode; note?: string; id?: string }) {
  return (
    <section className="glass rounded-[20px] p-5" aria-labelledby={id}>
      <h2 id={id} className="mb-3 text-[13px] font-semibold uppercase tracking-[0.06em] text-s-ink-3">
        {title}
      </h2>
      {children}
      {note && <p className="mt-3 text-[12px] text-s-ink-3">{note}</p>}
    </section>
  );
}

const CLASS_STYLE: Record<Classification, string> = {
  confirmed: "border-[color-mix(in_srgb,var(--s-danger)_40%,transparent)] text-s-danger",
  likely: "border-amber-500/40 text-amber-700 dark:text-amber-300",
  needs_verification: "border-s-line-strong text-s-ink-2",
  informational: "border-s-line text-s-ink-3",
  false_positive: "border-s-line text-s-ink-3 line-through",
};

export function ClassificationBadge({ value }: { value: Classification }) {
  return <span className={cn("inline-flex h-6 items-center rounded-full border px-2 text-[11.5px] font-medium", CLASS_STYLE[value])}>{CLASSIFICATION_LABEL[value]}</span>;
}

export function GateBanner({ gate }: { gate: NonNullable<StoredAnalysis["gate"]> }) {
  const passed = gate.outcome === "passed";
  const Icon = passed ? CircleCheck : gate.outcome === "failed" ? CircleX : CircleAlert;
  return (
    <section
      role="status"
      className={cn(
        "rounded-[20px] border p-5",
        passed ? "border-emerald-500/40 bg-emerald-500/[0.06]" : "border-[color-mix(in_srgb,var(--s-danger)_40%,transparent)] bg-[color-mix(in_srgb,var(--s-danger)_6%,transparent)]",
      )}
    >
      <p className="flex items-center gap-2 text-[16px] font-semibold">
        <Icon className={cn("h-5 w-5", passed ? "text-emerald-600 dark:text-emerald-400" : "text-s-danger")} aria-hidden />
        Release gate {gate.outcome === "passed" ? "passed" : gate.outcome === "failed" ? "failed" : "incomplete — treat as failed"}
      </p>
      <p className="mt-1 text-[13.5px] text-s-ink-2">{gate.reasons.join(" ") || "Every planned check ran and no open finding matches the blocking rules."}</p>
      {gate.blocking.length > 0 && (
        <ul className="mt-3 space-y-1 text-[13.5px]">
          {gate.blocking.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center gap-2">
              <span className={cn("h-2 w-2 rounded-full", SEVERITY_DOT[b.severity])} aria-hidden />
              <Link href={`/agents/security/findings/${b.id}`} className="underline underline-offset-2">
                {b.title}
              </Link>
              <ClassificationBadge value={b.classification} />
            </li>
          ))}
        </ul>
      )}
      {passed && <p className="mt-2 text-[12px] text-s-ink-3">Passing means the checks that ran found nothing blocking — not that the application is secure. See what wasn&apos;t assessed below.</p>}
    </section>
  );
}

export function PostureStrip({ analysis }: { analysis: StoredAnalysis }) {
  const p = analysis.posture;
  const c = analysis.comparison;
  const prev = c.previous;
  return (
    <Section title="Posture" note="Counts, not a score: few findings never prove an application is secure.">
      <dl className="grid grid-cols-2 gap-3 text-[13.5px] sm:grid-cols-4">
        <Stat label="Open critical / high" value={`${p.open.critical} / ${p.open.high}`} delta={prev ? p.open.critical + p.open.high - (prev.open.critical + prev.open.high) : null} />
        <Stat label="Open medium / low" value={`${p.open.medium} / ${p.open.low}`} />
        <Stat label="Confirmed or likely" value={String(p.confirmedOrLikely)} />
        <Stat label="Need verification" value={String(p.unverified)} />
      </dl>
      <p className="mt-3 text-[13px] text-s-ink-2">
        This audit: {c.created} new, {c.resolved} no longer detected, {c.reopened} reappeared after a fix, {c.persisting} still present from before.
        {analysis.notRechecked > 0 && ` ${analysis.notRechecked} earlier open finding(s) for these assets weren't re-checked (outside this audit's scope or budget).`}
        {prev && ` Compared with the previous audit of the same name on ${new Date(prev.at).toLocaleDateString()}.`}
      </p>
    </Section>
  );
}

function Stat({ label, value, delta }: { label: string; value: string; delta?: number | null }) {
  return (
    <div className="rounded-xl border border-s-line px-3 py-2.5">
      <dt className="text-[12px] text-s-ink-3">{label}</dt>
      <dd className="mt-0.5 text-[18px] font-semibold tabular-nums">
        {value}
        {typeof delta === "number" && delta !== 0 && (
          <span className={cn("ml-1.5 text-[12px] font-medium", delta > 0 ? "text-s-danger" : "text-emerald-600 dark:text-emerald-400")}>{delta > 0 ? `+${delta}` : delta} vs last</span>
        )}
      </dd>
    </div>
  );
}

export function AttackPaths({ paths }: { paths: StoredAnalysis["paths"] }) {
  return (
    <Section
      title={`Attack paths (${paths.length})`}
      note="Built only from recorded findings. “Theoretical” chains contain at least one step that isn't confirmed; even when every step is confirmed, Sentinel never runs the chain itself."
    >
      {paths.length === 0 ? (
        <p className="text-[13.5px] text-s-ink-2">No combination of these findings forms a known attack path. That doesn&apos;t rule out paths through areas that weren&apos;t assessed.</p>
      ) : (
        <ol className="space-y-3">
          {paths.map((p) => (
            <li key={p.id} className="s-card rounded-2xl p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Route className="h-4 w-4 text-s-ink-3" aria-hidden />
                <span className="text-[14.5px] font-semibold">{p.title}</span>
                <span className={cn("inline-flex items-center gap-1 text-[12px] capitalize text-s-ink-2")}>
                  <span className={cn("h-2 w-2 rounded-full", SEVERITY_DOT[p.severity])} aria-hidden /> {p.severity}
                </span>
                <span
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[11.5px]",
                    p.status === "steps_confirmed" ? "border-amber-500/40 text-amber-700 dark:text-amber-300" : "border-s-line-strong text-s-ink-2",
                  )}
                >
                  {p.status === "steps_confirmed" ? "Each step confirmed · chain not executed" : "Theoretical"}
                </span>
              </div>
              <ol className="mt-3 space-y-1.5 border-l border-s-line pl-4">
                {p.steps.map((s, i) => (
                  <li key={i} className="text-[13px]">
                    <span className="font-medium capitalize text-s-ink-3">{s.kind}: </span>
                    {s.text}
                    {s.classification && (
                      <span className="ml-1.5 align-middle">
                        <ClassificationBadge value={s.classification} />
                      </span>
                    )}
                    {s.findingIds.length > 0 && (
                      <span className="ml-1.5 text-[12px]">
                        {s.findingIds.map((id, n) => (
                          <Link key={id} href={`/agents/security/findings/${id}`} className="mr-1.5 text-s-ink-2 underline underline-offset-2">
                            evidence {n + 1}
                          </Link>
                        ))}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
              <p className="mt-2 text-[13px]">
                <span className="text-s-ink-3">Impact if every step holds: </span>
                {p.impact}
              </p>
              <p className="mt-1 text-[13px]">
                <span className="text-s-ink-3">Breaks with: </span>
                {p.breakWith}
              </p>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}

const COVER_ICON = { assessed: <CircleCheck className="text-emerald-500" />, partial: <CircleDashed className="text-amber-500" />, not_assessed: <CircleHelp className="text-s-ink-3" /> };

export function Coverage({ coverage }: { coverage: StoredAnalysis["coverage"] }) {
  const notAssessed = coverage.flatMap((c) => c.notChecked.map((n) => `${c.label}: ${n}`));
  return (
    <Section title="Coverage" id="coverage">
      <ul className="space-y-3">
        {coverage.map((c) => (
          <li key={c.id} className="flex items-start gap-2.5 [&>svg]:mt-0.5 [&>svg]:h-4 [&>svg]:w-4 [&>svg]:shrink-0">
            {COVER_ICON[c.state]}
            <div className="min-w-0 text-[13.5px]">
              <p className="font-medium">
                {c.label} <span className="font-normal text-s-ink-3">· {c.state === "assessed" ? "assessed" : c.state === "partial" ? "partly assessed" : "not assessed"}</span>
              </p>
              {c.checked.length > 0 && <p className="text-[12.5px] text-s-ink-2">Checked: {c.checked.join("; ")}.</p>}
            </div>
          </li>
        ))}
      </ul>
      {notAssessed.length > 0 && (
        <div className="mt-4 rounded-xl border border-s-line bg-s-hover/50 p-3">
          <h3 className="text-[13px] font-semibold">Not assessed ({notAssessed.length})</h3>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-[12.5px] text-s-ink-2">
            {notAssessed.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

function Table({ head, rows, empty, label }: { head: string[]; rows: ReactNode[][]; empty: string; label: string }) {
  if (!rows.length) return <p className="text-[13px] text-s-ink-3">{empty}</p>;
  return (
    // Scrolls sideways on small screens, so it must be reachable by keyboard.
    <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={label}>
      <table className="w-full min-w-[480px] text-left text-[12.5px]">
        <thead className="text-s-ink-3">
          <tr>
            {head.map((h) => (
              <th key={h} scope="col" className="border-b border-s-line py-1.5 pr-3 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="align-top">
              {r.map((c, j) => (
                <td key={j} className="border-b border-s-line/60 py-1.5 pr-3 break-words">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: { id: T; label: string }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="mb-3 flex flex-wrap gap-1.5">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cn("h-8 rounded-lg border px-2.5 text-[12.5px]", value === t.id ? "border-s-line-strong bg-s-glass-strong font-medium" : "border-s-line text-s-ink-2 hover:bg-s-hover")}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

const OUTCOME: Record<EndpointResult["outcome"], string> = { answered: "Answered without sign-in", refused: "Refused (401/403)", other: "Other" };

export function SurfaceMap({ surface, endpointResults }: { surface: Surface & { trimmed?: string[] }; endpointResults?: EndpointResult[] }) {
  const [tab, setTab] = useState<"pages" | "endpoints" | "forms" | "scripts" | "other">("endpoints");
  const results = new Map((endpointResults ?? []).map((e) => [e.path, e]));
  return (
    <Section title={`Site map · ${surface.host}`} note={["Observed with read-only requests.", ...(surface.trimmed ?? [])].join(" ")}>
      <Tabs
        label="Site map"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "endpoints", label: `API endpoints (${surface.endpoints.length})` },
          { id: "pages", label: `Pages (${surface.pages.length})` },
          { id: "forms", label: `Forms (${surface.forms.length})` },
          { id: "scripts", label: `Scripts (${surface.scripts.length})` },
          { id: "other", label: "Other" },
        ]}
      />
      {tab === "endpoints" && (
        <Table
          label="API endpoints"
          head={["Path", "Seen in", "Signed-out check"]}
          empty="No API endpoints were referenced by the pages and scripts fetched."
          rows={surface.endpoints.map((e) => {
            const r = results.get(e.path);
            return [
              <code key="p">{e.path}</code>,
              e.seenIn,
              r ? `${OUTCOME[r.outcome]}${r.status ? ` · HTTP ${r.status}` : ""}` : e.path.includes(":") ? "Needs an id (not requested)" : "Not checked",
            ];
          })}
        />
      )}
      {tab === "pages" && <Table label="Pages" head={["Page", "Status", "Title"]} empty="No pages fetched." rows={surface.pages.map((p) => [p.url, String(p.status), p.title ?? "—"])} />}
      {tab === "forms" && (
        <Table
          label="Forms"
          head={["Page", "Method → action", "Fields", "Notes"]}
          empty="No forms found."
          rows={surface.forms.map((f) => [
            f.page,
            `${f.method} ${f.action}`,
            f.fields.map((x) => `${x.name || "?"}:${x.type}`).join(", "),
            [f.hasPassword && "password", f.hasFile && "file upload", f.hasCsrfField && "anti-forgery field"].filter(Boolean).join(", ") || "—",
          ])}
        />
      )}
      {tab === "scripts" && (
        <Table
          label="Scripts"
          head={["Script", "Origin", "Integrity"]}
          empty="No scripts found."
          rows={surface.scripts.map((s) => [s.src, s.firstParty ? "This site" : "Third party", s.integrity ? "Pinned" : "—"])}
        />
      )}
      {tab === "other" && (
        <dl className="space-y-2 text-[13px]">
          <Row label="Technology seen">{surface.tech.join(", ") || "—"}</Row>
          <Row label="Redirect-style parameters">{surface.redirectParams.map((r) => r.param).join(", ") || "—"}</Row>
          <Row label="Public source maps">{surface.sourceMaps.join(", ") || "—"}</Row>
          <Row label="Linked external hosts">{surface.externalHosts.join(", ") || "—"}</Row>
          <Row label="Found but not fetched">{surface.notFetched.length ? surface.notFetched.join(", ") : "—"}</Row>
        </dl>
      )}
    </Section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[200px_1fr]">
      <dt className="text-s-ink-3">{label}</dt>
      <dd className="break-words">{children}</dd>
    </div>
  );
}

export function CodeMapView({ map }: { map: CompactCodeMap }) {
  const [tab, setTab] = useState<"routes" | "boundaries" | "stack" | "config">("routes");
  return (
    <Section title="Application map (code)" note={["Read from the files given; nothing was executed. Signals are patterns seen in each handler.", ...map.trimmed].join(" ")}>
      <Tabs
        label="Application map"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "routes", label: `Routes (${map.routeCount})` },
          { id: "boundaries", label: `Trust boundaries (${map.boundaries.length})` },
          { id: "stack", label: "Stack" },
          { id: "config", label: `Config (${map.configFiles.length})` },
        ]}
      />
      {tab === "routes" && (
        <Table
          label="Routes"
          head={["Route", "Handler", "Signals"]}
          empty="No routes recognised (Next.js, Express-style, Flask, FastAPI and Django routes are mapped)."
          rows={map.routes.map((r) => [
            <span key="r" className={cn(map.sensitiveRoutes.includes(`${r.method} ${r.path}`) && "font-medium")}>
              <code>
                {r.method} {r.path}
              </code>
            </span>,
            r.file,
            r.signals,
          ])}
        />
      )}
      {tab === "boundaries" && (
        <Table
          label="Trust boundaries"
          head={["From", "To", "Via"]}
          empty="No trust boundaries recognised."
          rows={[...map.boundaries.map((b) => [b.from, b.to, b.via]), ...map.backgroundJobs.map((j) => ["Scheduler", "Background job", j])]}
        />
      )}
      {tab === "stack" && (
        <dl className="space-y-2 text-[13px]">
          <Row label="Frameworks">{map.frameworks.join(", ") || "—"}</Row>
          <Row label="Runtimes">{map.runtimes.join(", ") || "—"}</Row>
          <Row label="Security-relevant libraries">{map.securityLibraries.join(", ") || "—"}</Row>
          <Row label="Middleware">{map.middleware.join(", ") || "—"}</Row>
          <Row label="Server actions">{map.serverActions.join(", ") || "—"}</Row>
          <Row label="Not mapped">{map.unmapped.join("; ") || "—"}</Row>
        </dl>
      )}
      {tab === "config" && <Table label="Configuration files" head={["File"]} empty="No configuration files recognised." rows={map.configFiles.map((f) => [f])} />}
    </Section>
  );
}

/** The one-line statement about scheduled monitoring: nothing runs in the background. */
export function MonitoringNote() {
  return (
    <p className="flex items-start gap-2 text-[12.5px] text-s-ink-3">
      <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      Scheduled monitoring isn&apos;t set up: audits run only when you start them. Each run is compared with earlier ones (new, no longer detected, reappeared).
    </p>
  );
}
