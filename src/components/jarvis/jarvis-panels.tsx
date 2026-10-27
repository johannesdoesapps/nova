"use client";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Check, CircleAlert, CircleDashed, CircleSlash, CircleX, Download, ExternalLink, Hourglass, Loader2, Pause, Pencil, Play, Plus, Square, Trash2, Undo2 } from "lucide-react";
import { AUTONOMY_LEVELS, type Autonomy } from "@/lib/jarvis/permissions";
import { JARVIS_MODES, type JarvisMode } from "@/lib/jarvis/planner";
import { BUILTIN_SKILLS, MAX_USER_SKILLS, skillId, skillInput, type SkillInput } from "@/lib/jarvis/skills";
import { TOOL_NAMES, TOOLS, type RiskClass, type ToolRunner } from "@/lib/jarvis/tools";
import type { Mission, Step, StepResult } from "@/lib/jarvis/mission";
import type { AgentState } from "@/lib/jarvis/desktop-client";
import { DEFAULT_SHORTCUT, shortcutConflict, shortcutLabel, VOICE_PROFILES, type JarvisSettings, type Shortcut } from "@/lib/jarvis/store";
import { Switch } from "@/components/studio/ui";
import { cn } from "@/lib/utils";

export function Panel({ title, children, actions, id }: { title: string; children: ReactNode; actions?: ReactNode; id?: string }) {
  return (
    <section aria-labelledby={id} className="glass rounded-[22px] p-4">
      <div className="mb-3 flex items-center gap-2">
        <h2 id={id} className="text-[13px] font-medium uppercase tracking-[0.08em] text-s-ink-3">
          {title}
        </h2>
        <div className="ml-auto flex items-center gap-1.5">{actions}</div>
      </div>
      {children}
    </section>
  );
}

const btn = "inline-flex h-8 items-center gap-1.5 rounded-full border border-s-line px-3 text-[12.5px] text-s-ink-2 transition hover:border-s-line-strong hover:text-s-ink disabled:opacity-50 [&_svg]:h-3.5 [&_svg]:w-3.5";
export const buttonClass = btn;

const STEP_STATUS: Record<Step["status"], { label: string; icon: ReactNode; tone: string }> = {
  planned: { label: "Planned", icon: <CircleDashed />, tone: "text-s-ink-3" },
  waiting_approval: { label: "Needs your approval", icon: <Hourglass />, tone: "text-amber-500" },
  running: { label: "Running", icon: <Loader2 className="animate-spin motion-reduce:animate-none" />, tone: "text-s-accent" },
  completed: { label: "Done", icon: <Check />, tone: "text-emerald-500" },
  failed: { label: "Failed", icon: <CircleX />, tone: "text-s-danger" },
  denied: { label: "Not allowed", icon: <CircleSlash />, tone: "text-s-danger" },
  rejected: { label: "You declined", icon: <CircleSlash />, tone: "text-s-ink-3" },
  cancelled: { label: "Stopped", icon: <Square />, tone: "text-s-ink-3" },
};

export const MISSION_STATUS: Record<Mission["status"], string> = {
  preparing: "Preparing",
  waiting_approval: "Waiting for approval",
  running: "Running",
  paused: "Paused",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Stopped",
};

function verifiedNote(r: StepResult): string {
  return r.verified === true ? "Checked" : r.verified === false ? "Check failed" : "Not checkable";
}

function Details({ r }: { r: StepResult }) {
  const d = r.details;
  if (!d) return null;
  if (d.kind === "link")
    return (
      <a href={d.href} target="_blank" rel="noopener" className="mt-1 inline-flex items-center gap-1 text-[12.5px] text-s-accent underline-offset-4 hover:underline">
        Open {d.label} <ExternalLink className="h-3 w-3" aria-hidden />
      </a>
    );
  if (d.kind === "files")
    return (
      <ul className="mt-1.5 max-h-40 space-y-0.5 overflow-y-auto text-[12px] text-s-ink-3">
        {d.items.slice(0, 50).map((i) => (
          <li key={(i.path ?? "") + i.name} className="truncate">
            {i.kind === "folder" ? "📁 " : ""}
            {i.path ?? i.name}
            {i.size !== undefined && <span className="text-s-ink-3/70"> · {fmtSize(i.size)}</span>}
          </li>
        ))}
        {d.items.length > 50 && <li>…and {d.items.length - 50} more</li>}
      </ul>
    );
  if (d.kind === "info")
    return (
      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px]">
        {d.rows.map((row) => (
          <div key={row.label} className="contents">
            <dt className="text-s-ink-3">{row.label}</dt>
            <dd className="text-s-ink-2">{row.value}</dd>
          </div>
        ))}
      </dl>
    );
  if (d.kind === "moves") return <p className="mt-1 text-[12px] text-s-ink-3">{d.moves.length} moves proposed.</p>;
  return null;
}

