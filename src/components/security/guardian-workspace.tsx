"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, CircleAlert, CircleCheck, CircleMinus, CircleX, Wrench } from "lucide-react";
import { useApp } from "@/components/layout/app-context";
import { StudioHeader, useStudio } from "@/components/studio/frame";
import { Segmented } from "@/components/studio/ui";
import { jsonFetch } from "@/hooks/use-ndjson";
import type { GuardianSummary } from "@/lib/security/guardian/analyse";
import { engineeringKind, KIND_LABEL, type EngineeringKind } from "@/lib/security/guardian/categories";
import type { ImpactReport } from "@/lib/security/guardian/impact";
import type { MemorySummary } from "@/lib/security/guardian/memory";
import { Section } from "./audit-views";
import { ConfidenceBadge, FindingStatus, fmtTime, SeverityBadge } from "./bits";

/**
 * Code Guardian workspace: engineering health of the repositories you've audited — defects, dependency
 * compatibility, architecture and maintainability, change-impact analysis and repair history. Everything shown
 * comes from stored audit results; checks Code Guardian didn't run are shown as "not run", never as passed.
 */

interface Run {
  id: string;
  asset: string | null;
  status: string;
  started_at: string;
  finished_at: string | null;
  tools: { tool: string; status: string; detail: string }[];
  stats: {
    engineering: { defects: number; dependencies: number; maintainability: number; security: number } | null;
    files: number | null;
    guardian: (GuardianSummary & { memory: MemorySummary | null; trimmed?: string }) | null;
  };
}
interface Finding {
  id: string;
  rule_id: string;
  title: string;
  severity: string;
  confidence: string;
  status: string;
  asset: string;
  location: string | null;
  verification: string;
  last_seen: string;
  occurrences: number;
}
interface Workspace {
  runs: Run[];
  findings: Finding[];
  history: { id: string; action: string; finding_id: string | null; detail: Record<string, unknown>; created_at: string }[];
}

type Tab = "overview" | "defects" | "architecture" | "dependencies" | "impact" | "repairs";
const OPEN = new Set(["open", "investigating", "fix_proposed"]);
const SEV = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as Record<string, number>;

