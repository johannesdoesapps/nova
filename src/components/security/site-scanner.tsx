"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleMinus,
  CircleX,
  Clock,
  Copy,
  Download,
  Globe,
  Info,
  Loader2,
  Lock,
  RotateCw,
  ScanSearch,
  ShieldCheck,
  Square,
  TriangleAlert,
} from "lucide-react";
import { useApp } from "@/components/layout/app-context";
import { StudioHeader } from "@/components/studio/frame";
import { Segmented } from "@/components/studio/ui";
import { jsonFetch, postNdjson } from "@/hooks/use-ndjson";
import { GRADE_METHOD } from "@/lib/security/sitescan/grade";
import { CATEGORY_LABEL, type CheckCategory, type CheckResult, type CheckStatus, type ScanReport } from "@/lib/security/sitescan/types";
import { cn } from "@/lib/utils";
import { fmtTime, SeverityBadge } from "./bits";
import { VERIFY_PATH, type Target } from "./forms";

/**
 * The website security scanner: SSL/TLS, certificate, HTTP headers, cookies, content, server configuration and DNS
 * for a website you've verified you control. Results show exactly what was checked, with evidence, and keep
 * "failed" apart from "couldn't test".
 */

type StepId = "authorize" | "resolve" | "tls" | "http" | "exposure" | "dns" | "grade";
const STEPS: { id: StepId; label: string }[] = [
  { id: "authorize", label: "Ownership check" },
  { id: "resolve", label: "Resolve the hostname" },
  { id: "tls", label: "TLS protocols, ciphers and certificate" },
  { id: "http", label: "HTTPS redirect, headers, cookies and content" },
  { id: "exposure", label: "Exposed files and server methods" },
  { id: "dns", label: "DNS: CAA, DNSSEC, SPF and DMARC" },
  { id: "grade", label: "Score and grade" },
];
type StepState = { status: "pending" | "running" | "done" | "skipped" | "failed"; detail?: string };

interface Overview {
  host: string;
  scope: string;
  grade: string | null;
  score: number | null;
  gradeNote: string | null;
  counts: { passed: number; failed: number; warning: number; inconclusive: number; untested: number; skipped: number; info: number; severity: Record<"critical" | "high" | "medium" | "low", number> };
  certDaysLeft: number | null;
  certValidTo: string | null;
  finishedAt: string;
}
interface HistoryItem {
  id: string;
  host: string | null;
  scope: string | null;
  status: string;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  overview: Overview | null;
}

const STATUS_META: Record<CheckStatus, { label: string; icon: typeof Check; cls: string }> = {
  failed: { label: "Failed", icon: CircleX, cls: "text-s-danger" },
  warning: { label: "Warning", icon: TriangleAlert, cls: "text-amber-600 dark:text-amber-300" },
  inconclusive: { label: "Inconclusive", icon: CircleHelp, cls: "text-violet-600 dark:text-violet-300" },
  untested: { label: "Not tested", icon: CircleDashed, cls: "text-s-ink-3" },
  skipped: { label: "Skipped", icon: CircleMinus, cls: "text-s-ink-3" },
  info: { label: "Info", icon: Info, cls: "text-sky-600 dark:text-sky-300" },
  passed: { label: "Passed", icon: CircleCheck, cls: "text-emerald-600 dark:text-emerald-400" },
};
const STATUS_ORDER: CheckStatus[] = ["failed", "warning", "inconclusive", "untested", "skipped", "info", "passed"];
const SECTIONS: { title: string; categories: CheckCategory[] }[] = [
  { title: "SSL/TLS", categories: ["tls"] },
  { title: "Certificate", categories: ["certificate"] },
  { title: "HTTP security headers", categories: ["headers"] },
  { title: "Web configuration", categories: ["server", "cookies", "content", "exposure"] },
  { title: "DNS", categories: ["dns"] },
];
const GRADE_TINT: Record<string, string> = {
  "A+": "from-emerald-400/45 via-emerald-300/15",
  A: "from-emerald-400/40 via-emerald-300/10",
  B: "from-lime-400/40 via-lime-300/10",
  C: "from-amber-400/45 via-amber-300/10",
  D: "from-orange-500/45 via-orange-400/10",
  F: "from-red-500/50 via-red-400/10",
};
const GRADE_INK: Record<string, string> = {
  "A+": "text-emerald-600 dark:text-emerald-300",
  A: "text-emerald-600 dark:text-emerald-300",
  B: "text-lime-700 dark:text-lime-300",
  C: "text-amber-600 dark:text-amber-300",
  D: "text-orange-600 dark:text-orange-300",
  F: "text-s-danger",
};
const proto = (k: string) => (k === "TLSv1" ? "TLS 1.0" : k.replace("TLSv", "TLS "));
type Filter = "all" | "problems" | "passed" | "not-run";
const matches = (c: CheckResult, f: Filter) =>
  f === "all" || (f === "problems" ? c.status === "failed" || c.status === "warning" : f === "passed" ? c.status === "passed" || c.status === "info" : ["skipped", "inconclusive", "untested"].includes(c.status));