export function fmtSize(b: number): string {
  return b < 1024 ? `${b} B` : b < 1024 ** 2 ? `${(b / 1024).toFixed(0)} KB` : b < 1024 ** 3 ? `${(b / 1024 ** 2).toFixed(1)} MB` : `${(b / 1024 ** 3).toFixed(1)} GB`;
}

export function StepRow({ step, index }: { step: Step; index: number }) {
  const s = STEP_STATUS[step.status];
  const tool = TOOLS[step.tool];
  return (
    <li className="flex gap-2.5 py-2">
      <span className={cn("mt-0.5 shrink-0 [&_svg]:h-4 [&_svg]:w-4", s.tone)} aria-hidden>
        {s.icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] text-s-ink">
          <span className="text-s-ink-3">{index + 1}.</span> {tool.describe(step.args)}
        </p>
        <p className={cn("text-[12px]", s.tone)}>
          {s.label}
          {step.result && step.status !== "running" && <span className="text-s-ink-3"> · {verifiedNote(step.result)}</span>}
          {tool.runner === "desktop" && <span className="text-s-ink-3"> · on your computer</span>}
        </p>
        {step.status === "denied" && step.decision && <p className="mt-0.5 text-[12.5px] text-s-ink-2">{step.decision.reason}</p>}
        {step.result && (
          <>
            <p className="mt-0.5 text-[12.5px] text-s-ink-2">{step.result.summary}</p>
            <Details r={step.result} />
          </>
        )}
      </div>
    </li>
  );
}

export function ApprovalCard({ step, onDecide }: { step: Step; onDecide: (ok: boolean) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => ref.current?.focus(), [step.id]);
  const lines = step.preview?.lines ?? [TOOLS[step.tool].describe(step.args)];
  return (
    <div role="alertdialog" aria-labelledby={`approve-${step.id}`} aria-describedby={`approve-why-${step.id}`} className="mt-3 rounded-2xl border border-amber-500/50 bg-amber-500/5 p-3.5">
      <p id={`approve-${step.id}`} className="text-[14px] font-medium text-s-ink">
        {step.preview?.title ?? TOOLS[step.tool].title}: approve?
      </p>
      <p id={`approve-why-${step.id}`} className="mt-0.5 text-[12.5px] text-s-ink-3">
        {step.decision?.reason}
      </p>
      <ul className="mt-2 max-h-52 space-y-0.5 overflow-y-auto rounded-xl bg-s-hover/60 p-2.5 font-mono text-[12px] text-s-ink-2">
        {lines.slice(0, 200).map((l, i) => (
          <li key={i} className="break-all">
            {l}
          </li>
        ))}
        {lines.length > 200 && <li>…and {lines.length - 200} more</li>}
      </ul>
      {step.preview?.note && <p className="mt-2 text-[12.5px] text-s-ink-2">{step.preview.note}</p>}
      <div className="mt-3 flex gap-2">
        <button ref={ref} type="button" onClick={() => onDecide(true)} className="inline-flex h-9 items-center gap-1.5 rounded-full bg-s-ink px-4 text-[13px] font-medium text-s-bg">
          <Check className="h-4 w-4" aria-hidden /> Approve{lines.length > 1 ? ` all ${lines.length}` : ""}
        </button>
        <button type="button" onClick={() => onDecide(false)} className={cn(btn, "h-9 px-4 text-[13px]")}>
          Decline
        </button>
      </div>
    </div>
  );
}