export function GuardianWorkspace() {
  const { user, integrations } = useApp();
  const [tab, setTab] = useState<Tab>("overview");
  const [data, setData] = useState<Workspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asset, setAsset] = useState<string | null>(null);
  const signedOut = integrations.supabase ? !user : true;

  useEffect(() => {
    if (signedOut) return;
    let alive = true;
    const load = () =>
      jsonFetch<Workspace>("/api/security/guardian/workspace")
        .then((d) => alive && setData(d))
        .catch((e: Error) => alive && setError(e.message));
    void load();
    return () => {
      alive = false;
    };
  }, [signedOut]);

  // Poll while an audit is running so the current step stays accurate.
  const running = data?.runs.some((r) => r.status === "running");
  useEffect(() => {
    if (!running) return;
    const t = setInterval(
      () =>
        void jsonFetch<Workspace>("/api/security/guardian/workspace")
          .then(setData)
          .catch(() => {}),
      5000,
    );
    return () => clearInterval(t);
  }, [running]);

  const assets = useMemo(() => [...new Set((data?.runs ?? []).filter((r) => r.asset).map((r) => r.asset!))], [data]);
  // Default to the most recent repository that has engineering results (older audits ran before they existed).
  const current = asset ?? data?.runs.find((r) => r.asset && r.status === "completed" && r.stats.guardian)?.asset ?? assets[0] ?? null;
  const latest = data?.runs.find((r) => r.asset === current && r.status === "completed" && r.stats.guardian) ?? null;
  const findings = useMemo(() => (data?.findings ?? []).filter((f) => f.asset === current), [data, current]);

  const header = (
    <StudioHeader>
      <Link href="/agents/security" className="inline-flex items-center gap-1.5 text-[14px] text-s-ink-2 transition hover:text-s-ink">
        <ArrowLeft className="h-4 w-4" /> Security
      </Link>
      <span className="text-s-ink-3">/</span>
      <span className="whitespace-nowrap text-[14px] font-medium">Code Guardian</span>
    </StudioHeader>
  );

  return (
    <>
      {header}
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1180px] space-y-5 px-4 pb-24 pt-2 sm:px-8">
          <div className="s-in">
            <h1 className="font-serif text-[clamp(30px,4.5vw,42px)] leading-[1.05]">Code Guardian</h1>
            <p className="mt-2 max-w-3xl text-[15px] text-s-ink-2">
              Engineering health of the code you audit: defects, dependency compatibility, architecture, change impact and repairs. Audits read your code without running it; repairs are done by the
              coding agent in its own sandbox, with your approval at each step.
            </p>
          </div>
          {!signedOut && assets.length > 1 && (
            <label className="flex max-w-md flex-col gap-1 text-[12.5px] text-s-ink-3">
              Repository or upload
              <select value={current ?? ""} onChange={(e) => setAsset(e.target.value)} className="h-9 rounded-xl border border-s-line bg-transparent px-2.5 text-[13.5px] text-s-ink">
                {assets.map((a) => (
                  <option key={a} value={a}>
                    {a.replace(/^github:/, "")}
                  </option>
                ))}
              </select>
            </label>
          )}
          <Segmented
            label="Code Guardian sections"
            value={tab}
            onChange={setTab}
            options={[
              { value: "overview", label: "Overview" },
              { value: "defects", label: "Defects" },
              { value: "architecture", label: "Architecture" },
              { value: "dependencies", label: "Dependencies" },
              { value: "impact", label: "Impact analysis" },
              { value: "repairs", label: "Repairs" },
            ]}
          />
          {signedOut ? (
            <p className="rounded-[20px] border border-dashed border-s-line-strong px-6 py-8 text-center text-[14px] text-s-ink-2">Sign in to see your code audits.</p>
          ) : error ? (
            <p role="alert" className="flex items-center gap-2 text-[14px] text-s-danger">
              <CircleAlert className="h-4 w-4" /> {error}
            </p>
          ) : !data ? (
            <div className="s-skeleton h-48 rounded-2xl" />
          ) : !assets.length ? (
            <Section title="No code audits yet">
              <p className="text-[13.5px] text-s-ink-2">
                Run Code Guardian from the{" "}
                <Link href="/agents/security" className="underline underline-offset-2">
                  Security Team
                </Link>{" "}
                on a GitHub repository (or uploaded files). Its engineering analysis appears here.
              </p>
            </Section>
          ) : tab === "overview" ? (
            <Overview runs={data.runs} latest={latest} findings={findings} asset={current!} />
          ) : tab === "defects" ? (
            <Defects findings={findings} asset={current!} />
          ) : tab === "architecture" ? (
            <Architecture latest={latest} />
          ) : tab === "dependencies" ? (
            <Dependencies latest={latest} findings={findings.filter((f) => engineeringKind(f.rule_id) === "dependency")} asset={current!} />
          ) : tab === "impact" ? (
            <Impact assets={assets.filter((a) => a.startsWith("github:"))} current={current} />
          ) : (
            <Repairs history={data.history} findings={data.findings} />
          )}
        </div>
      </div>
    </>
  );
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-xl border border-s-line px-3 py-2.5">
      <dt className="text-[12px] text-s-ink-3">{label}</dt>
      <dd className="mt-0.5 text-[20px] font-semibold tabular-nums">{value}</dd>
      {hint && <dd className="text-[11.5px] text-s-ink-3">{hint}</dd>}
    </div>
  );
}

const STEP_ICON: Record<string, ReactNode> = {
  ok: <CircleCheck className="h-4 w-4 text-emerald-600" aria-label="done" />,
  failed: <CircleX className="h-4 w-4 text-s-danger" aria-label="failed" />,
  skipped: <CircleMinus className="h-4 w-4 text-s-ink-3" aria-label="skipped" />,
};