export function SiteScanner() {
  const { user, integrations } = useApp();
  const signedOut = integrations.supabase ? !user : true;
  const router = useRouter();
  const params = useSearchParams();
  const openId = params.get("scan");

  const [targets, setTargets] = useState<Target[] | null>(null);
  const [history, setHistory] = useState<HistoryItem[] | null>(null);
  const [domain, setDomain] = useState("");
  const [scope, setScope] = useState<"passive" | "active">("passive");
  const [authorized, setAuthorized] = useState(false);
  const [pendingTarget, setPendingTarget] = useState<Target | null>(null);
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<Record<string, StepState>>({});
  const [progress, setProgress] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [report, setReport] = useState<ScanReport | null>(null);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const loadTargets = useCallback(async () => {
    const r = await jsonFetch<{ targets: Target[] }>("/api/security/targets");
    setTargets(r.targets);
    return r.targets;
  }, []);
  const loadHistory = useCallback(async () => {
    const r = await jsonFetch<{ scans: HistoryItem[] }>("/api/security/sitescan");
    setHistory(r.scans);
  }, []);

  useEffect(() => {
    if (signedOut) return;
    let alive = true;
    jsonFetch<{ targets: Target[] }>("/api/security/targets")
      .then((r) => alive && setTargets(r.targets))
      .catch((e: Error) => alive && setError(e.message));
    jsonFetch<{ scans: HistoryItem[] }>("/api/security/sitescan")
      .then((r) => alive && setHistory(r.scans))
      .catch(() => alive && setHistory([]));
    return () => {
      alive = false;
    };
  }, [signedOut]);

  // Open a stored report (?scan=<id>); `loadedId` marks which one has arrived.
  const shownId = report?.runId ?? null;
  useEffect(() => {
    // Nothing to fetch when the report on screen is that scan (it just finished).
    if (!openId || signedOut || running || openId === shownId) return;
    let alive = true;
    jsonFetch<{ report: ScanReport | null; status: string; error: string | null; host: string }>(`/api/security/sitescan/${openId}`)
      .then((r) => {
        if (!alive) return;
        if (r.report) {
          setReport(r.report);
          setDomain(r.report.host);
          setError(null);
        } else setError(r.error ?? `This scan ${r.status === "running" ? "is still running" : "has no report"}.`);
      })
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setLoadedId(openId));
    return () => {
      alive = false;
    };
  }, [openId, signedOut, running, shownId]);
  const loadingReport = !!openId && loadedId !== openId && report?.runId !== openId;

  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 500);
    return () => clearInterval(t);
  }, [running]);

  const normalize = (s: string) =>
    s
      .trim()
      .toLowerCase()
      .replace(/^[a-z]+:\/\//, "")
      .replace(/[/?#].*$/, "")
      .replace(/:(80|443)$/, "")
      .replace(/\.$/, "");

  const scan = async (force = false, hostOverride?: string) => {
    setError(null);
    setNotice(null);
    const host = normalize(hostOverride ?? domain);
    if (!host) return setError("Enter a domain you own, like example.com.");
    if (!authorized) return setError("Confirm you own this website or have permission to test it.");
    let list = targets ?? (await loadTargets());
    let target = list.find((t) => t.hostname === host);
    try {
      if (!target) {
        const r = await jsonFetch<{ target: Target }>("/api/security/targets", { method: "POST", body: JSON.stringify({ host }) });
        list = await loadTargets();
        target = list.find((t) => t.id === r.target.id) ?? r.target;
      }
    } catch (e) {
      return setError((e as Error).message);
    }
    if (!target.verified_at) {
      setPendingTarget(target);
      return;
    }
    setPendingTarget(null);
    await run(target, force);
  };

  const run = async (target: Target, force: boolean) => {
    const ctrl = new AbortController();
    abort.current = ctrl;
    setRunning(true);
    setReport(null);
    setElapsed(0);
    setProgress(null);
    setSteps(Object.fromEntries(STEPS.map((s) => [s.id, { status: "pending" }])));
    if (openId) router.replace("/agents/security/scanner", { scroll: false });
    let runId: string | null = null;
    try {
      for await (const ev of postNdjson<Record<string, unknown>>("/api/security/sitescan", { targetId: target.id, scope, authorized: true, force }, ctrl.signal)) {
        if (ev.type === "run") runId = String(ev.runId);
        else if (ev.type === "step") {
          const id = String(ev.id);
          const status = ev.status === "running" ? "running" : ev.status === "done" ? "done" : ev.status === "skipped" ? "skipped" : "failed";
          setSteps((s) => ({ ...s, [id]: { status, detail: typeof ev.detail === "string" ? ev.detail : undefined } }));
        } else if (ev.type === "progress") setProgress(String(ev.text));
        else if (ev.type === "cached") setNotice(`Showing the scan from ${fmtTime(String(ev.finishedAt))} (scans are reused for 15 minutes). Use Retest to scan again now.`);
        else if (ev.type === "scan_report") setReport(ev.report as ScanReport);
        else if (ev.type === "error") throw new Error(String(ev.message));
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") setError("Scan cancelled.");
      else setError((e as Error).message);
    } finally {
      setRunning(false);
      setProgress(null);
      abort.current = null;
      void loadHistory().catch(() => {});
      void loadTargets().catch(() => {});
      if (runId) router.replace(`/agents/security/scanner?scan=${runId}`, { scroll: false });
    }
  };

  const verifyPending = async () => {
    if (!pendingTarget) return;
    setError(null);
    try {
      const r = await jsonFetch<{ verified: boolean; method?: string; reason?: string }>(`/api/security/targets/${pendingTarget.id}/verify`, { method: "POST" });
      if (!r.verified) return setError(r.reason ?? "Not verified yet.");
      const list = await loadTargets();
      const t = list.find((x) => x.id === pendingTarget.id)!;
      setPendingTarget(null);
      await run(t, false);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const header = (
    <StudioHeader>
      <Link href="/agents/security" className="inline-flex items-center gap-1.5 text-[14px] text-s-ink-2 transition hover:text-s-ink">
        <ArrowLeft className="h-4 w-4" aria-hidden /> <span className="max-sm:sr-only">Security</span>
      </Link>
      <span className="text-s-ink-3">/</span>
      <span className="whitespace-nowrap text-[14px] font-medium">
        <span className="max-sm:hidden">Website </span>Scanner
      </span>
    </StudioHeader>
  );

  return (
    <>
      {header}
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1180px] space-y-5 px-4 pb-24 pt-2 sm:px-8">
          <div className="s-in">
            <h1 className="font-serif text-[clamp(30px,4.5vw,42px)] leading-[1.05]">Website scanner</h1>
            <p className="mt-2 max-w-3xl text-[15px] text-s-ink-2">
              SSL/TLS, certificate, security headers, cookies, content and DNS checks for a website you own, with the evidence behind every result. Read-only and rate-limited: nothing on your site is
              changed.
            </p>
          </div>

          {signedOut ? (
            <p className="glass rounded-[20px] px-6 py-8 text-center text-[14px] text-s-ink-2">
              <Link href="/login?next=/agents/security/scanner" className="underline underline-offset-2">
                Sign in
              </Link>{" "}
              to scan a website you own.
            </p>
          ) : (
            <>
              <ScanBar
                domain={domain}
                setDomain={setDomain}
                scope={scope}
                setScope={setScope}
                authorized={authorized}
                setAuthorized={setAuthorized}
                running={running}
                targets={targets}
                onScan={() => void scan(false)}
                onCancel={() => abort.current?.abort()}
              />
              {pendingTarget && <VerifyPanel target={pendingTarget} onCheck={verifyPending} onCancel={() => setPendingTarget(null)} />}
              {error && (
                <p role="alert" className="glass flex items-start gap-2 rounded-2xl px-4 py-3 text-[14px] text-s-danger">
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" /> {error}
                </p>
              )}
              {notice && (
                <p role="status" className="glass flex items-start gap-2 rounded-2xl px-4 py-3 text-[13.5px] text-s-ink-2">
                  <Clock className="mt-0.5 h-4 w-4 shrink-0" /> {notice}
                </p>
              )}
              {running && <LiveProgress steps={steps} progress={progress} elapsed={elapsed} scope={scope} />}
              {!running && loadingReport && <div className="glass s-skeleton h-72 rounded-[22px]" />}
              {!running && report && (
                <Results
                  report={report}
                  onRetest={() => {
                    setDomain(report.host);
                    setScope(report.scope);
                    void scan(true, report.host);
                  }}
                  canRetest={authorized}
                />
              )}
              <History items={history} activeId={report?.runId ?? openId} />
            </>
          )}
        </div>
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- input */

function ScanBar(p: {
  domain: string;
  setDomain: (v: string) => void;
  scope: "passive" | "active";
  setScope: (v: "passive" | "active") => void;
  authorized: boolean;
  setAuthorized: (v: boolean) => void;
  running: boolean;
  targets: Target[] | null;
  onScan: () => void;
  onCancel: () => void;
}) {
  return (
    <section className="glass glass-edge rounded-[24px] p-4 sm:p-5" aria-label="Scan a website">
      <form
        className="flex flex-col gap-2.5 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (!p.running) p.onScan();
        }}
      >
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Domain</span>
          <Globe className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-s-ink-3" aria-hidden />
          <input
            value={p.domain}
            onChange={(e) => p.setDomain(e.target.value)}
            placeholder="yourdomain.com"
            autoComplete="off"
            spellCheck={false}
            inputMode="url"
            list="scanner-targets"
            disabled={p.running}
            className="h-12 w-full rounded-2xl border border-s-line bg-s-glass-strong pl-10 pr-3 text-[15px] text-s-ink outline-none transition placeholder:text-s-ink-3 focus:border-s-line-strong disabled:opacity-60"
          />
          <datalist id="scanner-targets">
            {(p.targets ?? []).map((t) => (
              <option key={t.id} value={t.hostname} />
            ))}
          </datalist>
        </label>
        {p.running ? (
          <button type="button" onClick={p.onCancel} className="inline-flex h-12 items-center justify-center gap-2 rounded-2xl border border-s-line-strong px-5 text-[14.5px] font-medium transition hover:bg-s-hover">
            <Square className="h-4 w-4" /> Cancel
          </button>
        ) : (
          <button type="submit" className="inline-flex h-12 items-center justify-center gap-2 rounded-2xl bg-s-ink px-6 text-[14.5px] font-medium text-s-bg shadow-[var(--s-shadow-sm)] transition hover:opacity-90 disabled:opacity-50" disabled={!p.domain.trim()}>
            <ScanSearch className="h-4 w-4" /> Scan website
          </button>
        )}
      </form>
      <div className="mt-3.5 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-2.5">
          <Segmented
            label="Scan depth"
            value={p.scope}
            onChange={p.setScope}
            options={[
              { value: "passive", label: "Standard" },
              { value: "active", label: "Standard + exposed files" },
            ]}
          />
          <span className="text-[12.5px] text-s-ink-3">
            {p.scope === "passive" ? "TLS handshakes, the home page over HTTPS and HTTP, a 404 page, security.txt and DNS lookups." : "Also 8 well-known sensitive paths (/.env, /.git/HEAD, …) and one TRACE request, one at a time."}
          </span>
        </div>
        <label className="flex cursor-pointer items-start gap-2 text-[13px] text-s-ink-2">
          <input type="checkbox" checked={p.authorized} onChange={(e) => p.setAuthorized(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--s-accent)]" />
          <span>I own this website or am authorised to test it.</span>
        </label>
      </div>
    </section>
  );
}

function VerifyPanel({ target, onCheck, onCancel }: { target: Target; onCheck: () => Promise<void>; onCancel: () => void }) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <section className="glass rounded-[22px] p-5 text-[13.5px] text-s-ink-2" aria-labelledby="verify-title">
      <h2 id="verify-title" className="flex items-center gap-2 text-[15px] font-semibold text-s-ink">
        <Lock className="h-4 w-4" /> Prove you control {target.hostname}
      </h2>
      <p className="mt-1">Orbis only scans websites whose owner has proved control. Do one of these, then check:</p>
      <ol className="mt-2 list-decimal space-y-1 pl-5">
        <li>
          Serve the token at <code className="rounded bg-s-hover px-1">https://{target.hostname}{VERIFY_PATH}</code>, or
        </li>
        <li>
          Add a DNS TXT record on <code className="rounded bg-s-hover px-1">_orbis-verify.{target.hostname}</code> containing the token.
        </li>
      </ol>
      <div className="mt-3 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-xl border border-s-line bg-s-glass-strong px-3 py-2 text-[12.5px]">{target.token}</code>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(target.token);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="inline-flex h-9 items-center gap-1 rounded-xl border border-s-line px-3 text-[12.5px] hover:bg-s-hover"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="mt-3.5 flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await onCheck();
            setBusy(false);
          }}
          className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-s-ink px-4 text-[13.5px] font-medium text-s-bg transition hover:opacity-90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Check and scan
        </button>
        <button type="button" onClick={onCancel} className="h-10 rounded-xl px-3.5 text-[13.5px] text-s-ink-2 hover:bg-s-hover">
          Not now
        </button>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- progress */

function LiveProgress({ steps, progress, elapsed, scope }: { steps: Record<string, StepState>; progress: string | null; elapsed: number; scope: string }) {
  const done = STEPS.filter((s) => ["done", "skipped", "failed"].includes(steps[s.id]?.status ?? "")).length;
  return (
    <section className="glass glass-edge rounded-[22px] p-5" aria-live="polite" aria-busy="true" aria-label="Scan progress">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold">
          <Loader2 className="h-4 w-4 animate-spin" /> Scanning…
        </h2>
        <span className="text-[12.5px] tabular-nums text-s-ink-3">{elapsed}s · usually 15–60 s</span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-s-hover" role="progressbar" aria-valuemin={0} aria-valuemax={STEPS.length} aria-valuenow={done} aria-label="Steps completed">
        <div className="h-full rounded-full bg-s-ink/70 transition-all duration-500" style={{ width: `${Math.max(4, (done / STEPS.length) * 100)}%` }} />
      </div>
      <ol className="mt-4 grid gap-1.5 sm:grid-cols-2">
        {STEPS.map((s) => {
          const st = steps[s.id] ?? { status: "pending" };
          const skippedByScope = s.id === "exposure" && scope === "passive" && st.status === "pending";
          return (
            <li key={s.id} className={cn("flex items-start gap-2.5 rounded-xl px-2.5 py-2 text-[13.5px] transition", st.status === "running" && "bg-s-hover")}>
              <span className="mt-0.5 shrink-0">
                {st.status === "running" ? (
                  <Loader2 className="h-4 w-4 animate-spin text-s-ink" />
                ) : st.status === "done" ? (
                  <CircleCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                ) : st.status === "failed" ? (
                  <CircleX className="h-4 w-4 text-s-danger" />
                ) : st.status === "skipped" || skippedByScope ? (
                  <CircleMinus className="h-4 w-4 text-s-ink-3" />
                ) : (
                  <CircleDashed className="h-4 w-4 text-s-ink-3" />
                )}
              </span>
              <span className="min-w-0">
                <span className={cn(st.status === "pending" ? "text-s-ink-3" : "text-s-ink")}>{s.label}</span>
                {(st.detail || (st.status === "running" && progress)) && <span className="block truncate text-[12px] text-s-ink-3">{st.status === "running" ? progress : st.detail}</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/* ---------------------------------------------------------------- results */

function Results({ report, onRetest, canRetest }: { report: ScanReport; onRetest: () => void; canRetest: boolean }) {
  const [filter, setFilter] = useState<Filter>("all");
  const counts = useMemo(() => {
    const by = (s: CheckStatus) => report.checks.filter((c) => c.status === s).length;
    const sev = (v: string) => report.checks.filter((c) => (c.status === "failed" || c.status === "warning") && c.severity === v).length;
    return { by, sev };
  }, [report]);
  const id = report.runId;
  return (
    <div className="space-y-5 s-in">
      <section className="glass glass-edge grid gap-5 rounded-[24px] p-5 sm:p-6 lg:grid-cols-[auto_1fr]" aria-label="Score">
        <GradeOrb letter={report.grade?.letter ?? null} score={report.grade?.score ?? null} />
        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="truncate text-[22px] font-semibold tracking-[-0.01em]">{report.host}</h2>
              <p className="mt-0.5 text-[12.5px] text-s-ink-3">
                {fmtTime(report.finishedAt)} · {report.scope === "active" ? "standard + exposed files" : "standard"} · {report.handshakes} TLS handshakes · {report.requests} HTTP requests · {(report.durationMs / 1000).toFixed(1)} s
                {report.addresses.length ? ` · ${report.addresses.slice(0, 2).join(", ")}` : ""}
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={onRetest}
                disabled={!canRetest}
                title={canRetest ? "Scan again now (ignores the 15-minute cache)" : "Tick the authorisation box above to retest"}
                className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-s-line-strong px-3 text-[13px] font-medium transition hover:bg-s-hover disabled:opacity-40"
              >
                <RotateCw className="h-3.5 w-3.5" /> Retest
              </button>
              {id &&
                (["md", "html", "json"] as const).map((f) => (
                  <a key={f} href={`/api/security/sitescan/${id}/export?format=${f}`} className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-s-line px-3 text-[13px] transition hover:bg-s-hover" download>
                    <Download className="h-3.5 w-3.5" /> {f === "md" ? "Markdown" : f.toUpperCase()}
                  </a>
                ))}
            </div>
          </div>
          {report.grade ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <PartBar label="Transport (TLS + certificate)" value={report.grade.parts.tls} />
              <PartBar label="Web configuration" value={report.grade.parts.web} />
            </div>
          ) : (
            <p className="text-[13.5px] text-s-ink-2">{report.gradeNote}</p>
          )}
          {report.grade && (report.grade.caps.length > 0 || report.grade.plus) && (
            <ul className="space-y-1 text-[13px] text-s-ink-2">
              {report.grade.caps.map((c) => (
                <li key={c} className="flex items-start gap-1.5">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-300" /> Grade limited: {c}
                </li>
              ))}
              {report.grade.plus && (
                <li className="flex items-start gap-1.5">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-s-ink-3" /> {report.grade.plus}
                </li>
              )}
            </ul>
          )}
          <details className="text-[12.5px] text-s-ink-3">
            <summary className="cursor-pointer select-none hover:text-s-ink-2">How the grade works</summary>
            <p className="mt-1.5 leading-relaxed">{GRADE_METHOD}</p>
          </details>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-[1.1fr_1fr]">
        <section className="glass rounded-[22px] p-5" aria-labelledby="sev-title">
          <h2 id="sev-title" className="mb-3 text-[13px] font-semibold uppercase tracking-[0.06em] text-s-ink-3">
            Severity summary
          </h2>
          <div className="grid grid-cols-4 gap-2">
            {(["critical", "high", "medium", "low"] as const).map((s) => (
              <div key={s} className="rounded-2xl border border-s-line bg-s-glass px-3 py-2.5">
                <div className="text-[22px] font-semibold tabular-nums">{counts.sev(s)}</div>
                <SeverityBadge severity={s} />
              </div>
            ))}
          </div>
          <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[12.5px]">
            {STATUS_ORDER.filter((s) => s !== "info").map((s) => {
              const M = STATUS_META[s];
              return (
                <div key={s} className="flex items-center gap-1.5 whitespace-nowrap">
                  <M.icon className={cn("h-3.5 w-3.5", M.cls)} aria-hidden />
                  <dt className="text-s-ink-3">{M.label}</dt>
                  <dd className="font-semibold tabular-nums">{counts.by(s)}</dd>
                </div>
              );
            })}
          </dl>
          <p className="mt-3 text-[12px] text-s-ink-3">A limited external scan can&apos;t show that a site is secure. &ldquo;Not tested&rdquo; and &ldquo;Inconclusive&rdquo; are not passes.</p>
        </section>
        <CertificateCard report={report} />
      </div>

      <TlsOverview report={report} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold">All checks</h2>
        <Segmented
          label="Filter checks"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: `All ${report.checks.length}` },
            { value: "problems", label: `Problems ${counts.by("failed") + counts.by("warning")}` },
            { value: "passed", label: "Passed" },
            { value: "not-run", label: "Not tested" },
          ]}
        />
      </div>
      {SECTIONS.map((sec) => {
        const list = report.checks.filter((c) => sec.categories.includes(c.category) && matches(c, filter)).sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));
        if (!list.length) return null;
        return (
          <section key={sec.title} className="glass rounded-[22px] p-2 sm:p-3" aria-label={sec.title}>
            <h3 className="px-3 pb-1 pt-2 text-[13px] font-semibold uppercase tracking-[0.06em] text-s-ink-3">{sec.title}</h3>
            <ul className="divide-y divide-s-line">
              {list.map((c) => (
                <CheckRow key={c.id} c={c} showCategory={sec.categories.length > 1} />
              ))}
            </ul>
          </section>
        );
      })}

      {(report.notes.length > 0 || report.notCovered.length > 0) && (
        <div className="grid gap-4 lg:grid-cols-2">
          {report.notes.length > 0 && (
            <section className="glass rounded-[22px] p-5">
              <h2 className="mb-2 text-[13px] font-semibold uppercase tracking-[0.06em] text-s-ink-3">Notes from this scan</h2>
              <ul className="list-disc space-y-1 pl-5 text-[13px] text-s-ink-2">
                {report.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </section>
          )}
          <section className="glass rounded-[22px] p-5">
            <h2 className="mb-2 text-[13px] font-semibold uppercase tracking-[0.06em] text-s-ink-3">Not covered by this scan</h2>
            <ul className="list-disc space-y-1 pl-5 text-[13px] text-s-ink-2">
              {report.notCovered.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </section>
        </div>
      )}
      {report.trimmed && <p className="text-[12px] text-s-ink-3">Some evidence was shortened to fit storage. The Markdown export and the Findings tab keep the full details.</p>}
    </div>
  );
}

function GradeOrb({ letter, score }: { letter: string | null; score: number | null }) {
  const pct = score ?? 0;
  return (
    <div className="flex items-center gap-4 lg:flex-col lg:justify-center">
      <div className="relative grid h-[132px] w-[132px] shrink-0 place-items-center" aria-label={letter ? `Grade ${letter}, ${score} out of 100` : "No grade"} role="img">
        <div className={cn("absolute inset-0 rounded-full bg-gradient-to-br to-transparent blur-xl", letter ? GRADE_TINT[letter] : "from-s-ink/10")} aria-hidden />
        <svg viewBox="0 0 120 120" className="absolute inset-0 h-full w-full -rotate-90" aria-hidden>
          <circle cx="60" cy="60" r="52" fill="none" strokeWidth="7" className="stroke-s-line" />
          {letter && <circle cx="60" cy="60" r="52" fill="none" strokeWidth="7" strokeLinecap="round" className={cn("transition-[stroke-dashoffset] duration-700", GRADE_INK[letter])} stroke="currentColor" strokeDasharray={2 * Math.PI * 52} strokeDashoffset={2 * Math.PI * 52 * (1 - pct / 100)} />}
        </svg>
        <div className="glass-strong relative grid h-[96px] w-[96px] place-items-center rounded-full border border-s-line">
          <span className={cn("font-serif text-[46px] leading-none", letter ? GRADE_INK[letter] : "text-s-ink-3")}>{letter ?? "–"}</span>
        </div>
      </div>
      <div className="text-center">
        <div className="text-[13px] font-semibold tabular-nums">{score === null ? "No score" : `${score}/100`}</div>
        <div className="text-[11.5px] text-s-ink-3">Orbis grade</div>
      </div>
    </div>
  );
}

function PartBar({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[12.5px]">
        <span className="text-s-ink-2">{label}</span>
        <span className="font-semibold tabular-nums">{value}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-s-hover">
        <div className={cn("h-full rounded-full transition-all duration-700", value >= 90 ? "bg-emerald-500/80" : value >= 65 ? "bg-amber-500/80" : "bg-red-500/80")} style={{ width: `${Math.max(2, value)}%` }} />
      </div>
    </div>
  );
}

function CertificateCard({ report }: { report: ScanReport }) {
  const c = report.certificate;
  if (!c)
    return (
      <section className="glass rounded-[22px] p-5">
        <h2 className="mb-2 text-[13px] font-semibold uppercase tracking-[0.06em] text-s-ink-3">Certificate</h2>
        <p className="text-[13.5px] text-s-ink-2">No certificate was received, so it couldn&apos;t be checked.</p>
      </section>
    );
  const total = Math.max(1, (new Date(c.validTo).getTime() - new Date(c.validFrom).getTime()) / 86_400_000);
  const left = Math.max(0, c.daysLeft);
  const tone = c.daysLeft < 0 ? "bg-red-500" : c.daysLeft <= 7 ? "bg-red-500" : c.daysLeft <= 30 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <section className="glass rounded-[22px] p-5" aria-labelledby="cert-title">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 id="cert-title" className="text-[13px] font-semibold uppercase tracking-[0.06em] text-s-ink-3">
          Certificate
        </h2>
        <span className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[12px] font-medium", c.trusted ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300" : "bg-red-500/12 text-s-danger")}>
          {c.trusted ? <ShieldCheck className="h-3.5 w-3.5" /> : <CircleX className="h-3.5 w-3.5" />} {c.trusted ? "Trusted" : "Not trusted"}
        </span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className={cn("text-[26px] font-semibold tabular-nums", c.daysLeft <= 7 ? "text-s-danger" : c.daysLeft <= 30 ? "text-amber-600 dark:text-amber-300" : "")}>{c.daysLeft < 0 ? `Expired ${-c.daysLeft}d ago` : `${c.daysLeft} days`}</span>
        {c.daysLeft >= 0 && <span className="text-[12.5px] text-s-ink-3">until {c.validTo.slice(0, 10)}</span>}
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-s-hover" aria-hidden>
        <div className={cn("h-full rounded-full", tone)} style={{ width: `${Math.min(100, Math.max(2, (left / total) * 100))}%` }} />
      </div>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12.5px]">
        <dt className="text-s-ink-3">Issuer</dt>
        <dd className="min-w-0 truncate" title={c.issuer}>
          {c.issuer}
        </dd>
        <dt className="text-s-ink-3">Names</dt>
        <dd className="min-w-0 truncate" title={c.names.join(", ")}>
          {c.names.join(", ") || "(none)"}
        </dd>
        <dt className="text-s-ink-3">Key</dt>
        <dd>{c.key}</dd>
        <dt className="text-s-ink-3">Signature</dt>
        <dd>{c.signature}</dd>
        {c.chain.length > 0 && (
          <>
            <dt className="text-s-ink-3">Chain</dt>
            <dd className="min-w-0">
              {c.chain.map((x, i) => (
                <span key={i} className="block truncate" title={x.subject}>
                  {i === 0 ? "" : "↳ "}
                  {x.subject}
                </span>
              ))}
            </dd>
          </>
        )}
      </dl>
    </section>
  );
}

function TlsOverview({ report }: { report: ScanReport }) {
  const [open, setOpen] = useState(false);
  const order = ["TLSv1.3", "TLSv1.2", "TLSv1.1", "TLSv1"];
  const good = (k: string, v: string) => (v === "supported" ? (k === "TLSv1" || k === "TLSv1.1" ? "bad" : "good") : v === "not supported" ? (k === "TLSv1.3" ? "warn" : k === "TLSv1.2" ? "neutral" : "good") : "unknown");
  const tone = { good: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300", bad: "border-red-500/30 bg-red-500/10 text-s-danger", warn: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300", neutral: "border-s-line text-s-ink-2", unknown: "border-dashed border-s-line-strong text-s-ink-3" };
  return (
    <section className="glass rounded-[22px] p-5" aria-labelledby="tls-title">
      <h2 id="tls-title" className="mb-3 text-[13px] font-semibold uppercase tracking-[0.06em] text-s-ink-3">
        Protocols and cipher suites
      </h2>
      <div className="flex flex-wrap gap-2">
        {order.map((k) => {
          const v = report.protocols[k] ?? "untested";
          return (
            <span key={k} className={cn("inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-[13px]", tone[good(k, v)])}>
              <span className="font-medium">{proto(k)}</span>
              <span className="text-[12px] opacity-80">{v === "supported" ? "accepted" : v === "not supported" ? "refused" : v}</span>
            </span>
          );
        })}
        <span className="inline-flex items-center gap-1.5 rounded-xl border border-dashed border-s-line-strong px-3 py-1.5 text-[13px] text-s-ink-3" title="Orbis's TLS client (OpenSSL 3) can't speak SSL 2/3">
          SSL 2/3 <span className="text-[12px]">not tested</span>
        </span>
      </div>
      {report.ciphers.length > 0 && (
        <div className="mt-3">
          <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="inline-flex items-center gap-1 text-[13px] text-s-ink-2 hover:text-s-ink">
            <ChevronDown className={cn("h-4 w-4 transition", open && "rotate-180")} /> {report.ciphers.length} accepted cipher suites ({report.ciphers.filter((c) => c.strength === "weak" || c.strength === "insecure").length} weak or insecure)
          </button>
          {open && (
            <div className="mt-2 overflow-x-auto" tabIndex={0} role="region" aria-label="Accepted cipher suites">
              <table className="w-full min-w-[520px] text-[12.5px]">
                <thead>
                  <tr className="text-left text-s-ink-3">
                    <th scope="col" className="py-1 pr-3 font-medium">Protocol</th>
                    <th scope="col" className="py-1 pr-3 font-medium">Suite</th>
                    <th scope="col" className="py-1 pr-3 font-medium">Strength</th>
                    <th scope="col" className="py-1 font-medium">Forward secrecy</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-s-line">
                  {report.ciphers.map((c) => (
                    <tr key={`${c.protocol}-${c.name}`}>
                      <td className="py-1 pr-3 text-s-ink-2">{proto(c.protocol)}</td>
                      <td className="py-1 pr-3 font-mono text-[12px]">{c.name}</td>
                      <td className={cn("py-1 pr-3 capitalize", c.strength === "insecure" ? "text-s-danger" : c.strength === "weak" ? "text-amber-600 dark:text-amber-300" : c.strength === "strong" ? "text-emerald-600 dark:text-emerald-400" : "")}>{c.strength}</td>
                      <td className="py-1">{c.forwardSecrecy ? "Yes" : "No"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function CheckRow({ c, showCategory }: { c: CheckResult; showCategory: boolean }) {
  const [open, setOpen] = useState(c.status === "failed" && (c.severity === "critical" || c.severity === "high"));
  const M = STATUS_META[c.status];
  const hasMore = c.evidence.length > 0 || !!c.remediation || c.references.length > 0;
  const problem = c.status === "failed" || c.status === "warning";
  return (
    <li>
      <button type="button" onClick={() => hasMore && setOpen(!open)} aria-expanded={hasMore ? open : undefined} className={cn("flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition", hasMore && "hover:bg-s-hover")}>
        <M.icon className={cn("mt-0.5 h-[18px] w-[18px] shrink-0", M.cls)} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[14px] font-medium">{c.title}</span>
            <span className={cn("text-[11.5px] font-medium", M.cls)}>{M.label}</span>
            {problem && <SeverityBadge severity={c.severity} />}
            {problem && !c.confirmed && (
              <span title="Inferred from other evidence rather than observed directly" className="inline-flex h-6 items-center rounded-full border border-dashed border-s-line-strong px-2 text-[11.5px] text-s-ink-2">
                Inferred
              </span>
            )}
            {showCategory && <span className="text-[11.5px] text-s-ink-3">{CATEGORY_LABEL[c.category]}</span>}
          </span>
          {c.summary && <span className="mt-0.5 block text-[13px] leading-relaxed text-s-ink-2">{c.summary}</span>}
        </span>
        {hasMore && <ChevronDown className={cn("mt-1 h-4 w-4 shrink-0 text-s-ink-3 transition", open && "rotate-180")} aria-hidden />}
      </button>
      {open && hasMore && (
        <div className="mb-2 ml-[42px] mr-3 space-y-2.5 rounded-2xl border border-s-line bg-s-glass p-3.5 text-[12.5px]">
          {c.evidence.length > 0 && (
            <div>
              <div className="mb-1 font-semibold text-s-ink-3">Evidence</div>
              <dl className="grid grid-cols-1 gap-x-3 gap-y-1 sm:grid-cols-[minmax(110px,auto)_1fr]">
                {c.evidence.map((e, i) => (
                  <Pair key={i} label={e.label}>
                    <code className="break-all font-mono text-[12px] text-s-ink">{e.value}</code>
                  </Pair>
                ))}
              </dl>
            </div>
          )}
          {c.remediation && (
            <div>
              <div className="mb-0.5 font-semibold text-s-ink-3">How to fix</div>
              <p className="leading-relaxed text-s-ink">{c.remediation}</p>
            </div>
          )}
          {c.references.length > 0 && (
            <p className="flex flex-wrap gap-x-3 gap-y-1">
              {c.references.map((u) => (
                <a key={u} href={u} target="_blank" rel="noreferrer noopener" className="truncate text-s-ink-2 underline underline-offset-2 hover:text-s-ink">
                  {u.replace(/^https?:\/\//, "")}
                </a>
              ))}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

function Pair({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-s-ink-3">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

/* ---------------------------------------------------------------- history */

function History({ items, activeId }: { items: HistoryItem[] | null; activeId: string | null | undefined }) {
  return (
    <section className="glass rounded-[22px] p-2 sm:p-3" aria-labelledby="history-title">
      <h2 id="history-title" className="px-3 pb-1 pt-2 text-[13px] font-semibold uppercase tracking-[0.06em] text-s-ink-3">
        Scan history
      </h2>
      {!items ? (
        <div className="s-skeleton m-3 h-16 rounded-xl" />
      ) : !items.length ? (
        <p className="px-3 pb-3 text-[13.5px] text-s-ink-2">No scans yet. Results are kept here with their timestamps.</p>
      ) : (
        <ul className="divide-y divide-s-line">
          {items.map((s) => {
            const o = s.overview;
            return (
              <li key={s.id}>
                <Link href={`/agents/security/scanner?scan=${s.id}`} scroll={false} className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl px-3 py-2.5 text-[13.5px] transition hover:bg-s-hover", activeId === s.id && "bg-s-hover")}>
                  <span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-s-line font-serif text-[18px]", o?.grade ? GRADE_INK[o.grade] : "text-s-ink-3")}>{o?.grade ?? (s.status === "running" ? "…" : "–")}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{s.host}</span>
                    <span className="block text-[12px] text-s-ink-3">
                      {fmtTime(s.finishedAt ?? s.startedAt)} · {s.scope === "active" ? "standard + exposed files" : "standard"}
                      {s.status !== "completed" ? ` · ${s.status}${s.error ? `: ${s.error.slice(0, 80)}` : ""}` : ""}
                    </span>
                  </span>
                  {o && (
                    <span className="flex flex-wrap items-center gap-2 text-[12px] text-s-ink-2">
                      {o.score !== null && <span className="tabular-nums">{o.score}/100</span>}
                      {o.counts.failed + o.counts.warning > 0 && (
                        <span className="tabular-nums">
                          {o.counts.failed} failed · {o.counts.warning} warnings
                        </span>
                      )}
                      {o.certDaysLeft !== null && <span className={cn("tabular-nums", o.certDaysLeft <= 30 && "text-amber-600 dark:text-amber-300", o.certDaysLeft <= 7 && "text-s-danger")}>cert {o.certDaysLeft < 0 ? "expired" : `${o.certDaysLeft}d`}</span>}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
