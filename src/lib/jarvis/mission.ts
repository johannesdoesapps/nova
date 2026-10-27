import type { Decision } from "./permissions";
import { TOOLS, type JarvisToolName } from "./tools";

/**
 * A Jarvis mission: the user's request, the steps Jarvis proposed, and what actually happened to each. The runner
 * goes through the steps one at a time (desktop actions never run in parallel), asks the permission rules before
 * each, waits for approval when needed, and records an honest result: a step only counts as completed when its
 * tool reported success, and as verified only when the tool checked the outcome.
 */

export type MissionStatus = "preparing" | "waiting_approval" | "running" | "paused" | "completed" | "failed" | "cancelled" | "interrupted";
export type StepStatus = "planned" | "waiting_approval" | "running" | "completed" | "failed" | "denied" | "rejected" | "cancelled";
export type Outcome = "success" | "partial" | "failure" | "permission_denied" | "unsupported" | "timeout" | "cancelled";

export type StepDetails =
  | { kind: "files"; folder?: string; items: { name: string; kind: "file" | "folder" | "other"; size?: number; path?: string }[]; truncated?: boolean }
  | { kind: "moves"; moves: { from: string; to: string }[]; skipped?: { name: string; reason: string }[] }
  | { kind: "text"; text: string }
  | { kind: "link"; href: string; label: string }
  | { kind: "info"; rows: { label: string; value: string }[] };

export interface StepResult {
  outcome: Outcome;
  /** One plain sentence about what happened, built from the tool's real result. */
  summary: string;
  /** true: the tool checked the result; false: the check failed; null: no way to check. */
  verified: boolean | null;
  details?: StepDetails;
  /** A read that failed in a way worth one more try (e.g. a dropped connection). */
  retryable?: boolean;
}

export interface ApprovalPreview {
  title: string;
  lines: string[];
  note?: string;
}

export interface Step {
  id: string;
  tool: JarvisToolName;
  args: Record<string, unknown>;
  status: StepStatus;
  decision?: Decision;
  preview?: ApprovalPreview;
  result?: StepResult;
  startedAt?: string;
  endedAt?: string;
}

export interface Mission {
  id: string;
  request: string;
  title: string;
  status: MissionStatus;
  steps: Step[];
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  /** The final report, built from the step results. */
  summary?: string;
}

const now = () => new Date().toISOString();
const uid = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2));

export function newMission(request: string, title: string, calls: { tool: JarvisToolName; args: Record<string, unknown> }[]): Mission {
  return {
    id: uid(),
    request: request.slice(0, 2000),
    title: title.trim().slice(0, 120) || request.slice(0, 80),
    status: "preparing",
    steps: calls.map((c) => ({ id: uid(), tool: c.tool, args: c.args, status: "planned" })),
    createdAt: now(),
  };
}

export const FINISHED: ReadonlySet<MissionStatus> = new Set(["completed", "failed", "cancelled", "interrupted"]);

/** The report for a finished mission: what was done, from the results, and where it stopped. */
export function missionSummary(m: Mission): string {
  const done = m.steps.filter((s) => s.status === "completed");
  const said = done.map((s) => s.result?.summary).filter(Boolean) as string[];
  const stopped = m.steps.find((s) => ["failed", "denied", "rejected", "cancelled"].includes(s.status));
  const n = m.steps.length;
  if (m.status === "completed") return said.length ? `Done. ${said.join(" ")}` : "Done.";
  const head =
    m.status === "interrupted"
      ? "Stopped by the emergency stop."
      : m.status === "cancelled"
        ? stopped?.status === "rejected"
          ? "Cancelled: you didn't approve a step."
          : "Cancelled."
        : stopped?.status === "denied"
          ? "Blocked by your permission settings."
          : "That didn't fully work.";
  const where = stopped ? ` It stopped at step ${m.steps.indexOf(stopped) + 1} of ${n} (${TOOLS[stopped.tool].title.toLowerCase()})${stopped.result?.summary ? `: ${stopped.result.summary}` : stopped.decision?.kind === "deny" ? `: ${stopped.decision.reason}` : "."}` : "";
  const before = said.length ? ` Completed before that: ${said.join(" ")}` : " Nothing was changed before that.";
  return `${head}${where}${before}`;
}

/**
 * The report said in the conversation (and aloud): the outcome in a sentence or two. The full step-by-step report
 * stays in Mission control.
 */
