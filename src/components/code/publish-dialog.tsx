"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, CheckCircle2, CircleAlert, Copy, ExternalLink, Globe, Loader2, RotateCw, Trash2, UploadCloud } from "lucide-react";
import { Dialog } from "@/components/studio/ui";
import { cn } from "@/lib/utils";
import { api, CodeApiError, post } from "./api";

/**
 * Publishing a project as a public website: the Publish button for the workspace header, and the dialog that
 * saves pending edits, checks the files, starts the deployment, follows it and shows the live address only once
 * Orbis has opened it from outside. See src/app/api/code/projects/[id]/publish/route.ts.
 */

interface Problem {
  level: "error" | "warning";
  message: string;
}
export interface PublishStatus {
  configured: boolean;
  site: { url: string; deploymentId: string; publishedAt: string | null; fingerprint: string | null } | null;
  pending: { deploymentId: string; state: string } | null;
  current: { fingerprint: string; problems: Problem[]; files: number; bytes: number; kind: "static" | "build"; name: string };
  upToDate: boolean | null;
}
interface Progress {
  phase: "building" | "publishing" | "live" | "failed";
  state?: string;
  url?: string;
  error?: string | null;
}

type Step = "save" | "check" | "build" | "publish" | "live";
const STEPS: { id: Step; label: string; detail: string }[] = [
  { id: "save", label: "Preparing", detail: "Saving your latest edits" },
  { id: "check", label: "Checking files", detail: "Entry point, links and secrets" },
  { id: "build", label: "Building", detail: "Uploading and building on the host" },
  { id: "publish", label: "Publishing", detail: "Assigning the address and opening it" },
  { id: "live", label: "Live", detail: "Anyone with the link can visit" },
];

type Run = { step: Step; failed: string | null; problems: Problem[]; deploymentId: string | null; url: string | null };

const POLL_MS = 2500;
const GIVE_UP_MS = 12 * 60_000;

export function PublishButton({ status, onClick, busy, disabled }: { status: PublishStatus | null; onClick: () => void; busy: boolean; disabled?: boolean }) {
  const live = !!status?.site;
  const changes = live && status?.upToDate === false;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-busy={busy || undefined}
      title={live ? (changes ? "Your site is live; you have changes that aren't published yet" : `Live at ${status!.site!.url}`) : "Publish this website so anyone can visit it"}
      className="s-publish"
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> : <UploadCloud className="h-3.5 w-3.5" aria-hidden />}
      <span className="hidden sm:inline">{busy ? "Publishing…" : "Publish"}</span>
      <span className="sm:hidden sr-only">Publish</span>
      {!busy && live && <span className={cn("s-publish-dot", changes && "s-publish-dot-changed")} aria-label={changes ? "Unpublished changes" : "Live"} />}
    </button>
  );
}

/** The publish state of a project, refreshed on demand. */
export function usePublishStatus(projectId: string) {
  const [status, setStatus] = useState<PublishStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setStatus(await api<PublishStatus>(`/api/code/projects/${projectId}/publish`));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't check the site.");
    }
  }, [projectId]);
  return { status, error, refresh };
}