export function MissionPanel({
  mission,
  onApprove,
  onPause,
  onResume,
  onCancel,
}: {
  mission: Mission | null;
  onApprove: (ok: boolean) => void;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
}) {
  const active = mission && !["completed", "failed", "cancelled", "interrupted"].includes(mission.status);
  const waiting = mission?.steps.find((s) => s.status === "waiting_approval");
  return (
    <Panel
      title="Mission control"
      id="jarvis-mission"
      actions={
        active && (
          <>
            {mission.status === "paused" ? (
              <button type="button" className={btn} onClick={onResume}>
                <Play /> Resume
              </button>
            ) : (
              <button type="button" className={btn} onClick={onPause}>
                <Pause /> Pause
              </button>
            )}
            <button type="button" className={btn} onClick={onCancel}>
              <Square /> Cancel
            </button>
          </>
        )
      }
    >
      {!mission ? (
        <p className="text-[13px] text-s-ink-3">Nothing running. When Jarvis acts, each step appears here with what it did, whether it was checked, and anything that needs your approval.</p>
      ) : (
        <div aria-live="polite">
          <p className="text-[14px] font-medium text-s-ink">{mission.title}</p>
          <p className="text-[12px] text-s-ink-3">
            {MISSION_STATUS[mission.status]} · {mission.steps.filter((s) => s.status === "completed").length} of {mission.steps.length} step{mission.steps.length === 1 ? "" : "s"} done
            {mission.startedAt && ` · started ${new Date(mission.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
          </p>
          <ol className="mt-1 divide-y divide-s-line">
            {mission.steps.map((s, i) => (
              <StepRow key={s.id} step={s} index={i} />
            ))}
          </ol>
          {waiting && <ApprovalCard step={waiting} onDecide={onApprove} />}
          {mission.summary && <p className="mt-2 rounded-xl bg-s-hover/60 p-2.5 text-[13px] text-s-ink-2">{mission.summary}</p>}
        </div>
      )}
    </Panel>
  );
}

const PLATFORM = { darwin: "macOS", win32: "Windows", linux: "Linux" } as const;

const subscribeNothing = () => () => {};
function useBrowserFeatures() {
  return useSyncExternalStore(
    subscribeNothing,
    () => {
      const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
      return `${!!(w.SpeechRecognition || w.webkitSpeechRecognition)}|${"speechSynthesis" in window}|${!!navigator.mediaDevices?.getDisplayMedia}|${!!navigator.clipboard?.readText}`;
    },
    () => "false|false|false|false",
  );
}

function useMicPermission(): string {
  const [state, setState] = useState("unknown");
  useEffect(() => {
    let status: PermissionStatus | null = null;
    const update = () => status && setState(status.state);
    navigator.permissions
      ?.query({ name: "microphone" as PermissionName })
      .then((s) => {
        status = s;
        update();
        s.addEventListener("change", update);
      })
      .catch(() => {});
    return () => status?.removeEventListener("change", update);
  }, []);
  return state;
}

export function DesktopPanel({ agent, onPair, onUnpair, onRefresh }: { agent: AgentState; onPair: (code: string) => Promise<string | null>; onUnpair: () => void; onRefresh: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [speechIn, speechOut, screen, clipboard] = useBrowserFeatures().split("|").map((v) => v === "true");
  const mic = useMicPermission();
  const row = (label: string, ok: boolean, text: string) => (
    <li className="flex items-center justify-between gap-3 py-1">
      <span className="text-s-ink-2">{label}</span>
      <span className={cn("text-right", ok ? "text-emerald-500" : "text-s-ink-3")}>{text}</span>
    </li>
  );
  return (
    <Panel
      title="Desktop Agent"
      id="jarvis-desktop"
      actions={
        <button type="button" className={btn} onClick={onRefresh}>
          Check again
        </button>
      }
    >
      {agent.status === "checking" && <p className="text-[13px] text-s-ink-3">Looking for the agent on this computer…</p>}
      {agent.status === "absent" && (
        <div className="space-y-2 text-[13px] text-s-ink-2">
          <p>
            <span className="font-medium text-s-ink">Not running.</span> The Orbis Desktop Agent lets Jarvis open apps and sort, find and move files on this computer, only in folders you allow. It
            never deletes or overwrites anything.
          </p>
          <ol className="list-decimal space-y-1 pl-5 text-s-ink-3">
            <li>
              <a href="/downloads/orbis-desktop-agent.mjs" download className="inline-flex items-center gap-1 text-s-accent underline-offset-4 hover:underline">
                <Download className="h-3.5 w-3.5" aria-hidden /> Download the agent
              </a>{" "}
              (needs Node.js 20 or newer).
            </li>
            <li>
              In a terminal, run <code className="rounded bg-s-hover px-1 font-mono text-[12px]">node orbis-desktop-agent.mjs</code>. Add <code className="rounded bg-s-hover px-1 font-mono text-[12px]">--allow ~/Projects</code> for more folders.
            </li>
            <li>Enter the 6-digit code it shows, here.</li>
          </ol>
          <p className="text-[12px] text-s-ink-3">Your browser may ask whether this site may connect to apps on this device: allow it.</p>
        </div>
      )}
      {agent.status === "unpaired" && (
        <form
          className="space-y-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(await onPair(code));
            setBusy(false);
          }}
        >
          <p className="text-[13px] text-s-ink-2">
            The agent is running{agent.platform ? ` on ${PLATFORM[agent.platform]}` : ""}. Enter the code it shows to connect this browser.
          </p>
          <div className="flex gap-2">
            <label htmlFor="jarvis-pair" className="sr-only">
              Pairing code
            </label>
            <input
              id="jarvis-pair"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              className="h-9 w-32 rounded-xl border border-s-line bg-transparent px-3 font-mono text-[14px] tracking-[0.2em] text-s-ink focus:border-s-line-strong focus:outline-none"
            />
            <button type="submit" disabled={code.length !== 6 || busy} className={cn(btn, "h-9")}>
              Connect
            </button>
          </div>
          {error && (
            <p role="alert" className="text-[12.5px] text-s-danger">
              {error}
            </p>
          )}
        </form>
      )}
      {agent.status === "connected" && (
        <div className="space-y-2 text-[13px]">
          <p className="text-s-ink-2">
            <span className="font-medium text-emerald-500">Connected</span> · {PLATFORM[agent.info.platform]} · agent {agent.info.version}
            {agent.info.halted && <span className="text-s-danger"> · stopped</span>}
          </p>
          <div>
            <p className="text-[12px] text-s-ink-3">Folders Jarvis may use</p>
            <ul className="mt-0.5 font-mono text-[12px] text-s-ink-2">
              {agent.info.folders.length ? agent.info.folders.map((f) => <li key={f}>{f}</li>) : <li>None (start the agent with --allow)</li>}
            </ul>
          </div>
          <button type="button" className={btn} onClick={onUnpair}>
            Disconnect
          </button>
        </div>
      )}
      <ul className="mt-3 border-t border-s-line pt-2 text-[12.5px]">
        {row("Microphone", mic === "granted", mic === "granted" ? "Allowed" : mic === "denied" ? "Blocked in browser settings" : "Asked when you first talk")}
        {row("Voice input", speechIn, speechIn ? "Available (browser speech service)" : "Not in this browser: type instead")}
        {row("Voice replies", speechOut, speechOut ? "Available (on this device)" : "Not available")}
        {row("Screen sharing", screen, screen ? "On request, one picture at a time" : "Not available")}
        {row("Clipboard", clipboard, clipboard ? "On request only" : "Not available")}
        {row("Global shortcut", false, "Needs the desktop app (planned): works while this page is focused")}
      </ul>
    </Panel>
  );
}

function ShortcutRecorder({ value, onChange, mac }: { value: Shortcut; onChange: (s: Shortcut) => void; mac: boolean }) {
  const [recording, setRecording] = useState(false);
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return setRecording(false);
      if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;
      const key = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : /^Digit\d$/.test(e.code) ? e.code.slice(5) : e.code === "Space" ? " " : e.key.length === 1 ? e.key.toLowerCase() : e.key;
      onChange({ key, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey });
      setRecording(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, onChange]);
  const conflict = shortcutConflict(value);
  return (
    <div>
      <div className="flex items-center gap-2">
        <kbd className="rounded-lg border border-s-line px-2 py-1 font-mono text-[12.5px] text-s-ink">{recording ? "Press keys…" : shortcutLabel(value, mac)}</kbd>
        <button type="button" className={btn} onClick={() => setRecording((r) => !r)} aria-pressed={recording}>
          {recording ? "Cancel" : "Change"}
        </button>
        <button type="button" className={btn} onClick={() => onChange(DEFAULT_SHORTCUT)}>
          <Undo2 /> Default
        </button>
      </div>
      {conflict && (
        <p className="mt-1 flex items-center gap-1 text-[12px] text-amber-500">
          <CircleAlert className="h-3.5 w-3.5" aria-hidden /> {conflict}
        </p>
      )}
    </div>
  );
}

export function SettingsPanel({ settings, onChange, mac }: { settings: JarvisSettings; onChange: (s: JarvisSettings) => void; mac: boolean }) {
  const set = <K extends keyof JarvisSettings>(k: K, v: JarvisSettings[K]) => onChange({ ...settings, [k]: v });
  const select = "h-9 w-full rounded-xl border border-s-line bg-transparent px-2.5 text-[13px] text-s-ink focus:border-s-line-strong focus:outline-none";
  return (
    <Panel title="Settings" id="jarvis-settings">
      <fieldset>
        <legend className="text-[13px] font-medium text-s-ink">Autonomy</legend>
        <div className="mt-1.5 space-y-1.5">
          {AUTONOMY_LEVELS.map((l) => (
            <label key={l.level} className={cn("flex cursor-pointer gap-2.5 rounded-xl border p-2.5", settings.autonomy === l.level ? "border-s-line-strong bg-s-hover/60" : "border-s-line")}>
              <input type="radio" name="jarvis-autonomy" checked={settings.autonomy === l.level} onChange={() => set("autonomy", l.level as Autonomy)} className="mt-0.5" />
              <span>
                <span className="block text-[13px] text-s-ink">
                  {l.level}. {l.name}
                </span>
                <span className="block text-[12px] text-s-ink-3">{l.text}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="mt-1.5 text-[12px] text-s-ink-3">At every level: nothing is deleted, overwritten, sent or bought, and the emergency stop halts everything.</p>
      </fieldset>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
        <label className="block text-[13px] text-s-ink">
          Mode
          <select value={settings.mode} onChange={(e) => set("mode", e.target.value as JarvisMode)} className={cn(select, "mt-1")}>
            {JARVIS_MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <span className="mt-0.5 block text-[12px] text-s-ink-3">{JARVIS_MODES.find((m) => m.id === settings.mode)!.text}</span>
        </label>
        <label className="block text-[13px] text-s-ink">
          Voice
          <select value={settings.voice} onChange={(e) => set("voice", e.target.value as JarvisSettings["voice"])} className={cn(select, "mt-1")}>
            {VOICE_PROFILES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <span className="mt-0.5 block text-[12px] text-s-ink-3">Uses the voices on this device.</span>
        </label>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-[13px] text-s-ink">Speak replies</span>
        <Switch checked={settings.speak} onChange={(v) => set("speak", v)} label="Speak replies" />
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-[13px] text-s-ink">
          Core reacts to the pointer
          <span className="block text-[12px] text-s-ink-3">Particles near the pointer move aside a little.</span>
        </span>
        <Switch checked={settings.corePointer} onChange={(v) => set("corePointer", v)} label="Core reacts to the pointer" />
      </div>
      <div className="mt-3">
        <p className="text-[13px] text-s-ink">Push to talk</p>
        <p className="mb-1.5 text-[12px] text-s-ink-3">Hold the keys while this page is open, speak, then let go. Esc cancels.</p>
        <ShortcutRecorder value={settings.shortcut} onChange={(s) => set("shortcut", s)} mac={mac} />
      </div>
      <label className="mt-3 block text-[13px] text-s-ink">
        Keep mission history
        <select value={settings.keepDays} onChange={(e) => set("keepDays", Number(e.target.value))} className={cn(select, "mt-1")}>
          <option value={0}>Don&apos;t keep</option>
          <option value={1}>1 day</option>
          <option value={7}>7 days</option>
          <option value={30}>30 days</option>
          <option value={90}>90 days</option>
        </select>
        <span className="mt-0.5 block text-[12px] text-s-ink-3">Kept in this browser only: requests, steps and results, never file contents, clipboard text or screenshots.</span>
      </label>
    </Panel>
  );
}

export function HistoryPanel({ history, onClear }: { history: Mission[]; onClear: () => void }) {
  return (
    <Panel
      title="Activity"
      id="jarvis-history"
      actions={
        history.length > 0 && (
          <button type="button" className={btn} onClick={onClear}>
            <Trash2 /> Clear
          </button>
        )
      }
    >
      {!history.length ? (
        <p className="text-[13px] text-s-ink-3">Missions you run appear here, with every step and its result.</p>
      ) : (
        <ul className="space-y-1.5">
          {history.map((m) => (
            <li key={m.id}>
              <details className="group rounded-xl border border-s-line px-3 py-2">
                <summary className="flex cursor-pointer list-none items-center gap-2 text-[13px]">
                  <span className="min-w-0 flex-1 truncate text-s-ink">{m.title}</span>
                  <span className={cn("shrink-0 text-[12px]", m.status === "completed" ? "text-emerald-500" : m.status === "failed" ? "text-s-danger" : "text-s-ink-3")}>{MISSION_STATUS[m.status]}</span>
                </summary>
                <p className="mt-1 text-[12px] text-s-ink-3">{new Date(m.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</p>
                <ol className="divide-y divide-s-line">
                  {m.steps.map((s, i) => (
                    <StepRow key={s.id} step={s} index={i} />
                  ))}
                </ol>
                {m.summary && <p className="mt-1 text-[12.5px] text-s-ink-2">{m.summary}</p>}
              </details>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

const RUNNER_LABEL: Record<ToolRunner, { title: string; note: string }> = {
  server: { title: "Looked up by Orbis", note: "Run during the reply; Jarvis sees the result and carries on." },
  browser: { title: "In this browser", note: "Run after the reply, under your autonomy setting." },
  desktop: { title: "On your computer", note: "Through the Desktop Agent, only in folders you allow." },
};
const RISK_LABEL: Record<RiskClass, string> = {
  read: "looks only",
  private: "reads private content",
  act: "opens something",
  write: "changes files, undoable",
  spend: "uses your allowance",
};

function SkillEditor({ initial, taken, onSave, onDelete, onClose }: { initial: SkillInput | null; taken: string[]; onSave: (s: SkillInput) => void; onDelete?: () => void; onClose: () => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [instructions, setInstructions] = useState(initial?.instructions ?? "");
  const [error, setError] = useState<string | null>(null);
  const field = "mt-1 w-full rounded-xl border border-s-line bg-transparent px-2.5 py-2 text-[13px] text-s-ink placeholder:text-s-ink-3 focus:border-s-line-strong focus:outline-none";
  return (
    <form
      className="mt-3 space-y-2.5 rounded-xl border border-s-line-strong p-3"
      aria-label={initial ? `Edit ${initial.name}` : "New skill"}
      onSubmit={(e) => {
        e.preventDefault();
        const p = skillInput.safeParse({ id: initial?.id ?? skillId(name, taken), name, description, instructions });
        if (!p.success) return setError(p.error.issues[0]?.message ?? "Check the fields.");
        onSave(p.data);
      }}
    >
      <label className="block text-[13px] text-s-ink">
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Weekly report" className={field} autoFocus />
      </label>
      <label className="block text-[13px] text-s-ink">
        When to use it
        <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} placeholder="When I ask for my weekly report." className={field} />
      </label>
      <label className="block text-[13px] text-s-ink">
        Steps for Jarvis
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          maxLength={2000}
          rows={5}
          placeholder={"1. Search the web for this week's news about my industry.\n2. Pick the three most important items.\n3. Summarise each in one sentence, with the source."}
          className={cn(field, "resize-y")}
        />
        <span className="mt-0.5 block text-[12px] text-s-ink-3">A skill only shapes how Jarvis uses its tools: it can&apos;t add tools or skip your approvals.</span>
      </label>
      {error && (
        <p role="alert" className="text-[12.5px] text-s-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="submit" className={cn(btn, "border-transparent bg-s-ink text-s-bg hover:text-s-bg hover:opacity-90")}>
          Save skill
        </button>
        <button type="button" className={btn} onClick={onClose}>
          Cancel
        </button>
        {onDelete && (
          <button type="button" className={cn(btn, "ml-auto text-s-danger hover:text-s-danger")} onClick={onDelete}>
            <Trash2 /> Delete
          </button>
        )}
      </div>
    </form>
  );
}

/** Skills Jarvis can follow (built in and the user's own) and the tools it can call, grouped by where they run. */
export function SkillsPanel({
  skills,
  connected,
  picked,
  onPick,
  onChange,
}: {
  skills: SkillInput[];
  connected: boolean;
  picked: string | null;
  onPick: (id: string | null) => void;
  onChange: (skills: SkillInput[]) => void;
}) {
  const [editing, setEditing] = useState<SkillInput | "new" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const row = (s: { id: string; name: string; description: string; desktop?: boolean }, mine: boolean) => {
    const off = !!s.desktop && !connected;
    return (
      <li key={s.id} className="flex items-start gap-2 py-2">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] text-s-ink">
            {s.name}
            {mine && <span className="ml-1.5 text-[11.5px] text-s-ink-3">yours</span>}
          </p>
          <p className="text-[12px] text-s-ink-3">
            {off ? "Needs the Desktop Agent. " : ""}
            {s.description}
          </p>
        </div>
        {mine && (
          <button
            type="button"
            aria-label={`Edit ${s.name}`}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-s-ink-3 hover:bg-s-hover hover:text-s-ink"
            onClick={() => {
              setConfirmDelete(false);
              setEditing(skills.find((x) => x.id === s.id) ?? null);
            }}
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden />
          </button>
        )}
        <button
          type="button"
          disabled={off}
          aria-pressed={picked === s.id}
          title={off ? "Connect the Desktop Agent first" : `Use “${s.name}” for your next request`}
          className={cn(btn, "shrink-0", picked === s.id && "border-transparent bg-s-ink text-s-bg hover:text-s-bg")}
          onClick={() => onPick(picked === s.id ? null : s.id)}
        >
          {picked === s.id ? "Chosen" : "Use"}
        </button>
      </li>
    );
  };
  const editingSkill = editing && editing !== "new" ? editing : null;
  return (
    <Panel
      title="Skills & tools"
      id="jarvis-skills"
      actions={
        <button
          type="button"
          className={btn}
          disabled={skills.length >= MAX_USER_SKILLS}
          title={skills.length >= MAX_USER_SKILLS ? `Up to ${MAX_USER_SKILLS} skills of your own` : undefined}
          onClick={() => {
            setConfirmDelete(false);
            setEditing("new");
          }}
        >
          <Plus /> New skill
        </button>
      }
    >
      <p className="text-[12.5px] text-s-ink-3">Jarvis picks a skill by itself when your request matches one. Choose one to use it for your next request.</p>
      {editing && (
        <SkillEditor
          key={editingSkill?.id ?? "new"}
          initial={editingSkill}
          taken={skills.map((s) => s.id)}
          onClose={() => {
            setEditing(null);
            setConfirmDelete(false);
          }}
          onSave={(s) => {
            onChange(editingSkill ? skills.map((x) => (x.id === s.id ? s : x)) : [...skills, s]);
            setEditing(null);
          }}
          onDelete={
            editingSkill
              ? () => {
                  if (!confirmDelete) return setConfirmDelete(true);
                  onChange(skills.filter((x) => x.id !== editingSkill.id));
                  if (picked === editingSkill.id) onPick(null);
                  setEditing(null);
                  setConfirmDelete(false);
                }
              : undefined
          }
        />
      )}
      {confirmDelete && editingSkill && (
        <p role="alert" className="mt-1.5 text-[12px] text-s-danger">
          Press Delete again to remove “{editingSkill.name}”.
        </p>
      )}
      {skills.length > 0 && (
        <>
          <h3 className="mt-3 text-[12px] font-medium text-s-ink-2">Your skills</h3>
          <ul className="divide-y divide-s-line">{skills.map((s) => row(s, true))}</ul>
        </>
      )}
      <h3 className="mt-3 text-[12px] font-medium text-s-ink-2">Built in</h3>
      <ul className="divide-y divide-s-line">{BUILTIN_SKILLS.map((s) => row(s, false))}</ul>
      <p className="mt-1 text-[12px] text-s-ink-3">Your skills are kept in this browser and sent with each request.</p>

      <details className="mt-3 rounded-xl border border-s-line px-3 py-2">
        <summary className="cursor-pointer text-[13px] text-s-ink">Tools Jarvis can use ({TOOL_NAMES.length})</summary>
        {(["server", "browser", "desktop"] as const).map((runner) => (
          <div key={runner} className="mt-2.5">
            <p className="text-[12.5px] font-medium text-s-ink-2">
              {RUNNER_LABEL[runner].title}
              {runner === "desktop" && !connected && <span className="font-normal text-s-ink-3"> · not connected</span>}
            </p>
            <p className="text-[12px] text-s-ink-3">{RUNNER_LABEL[runner].note}</p>
            <ul className="mt-1 space-y-0.5 text-[12.5px]">
              {TOOL_NAMES.filter((n) => TOOLS[n].runner === runner).map((n) => (
                <li key={n} className="flex justify-between gap-3">
                  <span className="text-s-ink">{TOOLS[n].title}</span>
                  <span className="shrink-0 text-s-ink-3">{RISK_LABEL[TOOLS[n].risk]}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </details>
    </Panel>
  );
}