function useRepair(asset: string) {
  const router = useRouter();
  const { notify } = useStudio();
  const [busy, setBusy] = useState<string | null>(null);
  const repair = async (id: string) => {
    setBusy(id);
    try {
      const { projectId, task } = await jsonFetch<{ projectId: string; task: string }>(`/api/security/findings/${id}/fix`, { method: "POST", body: "{}" });
      const r = await jsonFetch<{ run: { id: string } }>(`/api/code/projects/${projectId}/agent`, {
        method: "POST",
        body: JSON.stringify({ request: task, options: { approvePlans: true, reviewEdits: true, commands: "safe" } }),
      });
      router.push(`/code/${projectId}?run=${r.run.id}`);
    } catch (e) {
      notify((e as Error).message);
      setBusy(null);
    }
  };
  return { repair, busy, can: asset.startsWith("github:") };
}

function FindingList({ findings, asset, empty }: { findings: Finding[]; asset: string; empty: string }) {
  const { repair, busy, can } = useRepair(asset);
  if (!findings.length) return <p className="text-[13.5px] text-s-ink-2">{empty}</p>;
  return (
    <ul className="divide-y divide-s-line">
      {findings.map((f) => (
        <li key={f.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5">
          <div className="min-w-0 flex-1 basis-[260px]">
            <Link href={`/agents/security/findings/${f.id}`} className="text-[13.5px] font-medium hover:underline">
              {f.title}
            </Link>
            <p className="truncate text-[12px] text-s-ink-3">
              {f.location ?? f.asset} · {KIND_LABEL[engineeringKind(f.rule_id) ?? "defect"]}
              {f.occurrences > 1 ? ` · seen in ${f.occurrences} scans` : ""}
              {f.verification === "not_detected" ? " · not detected by the last scan" : ""}
            </p>
          </div>
          <SeverityBadge severity={f.severity} />
          <ConfidenceBadge confidence={f.confidence} />
          <FindingStatus status={f.status} />
          {can && OPEN.has(f.status) && f.location && (
            <button
              type="button"
              disabled={!!busy}
              onClick={() => void repair(f.id)}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-s-line-strong px-2.5 text-[12.5px] transition hover:bg-s-hover disabled:opacity-50"
              aria-label={`Repair with the coding agent: ${f.title}`}
            >
              <Wrench className="h-3.5 w-3.5" /> {busy === f.id ? "Opening…" : "Repair"}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/* --------------------------------------------------------------- overview */

function Overview({ runs, latest, findings, asset }: { runs: Run[]; latest: Run | null; findings: Finding[]; asset: string }) {
  const g = latest?.stats.guardian ?? null;
  const open = findings.filter((f) => OPEN.has(f.status));
  const by = (k: EngineeringKind) => open.filter((f) => engineeringKind(f.rule_id) === k).length;
  const activeRuns = runs.filter((r) => r.status === "running");
  const next = [...open]
    .filter((f) => f.severity !== "info")
    .sort((a, b) => SEV[a.severity]! - SEV[b.severity]!)
    .slice(0, 5);
  const m = g?.memory ?? null;
  return (
    <div className="space-y-4">
      {activeRuns.length > 0 && (
        <Section title="In progress">
          <ul className="space-y-2 text-[13.5px]">
            {activeRuns.map((r) => (
              <li key={r.id}>
                <Link href={`/agents/security/runs/${r.id}`} className="font-medium hover:underline">
                  {r.asset?.replace(/^github:/, "") ?? "Code audit"}
                </Link>{" "}
                <span className="text-s-ink-3">
                  — started {fmtTime(r.started_at)}; {r.tools.length ? `last finished step: ${r.tools[r.tools.length - 1]!.tool}` : "starting"}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Open defects" value={by("defect")} />
        <Stat label="Dependency issues" value={by("dependency")} />
        <Stat label="Maintainability notes" value={by("maintainability")} />
        <Stat label="Regressions" value={m ? m.regressions.length : "—"} hint={m ? `${m.resolvedThisScan} no longer detected` : "No history yet"} />
      </dl>
      {!latest ? (
        <Section title="No engineering analysis yet">
          <p className="text-[13.5px] text-s-ink-2">The latest audit of {asset.replace(/^github:/, "")} ran before engineering analysis existed. Run Code Guardian again to see it.</p>
        </Section>
      ) : (
        <>
          <Section title="Next actions" note="Ordered by severity. Repairs open the coding agent with plan approval and edit review on; nothing is pushed or deployed.">
            <FindingList findings={next} asset={asset} empty="No open defects or dependency issues above informational severity." />
          </Section>
          <Section title="Checks" note="Code Guardian reads code; it doesn't execute it. These are the project's own checks and how to run them — none of them ran during the audit.">
            <table className="w-full text-left text-[13px]">
              <thead className="text-[12px] text-s-ink-3">
                <tr>
                  <th className="py-1 pr-3 font-medium">Check</th>
                  <th className="py-1 pr-3 font-medium">Status</th>
                  <th className="py-1 font-medium">Command</th>
                </tr>
              </thead>
              <tbody>
                {g!.checks.map((c) => (
                  <tr key={c.what} className="border-t border-s-line align-top">
                    <td className="py-1.5 pr-3">{c.what}</td>
                    <td className="py-1.5 pr-3 text-s-ink-2">Not run — {c.why}</td>
                    <td className="py-1.5 font-mono text-[12px]">{c.command ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
          <Section title={`Last audit · ${fmtTime(latest.started_at)}`}>
            <ol className="space-y-1.5 text-[13px]">
              {latest.tools.map((t, i) => (
                <li key={i} className="flex items-start gap-2 [&>svg]:mt-0.5 [&>svg]:shrink-0">
                  {STEP_ICON[t.status] ?? STEP_ICON.skipped}
                  <span>
                    <span className="font-medium">{t.tool}</span> <span className="text-s-ink-2">— {t.detail}</span>
                  </span>
                </li>
              ))}
            </ol>
            <Link href={`/agents/security/runs/${latest.id}`} className="mt-3 inline-block text-[13px] underline underline-offset-2">
              Open the full run
            </Link>
          </Section>
          <ProfileView g={g!} />
          {m && <MemoryView m={m} />}
          <Section title="What this analysis can't tell you">
            <ul className="list-disc space-y-1 pl-5 text-[13px] text-s-ink-2">
              {g!.limits.map((l) => (
                <li key={l}>{l}</li>
              ))}
              {m?.unavailable.map((l) => (
                <li key={l}>{l}</li>
              ))}
              {g!.trimmed && <li>{g!.trimmed}</li>}
            </ul>
          </Section>
        </>
      )}
    </div>
  );
}

function ProfileView({ g }: { g: GuardianSummary }) {
  const p = g.profile;
  const row = (k: string, v: ReactNode) => (
    <div className="grid grid-cols-[150px_1fr] gap-3 border-t border-s-line py-1.5 first:border-0">
      <dt className="text-s-ink-3">{k}</dt>
      <dd className="min-w-0 break-words">{v}</dd>
    </div>
  );
  return (
    <Section title="Project profile" note="Read from the repository's own files (package.json, lockfiles, configs, workflows).">
      <dl className="text-[13px]">
        {row("Files", `${p.files} (${p.codeFiles} code files)`)}
        {row("Languages", p.languages.map((l) => `${l.lang} ${l.lines.toLocaleString("en-US")} lines`).join(" · ") || "—")}
        {row("Frameworks", p.frameworks.map((f) => `${f.name}${f.version ? ` ${f.version}` : ""}`).join(", ") || "None recognised")}
        {row("Runtime", p.runtime.map((r) => `${r.what}: ${r.value}`).join(" · ") || "Not declared")}
        {row(
          "Tests",
          p.tests.files
            ? `${p.tests.files} test files (${p.tests.frameworks.join(", ") || "framework not recognised"}) in ${p.tests.dirs.join(", ")}; run with ${p.tests.command ?? "no test command found"}`
            : "No test files found",
        )}
        {row(
          "CI",
          p.ci.length
            ? p.ci
                .map(
                  (c) =>
                    `${c.file}: ${
                      Object.entries(c.runs)
                        .filter(([, v]) => v)
                        .map(([k]) => k)
                        .join(", ") || "no test/lint/build step recognised"
                    }`,
                )
                .join(" · ")
            : "No CI workflow found",
        )}
        {row("Scripts", p.scripts.join(", ") || "—")}
        {row(
          "Configuration",
          `${p.env.referenced} environment variables referenced; ${p.env.documentedIn.length ? `documented in ${p.env.documentedIn.join(", ")}` : "no .env.example"}${p.env.undocumented.length ? `; not documented: ${p.env.undocumented.join(", ")}` : ""}`,
        )}
        {row("Migrations", p.migrations.map((m) => `${m.dir} (${m.files})`).join(", ") || "None found")}
        {row("Docs", `${p.docs.readme ?? "No README"}; ${p.docs.docs} doc files${p.docs.decisions ? `; ${p.docs.decisions} decision records` : ""}`)}
      </dl>
    </Section>
  );
}

function MemoryView({ m }: { m: MemorySummary }) {
  return (
    <Section title="Regression memory" note="From this repository's earlier audits. History points to where to look; each item was re-checked against the current code in this audit.">
      <dl className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(["defects", "dependencies", "maintainability", "security"] as const).map((k) => (
          <Stat
            key={k}
            label={k[0]!.toUpperCase() + k.slice(1)}
            value={m.counts[k]}
            hint={m.previous ? `${(m.delta[k] ?? 0) >= 0 ? "+" : ""}${m.delta[k] ?? 0} vs ${fmtTime(m.previous.at)}` : "first audit"}
          />
        ))}
      </dl>
      {m.regressions.length > 0 && (
        <p className="mb-2 text-[13px]">
          <span className="font-medium text-s-danger">Came back after being fixed:</span> {m.regressions.map((r) => `${r.title}${r.location ? ` (${r.location})` : ""}`).join("; ")}
        </p>
      )}
      {m.fragile.length > 0 && (
        <p className="mb-2 text-[13px]">
          <span className="font-medium">Fragile files:</span> {m.fragile.map((f) => `${f.file} (${f.open} open${f.regressions ? `, ${f.regressions} regression` : ""})`).join("; ")}
        </p>
      )}
      {m.patterns.length > 0 && (
        <p className="mb-2 text-[13px]">
          <span className="font-medium">Repeated mistakes</span> (same rule in several files — worth fixing once, e.g. with a shared helper or a lint rule):{" "}
          {m.patterns.map((p) => `${p.rule} in ${p.files} files`).join("; ")}
        </p>
      )}
      {m.longStanding.length > 0 && (
        <p className="text-[13px]">
          <span className="font-medium">Long-standing:</span> {m.longStanding.map((l) => `${l.title} (${l.scans} scans since ${l.since})`).join("; ")}
        </p>
      )}
      {!m.regressions.length && !m.fragile.length && !m.patterns.length && !m.longStanding.length && <p className="text-[13px] text-s-ink-2">Nothing recurring yet.</p>}
    </Section>
  );
}

/* ---------------------------------------------------------------- defects */

function Defects({ findings, asset }: { findings: Finding[]; asset: string }) {
  const [kind, setKind] = useState<"all" | EngineeringKind>("all");
  const [show, setShow] = useState<"open" | "all">("open");
  const list = findings.filter((f) => (kind === "all" || engineeringKind(f.rule_id) === kind) && (show === "all" || OPEN.has(f.status))).sort((a, b) => SEV[a.severity]! - SEV[b.severity]!);
  return (
    <Section
      title="Engineering findings"
      note="Separate from security findings. 'Firm' rules match patterns that are wrong in practically every case; 'tentative' ones need a look at the surrounding code. Open a finding for the failure scenario, how to test the fix, and the investigation steps."
    >
      <div className="mb-3 flex flex-wrap gap-2">
        <Segmented
          label="Kind"
          value={kind}
          onChange={setKind}
          options={[
            { value: "all", label: "All" },
            { value: "defect", label: "Defects" },
            { value: "dependency", label: "Dependencies" },
            { value: "maintainability", label: "Maintainability" },
          ]}
        />
        <Segmented
          label="Status"
          value={show}
          onChange={setShow}
          options={[
            { value: "open", label: "Open" },
            { value: "all", label: "All statuses" },
          ]}
        />
      </div>
      <FindingList findings={list} asset={asset} empty="Nothing here for this filter." />
    </Section>
  );
}

/* ----------------------------------------------------------- architecture */

function Architecture({ latest }: { latest: Run | null }) {
  const g = latest?.stats.guardian;
  if (!g) return <p className="text-[13.5px] text-s-ink-2">Run Code Guardian on this repository to see its structure.</p>;
  const m = g.maintain;
  const list = (items: string[], empty: string) =>
    items.length ? (
      <ul className="space-y-1 text-[13px]">
        {items.map((x) => (
          <li key={x} className="break-words">
            {x}
          </li>
        ))}
      </ul>
    ) : (
      <p className="text-[13px] text-s-ink-2">{empty}</p>
    );
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Modules" value={g.graph.modules} hint={`${g.graph.edges} internal imports`} />
        <Stat label="Import cycles" value={m.cycles.length} />
        <Stat label="Unused files" value={g.graph.orphans.count} hint="nothing imports them" />
        <Stat label="Unused exports" value={g.graph.deadExports.count} hint={`+${g.graph.exportOnlyUsedLocally} only used in their own file`} />
      </dl>
      <Section title="Most depended-on files" note="Changes here reach the most code: give them the most tests and the most careful review.">
        {list(
          m.hotspots.map((h) => `${h.file} — imported by ${h.dependents} file${h.dependents === 1 ? "" : "s"} (${h.transitive} including indirect), ${h.lines} lines`),
          "No shared modules found.",
        )}
      </Section>
      <Section title="Import cycles">
        {list(
          m.cycles.map((c) => c.path.map((p) => p.replace(" → ", " imports ")).join("; ") || c.files.join(", ")),
          "None found among runtime imports.",
        )}
      </Section>
      {g.graph.broken.length > 0 && (
        <Section title="Imports that don't resolve" note={g.graph.brokenReported ? "Reported as defects." : "Not reported as defects: uploaded files may not be the whole project."}>
          {list(
            g.graph.broken.map((b) => `${b.file}:${b.line} → "${b.spec}"${b.caseOnly ? " (differs only in letter case)" : ""}`),
            "",
          )}
        </Section>
      )}
      <Section
        title="Long or branch-heavy functions"
        note={`Over ${m.thresholds.longFunction} lines or ${m.thresholds.complexFunction} decision points. Split them when you next change them, with tests first — not just for the number.`}
      >
        {list(
          [...m.complexFunctions, ...m.longFunctions.filter((l) => !m.complexFunctions.some((c) => c.file === l.file && c.name === l.name))].map(
            (f) => `${f.name} — ${f.file}:${f.line}, ${f.lines} lines, ${f.complexity} decision points`,
          ),
          "None over the thresholds.",
        )}
      </Section>
      <Section title="Large files">
        {list(
          m.largeFiles.map((f) => `${f.file} — ${f.lines} lines`),
          `None over ${m.thresholds.largeFile} lines.`,
        )}
      </Section>
      <Section title="Duplicated code">
        {list(
          m.duplicates.map((d) => `${d.lines} lines: ${d.a} and ${d.b}`),
          `No blocks of ${m.thresholds.duplicateLines}+ identical lines.`,
        )}
      </Section>
      <Section title="Unused code" note="Static view: code loaded dynamically or from outside the repository can't be seen, so check before deleting.">
        {list(
          [
            ...g.graph.orphans.sample.map((o) => `${o} (no file imports it)`),
            ...g.graph.deadExports.sample.map((d) => `${d.name} in ${d.file}:${d.line} (exported, never imported, unused in its file)`),
          ],
          "None found.",
        )}
      </Section>
      <Section title={`Debt markers (${m.debt.total})`} note="TODO, FIXME, HACK and XXX in comments.">
        {list(
          m.debt.items.map((d) => `${d.file}:${d.line} — ${d.text}`),
          "None in comments.",
        )}
      </Section>
    </div>
  );
}

/* ----------------------------------------------------------- dependencies */

function Dependencies({ latest, findings, asset }: { latest: Run | null; findings: Finding[]; asset: string }) {
  const c = latest?.stats.guardian?.compat;
  return (
    <div className="space-y-4">
      <Section title="Compatibility issues" note="Security advisories for dependencies are in the security findings (OSV check). Upgrades are never made automatically.">
        <FindingList findings={findings.filter((f) => OPEN.has(f.status))} asset={asset} empty="No open dependency issues." />
      </Section>
      {c && (
        <Section title="What was checked">
          <ul className="space-y-1 text-[13px]">
            <li>Manifests: {c.manifests.join(", ") || "none"}</li>
            <li>Lockfiles: {c.lockfiles.join(", ") || "none"}</li>
            <li>
              {c.direct} direct dependencies{c.installed !== null ? `, ${c.installed} installed packages` : ""}
            </li>
            {c.checked.map((x) => (
              <li key={x}>Checked: {x}</li>
            ))}
            {c.notChecked.map((x) => (
              <li key={x} className="text-s-ink-2">
                Not checked: {x}
              </li>
            ))}
            {c.duplicates.length > 0 && <li className="text-s-ink-2">Installed in several versions: {c.duplicates.map((d) => `${d.name} (${d.versions.join(", ")})`).join("; ")}</li>}
          </ul>
        </Section>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- impact */

function Impact({ assets, current }: { assets: string[]; current: string | null }) {
  const [repo, setRepo] = useState(current?.startsWith("github:") ? current.slice(7) : (assets[0]?.slice(7) ?? ""));
  const [files, setFiles] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<{ repo: string; ref: string; unknown: string[]; report: ImpactReport } | null>(null);
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      setRes(
        await jsonFetch(`/api/security/guardian/impact`, {
          method: "POST",
          body: JSON.stringify({
            repo,
            files: files
              .split(/[\s,]+/)
              .filter(Boolean)
              .slice(0, 20),
          }),
        }),
      );
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const r = res?.report;
  return (
    <div className="space-y-4">
      <Section title="What could break if these files change?" note="Reads a fresh snapshot of the repository and follows its imports. Changes nothing.">
        <div className="grid gap-3 sm:grid-cols-[1fr_2fr_auto] sm:items-end">
          <label className="flex flex-col gap-1 text-[12.5px] text-s-ink-3">
            GitHub repository
            <input
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              list="guardian-repos"
              placeholder="owner/name"
              className="h-9 rounded-xl border border-s-line bg-transparent px-2.5 text-[13.5px] text-s-ink"
            />
            <datalist id="guardian-repos">
              {assets.map((a) => (
                <option key={a} value={a.slice(7)} />
              ))}
            </datalist>
          </label>
          <label className="flex flex-col gap-1 text-[12.5px] text-s-ink-3">
            Files you plan to change (paths, separated by spaces or commas)
            <input
              value={files}
              onChange={(e) => setFiles(e.target.value)}
              placeholder="src/lib/auth.ts src/app/api/orders/route.ts"
              className="h-9 rounded-xl border border-s-line bg-transparent px-2.5 font-mono text-[12.5px] text-s-ink"
            />
          </label>
          <button
            type="button"
            disabled={busy || !repo.trim() || !files.trim()}
            onClick={() => void run()}
            className="h-9 rounded-xl bg-s-accent px-4 text-[13.5px] font-medium text-s-accent-ink disabled:opacity-50"
          >
            {busy ? "Analysing…" : "Analyse"}
          </button>
        </div>
        {err && (
          <p role="alert" className="mt-2 text-[13px] text-s-danger">
            {err}
          </p>
        )}
      </Section>
      {r && (
        <>
          <Section title={`Risk: ${r.risk}`} note={`${res!.repo} at ${res!.ref}.${res!.unknown.length ? ` Not found: ${res!.unknown.join(", ")}.` : ""}`}>
            <ul className="list-disc space-y-1 pl-5 text-[13px]">
              {r.riskReasons.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
            <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Dependent files" value={r.affectedTotal} />
              <Stat label="Entry points reached" value={r.entryPoints.length} />
              <Stat label="Tests reaching it" value={r.tests.length} />
              <Stat label="Changed files without tests" value={r.untested.length} />
            </dl>
          </Section>
          <Section title="Test plan" note="Smallest relevant checks first, widening with the risk. Planned — not run.">
            <ol className="list-decimal space-y-2 pl-5 text-[13px]">
              {r.plan.map((p, i) => (
                <li key={i}>
                  {p.why}
                  {p.command && <code className="mt-0.5 block break-all rounded-md bg-s-hover px-2 py-1 font-mono text-[12px]">{p.command}</code>}
                </li>
              ))}
            </ol>
          </Section>
          {r.rollback.length > 0 && (
            <Section title="Rollback approach">
              <ul className="list-disc space-y-1 pl-5 text-[13px]">
                {r.rollback.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </Section>
          )}
          <Section title={`Affected files (${r.affectedTotal})`} note={r.limits.join(" ")}>
            <div className="s-scroll max-h-[320px] overflow-y-auto" tabIndex={0} role="region" aria-label="Affected files">
              <ul className="space-y-0.5 font-mono text-[12px]">
                {r.affected.map((a) => (
                  <li key={a.file}>
                    {a.file} <span className="text-s-ink-3">({a.distance === 1 ? "imports it directly" : `${a.distance} steps away`})</span>
                  </li>
                ))}
              </ul>
            </div>
            {r.entryPoints.length > 0 && <p className="mt-3 text-[12.5px] text-s-ink-2">Entry points: {r.entryPoints.join(", ")}</p>}
          </Section>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- repairs */

function Repairs({ history, findings }: { history: Workspace["history"]; findings: Finding[] }) {
  const byId = new Map(findings.map((f) => [f.id, f]));
  const repairs = history.filter((h) => h.action === "fix.project_opened" && h.finding_id && byId.has(h.finding_id));
  const impacts = history.filter((h) => h.action === "impact.analysed");
  const done = findings.filter((f) => f.status === "fixed" || f.status === "verified");
  return (
    <div className="space-y-4">
      <Section
        title="Repairs started"
        note="Each opens a Code project from the repository; the coding agent works there with plan approval and edit review. Its report says what ran, what passed and what couldn't be verified."
      >
        {repairs.length ? (
          <ul className="divide-y divide-s-line text-[13px]">
            {repairs.map((h) => {
              const f = byId.get(h.finding_id!)!;
              return (
                <li key={h.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                  <span className="text-s-ink-3">{fmtTime(h.created_at)}</span>
                  <Link href={`/agents/security/findings/${f.id}`} className="min-w-0 flex-1 font-medium hover:underline">
                    {f.title}
                  </Link>
                  <FindingStatus status={f.status} />
                  {typeof h.detail.projectId === "string" && (
                    <Link href={`/code/${h.detail.projectId}`} className="underline underline-offset-2">
                      Open project
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-[13px] text-s-ink-2">No repairs started yet. Use “Repair” on an open finding (GitHub repositories only — uploaded code isn&apos;t kept).</p>
        )}
      </Section>
      <Section title="Fixed and verified" note="A finding counts as verified only when a later audit no longer detects it.">
        <ul className="space-y-1 text-[13px]">
          {done.length ? (
            done.map((f) => (
              <li key={f.id}>
                <Link href={`/agents/security/findings/${f.id}`} className="hover:underline">
                  {f.title}
                </Link>{" "}
                — <FindingStatus status={f.status} />
              </li>
            ))
          ) : (
            <li className="text-s-ink-2">None yet.</li>
          )}
        </ul>
      </Section>
      {impacts.length > 0 && (
        <Section title="Impact analyses">
          <ul className="space-y-1 text-[13px]">
            {impacts.map((h) => (
              <li key={h.id}>
                <span className="text-s-ink-3">{fmtTime(h.created_at)}</span> — {String(h.detail.repo ?? "")}: {Array.isArray(h.detail.files) ? (h.detail.files as string[]).join(", ") : ""} (
                {String(h.detail.risk ?? "")} risk)
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