export function briefSummary(m: Mission): string {
  const done = m.steps.filter((s) => s.status === "completed");
  const last = done.at(-1)?.result?.summary;
  if (m.status === "completed") return done.length > 1 ? `Done: ${done.length} steps.${last ? ` ${last}` : ""}` : last ? `Done. ${last}` : "Done.";
  if (m.status === "interrupted") return "Stopped by the emergency stop.";
  const stopped = m.steps.find((s) => ["failed", "denied", "rejected", "cancelled"].includes(s.status));
  if (m.status === "cancelled") return stopped?.status === "rejected" ? "Cancelled: you didn't approve a step." : "Stopped.";
  const why = stopped?.result?.summary ?? (stopped?.decision?.kind === "deny" ? stopped.decision.reason : null);
  const head = stopped?.status === "denied" ? "Blocked by your permission settings." : "That didn't fully work.";
  return `${head}${why ? ` ${why}` : ""}${done.length ? ` ${done.length} step${done.length === 1 ? " was" : "s were"} done first.` : ""}`;
}

/** Kinds of result that tell Jarvis something it can use (what was found or read), not just that a step ran. */
const INFORMATIVE: ReadonlySet<StepDetails["kind"]> = new Set(["files", "info", "text"]);

/** Whether to give Jarvis the mission's results so it can answer from them or take the next step. */
export function wantsFollowUp(m: Mission): boolean {
  return (m.status === "completed" || m.status === "failed") && m.steps.some((s) => s.status === "completed" && !!s.result?.details && INFORMATIVE.has(s.result.details.kind));
}

const NOT_RUN: Record<StepStatus, string> = {
  planned: "Not run.",
  waiting_approval: "Not run.",
  running: "Didn't finish.",
  completed: "Done.",
  failed: "Failed.",
  denied: "Not allowed by the user's settings.",
  rejected: "The user declined this step.",
  cancelled: "Stopped before it ran.",
};

/** A step's result as Jarvis reads it in the next round: the summary, then what it found, clipped. */
export function stepFeedback(step: Step, max = 3500): { ok: boolean; text: string } {
  const r = step.result;
  const ok = step.status === "completed" && (r?.outcome === "success" || r?.outcome === "partial");
  if (!r) return { ok: false, text: step.status === "denied" && step.decision ? `Not allowed: ${step.decision.reason}` : NOT_RUN[step.status] };
  const d = r.details;
  const extra =
    d?.kind === "files"
      ? [d.folder && `Folder: ${d.folder}`, ...d.items.map((i) => `${i.kind === "folder" ? "[folder] " : ""}${i.path ?? i.name}${i.size !== undefined ? ` (${i.size} bytes)` : ""}`), d.truncated && "(list truncated)"]
      : d?.kind === "info"
        ? d.rows.map((x) => `${x.label}: ${x.value}`)
        : d?.kind === "text"
          ? [d.text]
          : d?.kind === "moves"
            ? [`${d.moves.length} moved${d.skipped?.length ? `, ${d.skipped.length} skipped` : ""}.`]
            : d?.kind === "link"
              ? [`${d.label}: ${d.href}`]
              : [];
  const text = [r.summary, ...extra.filter(Boolean)].join("\n");
  return { ok, text: text.length > max ? `${text.slice(0, max)}…` : text };
}

export interface Prepared {
  preview: ApprovalPreview;
  /** How many changes the step would make (batch tools). */
  batchSize?: number;
  data?: unknown;
}

export interface RunnerDeps {
  decide(step: Step, batchSize?: number): Decision;
  /** Work out exactly what a batch step would do, for approval (e.g. the list of moves). A result ends the step. */
  prepare?(step: Step, signal: AbortSignal): Promise<Prepared | StepResult | null>;
  execute(step: Step, signal: AbortSignal, prepared?: unknown): Promise<StepResult>;
  /** Ask the user; resolves true to go ahead. */
  approve(step: Step): Promise<boolean>;
  update(m: Mission): void;
  timeoutMs?: number;
}

const isResult = (v: unknown): v is StepResult => !!v && typeof v === "object" && "outcome" in v;

class Stopped extends Error {
  constructor(readonly how: "cancelled" | "interrupted") {
    super(how);
  }
}

export class MissionRunner {
  private m: Mission;
  private abort = new AbortController();
  private stopHow: "cancelled" | "interrupted" | null = null;
  private paused = false;
  private wake: (() => void) | null = null;

  constructor(
    mission: Mission,
    private deps: RunnerDeps,
  ) {
    this.m = structuredClone(mission);
  }

  get mission(): Mission {
    return this.m;
  }

  private set(patch: Partial<Mission>) {
    this.m = { ...this.m, ...patch };
    this.deps.update(this.m);
  }

