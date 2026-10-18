import { hash } from "./text";
import type { ClaimReport, ReplayEvent, ReplayLog, ReplayStep } from "./types";
import { CLAIM_DNA_VERSION } from "./types";

/** Records every pipeline step with input/output hashes so a run can be reproduced and diffed. */
export class ReplayRecorder {
  private events: ReplayEvent[] = [];
  constructor(private config: ReplayLog["config"]) {}

  step<T>(
    step: ReplayStep,
    actor: ReplayEvent["actor"],
    description: string,
    input: unknown,
    run: () => T,
    snapshot: (out: T) => unknown = (o) => o,
    deterministic = true,
    model?: ReplayEvent["model"],
    recordedDurationMs?: number,
  ): T {
    const started = typeof performance !== "undefined" ? performance.now() : Date.now();
    const out = run();
    const ended = typeof performance !== "undefined" ? performance.now() : Date.now();
    const snap = snapshot(out);
    this.events.push({
      seq: this.events.length + 1,
      step,
      actor,
      description,
      inputHash: hash(input),
      outputHash: hash(snap),
      output: snap,
      deterministic,
      durationMs: recordedDurationMs ?? Math.round((ended - started) * 100) / 100,
      model,
    });
    return out;
  }

  log(): ReplayLog {
    return { pipelineVersion: CLAIM_DNA_VERSION, config: this.config, events: this.events };
  }
}

export interface StepDiff {
  seq: number;
  step: ReplayStep;
  description: string;
  inputMatches: boolean;
  outputMatches: boolean;
  deterministic: boolean;
  before: unknown;
  after: unknown;
}

export interface ReplayComparison {
  reproducible: boolean;
  pipelineVersionChanged: boolean;
  steps: StepDiff[];
  firstDivergence: StepDiff | null;
  notes: string[];
}

/** Compare a stored run against a re-run, step by step. */
export function compareReplays(original: ClaimReport, rerun: ClaimReport): ReplayComparison {
  const steps: StepDiff[] = original.replay.events.map((e) => {
    const r = rerun.replay.events.find((x) => x.step === e.step);
    return {
      seq: e.seq,
      step: e.step,
      description: e.description,
      inputMatches: r?.inputHash === e.inputHash,
      outputMatches: r?.outputHash === e.outputHash,
      deterministic: e.deterministic,
      before: e.output,
      after: r?.output ?? null,
    };
  });
  for (const r of rerun.replay.events) {
    if (!original.replay.events.some((e) => e.step === r.step)) {
      steps.push({ seq: r.seq, step: r.step, description: `${r.description} (new in re-run)`, inputMatches: false, outputMatches: false, deterministic: r.deterministic, before: null, after: r.output });
    }
  }
  const firstDivergence = steps.find((s) => !s.outputMatches) ?? null;
  const notes: string[] = [];
  const versionChanged = original.replay.pipelineVersion !== rerun.replay.pipelineVersion;
  if (versionChanged) notes.push(`Pipeline version changed (${original.replay.pipelineVersion} → ${rerun.replay.pipelineVersion}); differences may come from code changes.`);
  if (original.mode === "model")
    notes.push("Model judgements were replayed from the recorded outputs (frozen replay). Calling the model again could produce different judgements.");
  if (firstDivergence && !firstDivergence.inputMatches) notes.push(`Inputs changed at step “${firstDivergence.step}”.`);
  return { reproducible: !firstDivergence, pipelineVersionChanged: versionChanged, steps, firstDivergence, notes };
}