export function PublishDialog({
  open,
  onClose,
  projectId,
  projectName,
  status,
  statusError,
  refresh,
  saveEdits,
  onBusy,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  projectName: string;
  status: PublishStatus | null;
  statusError: string | null;
  refresh: () => Promise<void>;
  /** Save edits still waiting in the editor, so the published site is what the user sees. */
  saveEdits: () => Promise<void>;
  onBusy: (busy: boolean) => void;
}) {
  const [run, setRun] = useState<Run | null>(null);
  const [copied, setCopied] = useState<boolean | "failed">(false);
  const [confirmDown, setConfirmDown] = useState(false);
  const [downBusy, setDownBusy] = useState(false);
  const [downError, setDownError] = useState<string | null>(null);
  const alive = useRef(true);
  const polling = useRef<string | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      polling.current = null;
    };
  }, []);

  const busy = !!run && run.step !== "live" && !run.failed;
  useEffect(() => onBusy(busy), [busy, onBusy]);

  // Fresh status each time the dialog opens.
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const follow = useCallback(
    async (deploymentId: string) => {
      polling.current = deploymentId;
      const started = Date.now();
      while (alive.current && polling.current === deploymentId) {
        let p: Progress;
        try {
          p = await api<Progress>(`/api/code/projects/${projectId}/publish?deployment=${encodeURIComponent(deploymentId)}`);
        } catch (e) {
          // A dropped connection doesn't stop the publish on the host: keep asking for a while.
          if (Date.now() - started > GIVE_UP_MS || (e instanceof CodeApiError && e.status !== 0 && e.status < 500)) {
            setRun((r) => r && { ...r, failed: e instanceof Error ? e.message : "Couldn't follow the publish." });
            return;
          }
          await new Promise((r) => setTimeout(r, POLL_MS * 2));
          continue;
        }
        if (!alive.current || polling.current !== deploymentId) return;
        if (p.phase === "live") {
          setRun((r) => r && { ...r, step: "live", url: p.url ?? null });
          void refresh();
          return;
        }
        if (p.phase === "failed") {
          setRun((r) => r && { ...r, step: r.step === "build" && p.state === "READY" ? "publish" : r.step, failed: p.error ?? "The publish didn't finish." });
          void refresh();
          return;
        }
        setRun((r) => r && { ...r, step: p.phase === "publishing" ? "publish" : "build" });
        if (Date.now() - started > GIVE_UP_MS) {
          setRun((r) => r && { ...r, failed: "It's taking unusually long. The host may still finish it: close this and check again in a few minutes." });
          return;
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    },
    [projectId, refresh],
  );

  // A publish started earlier (another tab, or before a reload) is picked up instead of starting a second one.
  useEffect(() => {
    if (!open || run || !status?.pending) return;
    const id = status.pending.deploymentId;
    setRun({ step: "build", failed: null, problems: [], deploymentId: id, url: null });
    void follow(id);
  }, [open, run, status?.pending, follow]);

  const publish = async () => {
    setCopied(false);
    setRun({ step: "save", failed: null, problems: [], deploymentId: null, url: null });
    try {
      await saveEdits();
    } catch {
      setRun((r) => r && { ...r, failed: "Your latest edits couldn't be saved, so nothing was published. Check your connection and try again." });
      return;
    }
    setRun((r) => r && { ...r, step: "check" });
    try {
      const r = await post<{ deploymentId: string; warnings: Problem[] }>(`/api/code/projects/${projectId}/publish`, { confirm: true });
      if (!alive.current) return;
      setRun((x) => x && { ...x, step: "build", deploymentId: r.deploymentId, problems: r.warnings });
      await follow(r.deploymentId);
    } catch (e) {
      const problems = e instanceof CodeApiError && Array.isArray(e.details?.problems) ? (e.details.problems as Problem[]) : [];
      setRun((r) => r && { ...r, failed: e instanceof Error ? e.message : "Publishing failed.", problems });
    }
  };

  const takeDown = async () => {
    setDownBusy(true);
    setDownError(null);
    try {
      await api(`/api/code/projects/${projectId}/publish`, { method: "DELETE", body: JSON.stringify({ confirm: true }) });
      setConfirmDown(false);
      setRun(null);
      await refresh();
    } catch (e) {
      setDownError(e instanceof Error ? e.message : "Couldn't take the site down.");
    } finally {
      setDownBusy(false);
    }
  };

  const copy = async (url: string) => {
    let ok = true;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      ok = false;
    }
    setCopied(ok ? true : "failed");
    setTimeout(() => alive.current && setCopied(false), 2500);
  };

  const close = () => {
    // Closing doesn't cancel anything: a publish in progress keeps being followed (the button shows it) and
    // reopening shows where it is. A finished or failed one is cleared.
    if (run && (run.failed || run.step === "live")) setRun(null);
    setConfirmDown(false);
    onClose();
  };

  const site = status?.site ?? null;
  const liveUrl = run?.step === "live" ? (run.url ?? site?.url ?? null) : (site?.url ?? null);
  const problems = run?.problems.length ? run.problems : (status?.current.problems ?? []);
  const blocking = !run && problems.some((p) => p.level === "error");
  const stepIndex = run ? STEPS.findIndex((s) => s.id === run.step) : -1;

  return (
    <Dialog open={open} onClose={close} title={site ? "Your website" : "Publish your website"} description={projectName} width={520}>
      <div className="space-y-4">
        {statusError && !status && (
          <p role="alert" className="rounded-xl border border-s-danger/40 px-3.5 py-2.5 text-[13px] text-s-danger">
            {statusError}
          </p>
        )}
        {!status && !statusError && (
          <div className="space-y-2" role="status" aria-label="Checking the site">
            <div className="s-skeleton h-16 rounded-2xl" />
            <div className="s-skeleton h-10 rounded-2xl" />
          </div>
        )}

        {status && !status.configured && (
          <div className="s-card rounded-2xl p-4 text-[13.5px]">
            <p className="font-medium">Publishing isn&apos;t set up on this Orbis yet</p>
            <p className="mt-1 text-s-ink-2">An administrator needs to connect a hosting account (a Vercel access token in ORBIS_PUBLISH_VERCEL_TOKEN). Until then, you can download the project as a .zip from the project menu.</p>
          </div>
        )}

        {/* The live site */}
        {status?.configured && liveUrl && (!run || run.step === "live") && (
          <div className="s-publish-live rounded-2xl p-4">
            <div className="flex items-center gap-2 text-[12.5px]">
              <span className="s-publish-dot" aria-hidden />
              <span className="font-medium">{run?.step === "live" ? "Published, and loading for everyone" : "Live"}</span>
              {run?.step !== "live" && status.upToDate === false && <span className="ml-auto rounded-full bg-[color-mix(in_srgb,var(--s-warn,#d97706)_16%,transparent)] px-2 py-0.5 text-[11.5px] text-s-ink">Unpublished changes</span>}
              {run?.step !== "live" && status.upToDate === true && <span className="ml-auto text-[11.5px] text-s-ink-3">Up to date</span>}
            </div>
            <a href={liveUrl} target="_blank" rel="noopener noreferrer" className="mt-2 block truncate font-mono text-[14px] text-s-ink underline-offset-4 hover:underline" data-testid="publish-url">
              {liveUrl.replace(/^https:\/\//, "")}
            </a>
            {site?.publishedAt && run?.step !== "live" && <p className="mt-1 text-[12px] text-s-ink-3">Published {new Date(site.publishedAt).toLocaleString()}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" onClick={() => void copy(liveUrl)} className="s-publish-ghost">
                {copied === true ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
                {copied === true ? "Copied" : copied === "failed" ? "Select the address to copy it" : "Copy link"}
              </button>
              <a href={liveUrl} target="_blank" rel="noopener noreferrer" className="s-publish-ghost">
                <ExternalLink className="h-3.5 w-3.5" aria-hidden /> Open website
              </a>
            </div>
          </div>
        )}

        {/* Progress */}
        {run && run.step !== "live" && (
          <div role="status" aria-live="polite" className="s-card rounded-2xl p-4">
            <div className="s-publish-track" aria-hidden>
              <div className={cn("s-publish-bar", run.failed && "s-publish-bar-failed")} style={{ width: `${Math.max(8, ((stepIndex + (run.failed ? 0 : 0.5)) / (STEPS.length - 1)) * 100)}%` }} />
            </div>
            <ol className="mt-3 space-y-2">
              {STEPS.slice(0, -1).map((s, i) => {
                const state = i < stepIndex ? "done" : i === stepIndex ? (run.failed ? "failed" : "active") : "todo";
                return (
                  <li key={s.id} className={cn("flex items-center gap-2.5 text-[13px]", state === "todo" && "text-s-ink-3")} data-step={s.id} data-state={state}>
                    <span className="grid h-5 w-5 place-items-center">
                      {state === "done" && <CheckCircle2 className="h-4 w-4 text-[var(--s-ok,#16a34a)]" aria-hidden />}
                      {state === "active" && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />}
                      {state === "failed" && <CircleAlert className="h-4 w-4 text-s-danger" aria-hidden />}
                      {state === "todo" && <span className="h-1.5 w-1.5 rounded-full bg-s-line-strong" aria-hidden />}
                    </span>
                    <span className="font-medium">{s.label}</span>
                    <span className="truncate text-s-ink-3">{s.detail}</span>
                  </li>
                );
              })}
            </ol>
            {run.failed && (
              <p role="alert" className="mt-3 rounded-xl border border-s-danger/40 px-3 py-2 text-[13px] text-s-danger">
                {run.failed}
              </p>
            )}
          </div>
        )}

        {/* What publishing the saved files would do */}
        {status?.configured && problems.length > 0 && (!run || run.failed || run.step === "live") && (
          <ul className="space-y-1.5" aria-label="Checks">
            {problems.map((p, i) => (
              <li key={i} className={cn("flex gap-2 text-[12.5px]", p.level === "error" ? "text-s-danger" : "text-s-ink-2")}>
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>{p.message}</span>
              </li>
            ))}
          </ul>
        )}

        {status?.configured && !run && (
          <p className="text-[12.5px] text-s-ink-3">
            {site
              ? "Publishing again replaces the live site with your saved files. The address stays the same."
              : `Your saved files (${status.current.files} file${status.current.files === 1 ? "" : "s"}${status.current.kind === "build" ? ", built by the host" : ""}) go on a public address anyone can open. Files like .env and keys stay private.`}
          </p>
        )}

        {/* Actions */}
        {status?.configured && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {(!run || run.failed || run.step === "live") && (
              <button type="button" onClick={() => void publish()} disabled={blocking} className="s-publish s-publish-lg">
                {run?.failed ? <RotateCw className="h-4 w-4" aria-hidden /> : <UploadCloud className="h-4 w-4" aria-hidden />}
                {run?.failed ? "Retry" : site || run?.step === "live" ? "Publish changes" : "Publish website"}
              </button>
            )}
            {busy && (
              <span className="inline-flex items-center gap-2 text-[12.5px] text-s-ink-3">
                <Globe className="h-3.5 w-3.5" aria-hidden /> You can close this; publishing carries on.
              </span>
            )}
            {site && !busy && !confirmDown && (
              <button type="button" onClick={() => setConfirmDown(true)} className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[12.5px] text-s-ink-3 transition hover:text-s-danger">
                <Trash2 className="h-3.5 w-3.5" aria-hidden /> Take site down
              </button>
            )}
          </div>
        )}
        {confirmDown && (
          <div className="rounded-2xl border border-s-danger/40 p-3.5 text-[13px]">
            <p>Take the site down? Its address stops working for everyone. Your project files stay as they are, and you can publish again later.</p>
            {downError && (
              <p role="alert" className="mt-2 text-s-danger">
                {downError}
              </p>
            )}
            <div className="mt-3 flex gap-2">
              <button type="button" onClick={() => void takeDown()} disabled={downBusy} className="inline-flex h-9 items-center rounded-full bg-s-danger px-4 text-[13px] font-medium text-s-danger-ink disabled:opacity-50">
                {downBusy ? "Taking it down…" : "Take it down"}
              </button>
              <button type="button" onClick={() => setConfirmDown(false)} className="s-publish-ghost">
                Keep it live
              </button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
