"use client";
import { useRef, useState } from "react";
import { Loader2, Play, Square } from "lucide-react";
import type { CodeRunResult } from "@/lib/code/languages";

type State =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; result: CodeRunResult & { runsLeft: number | null; timeLimitSeconds: number } }
  | { status: "error"; message: string; action?: { href: string; label: string } };

/** Run button for a code block, plus the output panel underneath it. */
export function useCodeRun(language: string, code: string) {
  const [state, setState] = useState<State>({ status: "idle" });
  const abort = useRef<AbortController | null>(null);

  async function run() {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setState({ status: "running" });
    try {
      const res = await fetch("/api/code/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ language, code, requestId: crypto.randomUUID() }),
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const err = data?.error as { code?: string; message?: string; details?: { upgradeTo?: string | null } } | undefined;
        if (res.status === 401) {
          setState({ status: "error", message: "Sign in to run code.", action: { href: `/login?next=${encodeURIComponent(location.pathname)}`, label: "Sign in" } });
        } else {
          const upgrade = err?.details?.upgradeTo;
          setState({
            status: "error",
            message: err?.message ?? "The code couldn't be run.",
            action: upgrade ? { href: `/pricing?plan=${upgrade}`, label: "See plans" } : undefined,
          });
        }
        return;
      }
      setState({ status: "done", result: data });
    } catch {
      if (ctrl.signal.aborted) setState({ status: "idle" });
      else setState({ status: "error", message: "The code couldn't be run. Check your connection and try again." });
    }
  }

  function stop() {
    abort.current?.abort();
    setState({ status: "idle" });
  }

  return { state, run, stop };
}

export function RunButton({ running, onRun, onStop }: { running: boolean; onRun: () => void; onStop: () => void }) {
  return running ? (
    <button type="button" onClick={onStop} className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 font-sans text-[11.5px] opacity-80 transition hover:opacity-100" aria-label="Stop running">
      <Square className="h-3 w-3" /> Stop
    </button>
  ) : (
    <button type="button" onClick={onRun} className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 font-sans text-[11.5px] opacity-80 transition hover:opacity-100" aria-label="Run this code">
      <Play className="h-3.5 w-3.5" /> Run
    </button>
  );
}

export function RunOutput({ state }: { state: State }) {
  if (state.status === "idle") return null;
  if (state.status === "running") {
    return (
      <div className="nova-run-out" role="status">
        <span className="nova-run-meta"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Running in an isolated sandbox…</span>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="nova-run-out" role="alert">
        <span className="nova-run-meta">
          {state.message}
          {state.action && (
            <a href={state.action.href} className="nova-run-link">{state.action.label}</a>
          )}
        </span>
      </div>
    );
  }
  const r = state.result;
  const ok = r.exitCode === 0 && !r.timedOut;
  const seconds = (r.durationMs / 1000).toFixed(1);
  return (
    <div className="nova-run-out" aria-live="polite">
      {r.stdout && <pre className="nova-run-stdout">{r.stdout}</pre>}
      {r.stderr && <pre className="nova-run-stderr">{r.stderr}</pre>}
      {!r.stdout && !r.stderr && <span className="nova-run-meta">No output.</span>}
      <span className="nova-run-meta">
        <span className={ok ? "nova-run-ok" : "nova-run-bad"}>{r.timedOut ? `Stopped after ${r.timeLimitSeconds} s` : `Exit ${r.exitCode}`}</span>
        <span>· {seconds} s</span>
        {r.truncated && <span>· output shortened</span>}
        {r.runsLeft !== null && <span>· {r.runsLeft.toLocaleString("en-US")} runs left this month</span>}
      </span>
    </div>
  );
}