  private setStep(id: string, patch: Partial<Step>) {
    this.set({ steps: this.m.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
  }

  pause() {
    if (FINISHED.has(this.m.status)) return;
    this.paused = true;
    if (this.m.status === "running") this.set({ status: "paused" });
  }

  resume() {
    this.paused = false;
    if (this.m.status === "paused") this.set({ status: "running" });
    this.wake?.();
  }

  /** Stop: no further steps start; the running one is told to stop (it may already have finished). */
  stop(how: "cancelled" | "interrupted" = "cancelled") {
    if (FINISHED.has(this.m.status) || this.stopHow) return;
    this.stopHow = how;
    this.abort.abort();
    this.wake?.();
  }

  private check() {
    if (this.stopHow) throw new Stopped(this.stopHow);
  }

  private async gate() {
    while (this.paused && !this.stopHow) await new Promise<void>((r) => (this.wake = r));
    this.wake = null;
    this.check();
  }

  private race<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new Stopped(this.stopHow ?? "cancelled"));
      if (this.abort.signal.aborted) return onAbort();
      this.abort.signal.addEventListener("abort", onAbort, { once: true });
      p.then(resolve, reject).finally(() => this.abort.signal.removeEventListener("abort", onAbort));
    });
  }

  private async withTimeout(step: Step, run: (signal: AbortSignal) => Promise<StepResult>): Promise<StepResult> {
    const ms = this.deps.timeoutMs ?? 60_000;
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    this.abort.signal.addEventListener("abort", onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<StepResult>((resolve) => {
      timer = setTimeout(() => {
        ctl.abort();
        const changes = TOOLS[step.tool].risk === "write";
        resolve({
          outcome: "timeout",
          summary: changes ? "It timed out, so it may or may not have finished. Check before trying again." : "It timed out.",
          verified: null,
        });
      }, ms);
    });
    try {
      return await Promise.race([run(ctl.signal), timeout]);
    } finally {
      clearTimeout(timer);
      this.abort.signal.removeEventListener("abort", onAbort);
    }
  }

  async run(): Promise<Mission> {
    this.set({ status: "running", startedAt: now() });
    try {
      for (const planned of this.m.steps) {
        await this.gate();
        const step = this.m.steps.find((s) => s.id === planned.id)!;
        const tool = TOOLS[step.tool];

        // A batch step first works out exactly what it would change, so that list is what gets approved.
        let prepared: unknown;
        let batchSize: number | undefined;
        let preview: ApprovalPreview = { title: tool.title, lines: [tool.describe(step.args)] };
        const first = this.deps.decide(step);
        if (first.kind === "deny") {
          this.setStep(step.id, { status: "denied", decision: first, endedAt: now() });
          this.set({ status: "failed" });
          break;
        }
        if (tool.batch && this.deps.prepare) {
          this.setStep(step.id, { status: "running", startedAt: now() });
          const p = await this.race(this.deps.prepare(step, this.abort.signal));
          if (isResult(p)) {
            const ok = p.outcome === "success";
            this.setStep(step.id, { status: ok ? "completed" : "failed", result: p, endedAt: now() });
            if (!ok) {
              this.set({ status: "failed" });
              break;
            }
            continue;
          }
          if (p) ({ preview, batchSize, data: prepared } = { preview: p.preview, batchSize: p.batchSize, data: p.data });
        }

        const decision = this.deps.decide(step, batchSize);
        this.setStep(step.id, { decision, preview });
        if (decision.kind === "deny") {
          this.setStep(step.id, { status: "denied", endedAt: now() });
          this.set({ status: "failed" });
          break;
        }
        if (decision.kind === "confirm") {
          this.setStep(step.id, { status: "waiting_approval" });
          this.set({ status: "waiting_approval" });
          const ok = await this.race(this.deps.approve(this.m.steps.find((s) => s.id === step.id)!));
          if (!ok) {
            this.setStep(step.id, { status: "rejected", endedAt: now() });
            this.set({ status: "cancelled" });
            break;
          }
          this.set({ status: this.paused ? "paused" : "running" });
          await this.gate();
        }

        this.setStep(step.id, { status: "running", startedAt: this.m.steps.find((s) => s.id === step.id)!.startedAt ?? now() });
        let result = await this.withTimeout(step, (signal) => this.deps.execute(step, signal, prepared));
        // One more try only for a read that failed in a retryable way; never for anything that changes things.
        if (result.outcome === "failure" && result.retryable && tool.risk === "read" && !this.stopHow) result = await this.withTimeout(step, (signal) => this.deps.execute(step, signal, prepared));
        this.check();
        const ok = result.outcome === "success" || result.outcome === "partial";
        this.setStep(step.id, { status: ok ? "completed" : "failed", result, endedAt: now() });
        if (!ok) {
          this.set({ status: "failed" });
          break;
        }
      }
      if (!FINISHED.has(this.m.status)) this.set({ status: "completed" });
    } catch (err) {
      if (!(err instanceof Stopped)) throw err;
      this.set({
        status: err.how,
        steps: this.m.steps.map((s) =>
          s.status === "running"
            ? { ...s, status: "cancelled", endedAt: now(), result: s.result ?? { outcome: "cancelled", summary: "Stopped while running; it may already have taken effect.", verified: null } }
            : s.status === "waiting_approval"
              ? { ...s, status: "cancelled", endedAt: now() }
              : s,
        ),
      });
    }
    this.set({ endedAt: now(), summary: missionSummary(this.m) });
    return this.m;
  }
}
