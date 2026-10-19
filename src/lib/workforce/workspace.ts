import type { CheckDef } from "./types";

/**
 * A task's isolated workspace. The production backend is a Vercel Sandbox
 * (a disposable microVM); tests use an in-memory fake. Only the operations
 * below exist — there is deliberately no "run arbitrary command".
 */
export interface Workspace {
  readonly name: string;
  /** Create the sandbox, clone, install. Idempotent; call until ready. */
  prepare(opts: { repo: string; branch: string; restoreDiff?: string | null }): Promise<{ ready: true; baseSha: string } | { ready: false; detail: string }>;
  /** False when the workspace is gone or was reset (e.g. the sandbox timed out). */
  healthy(): Promise<boolean>;
  listFiles(): Promise<string[]>;
  grep(terms: string[], maxBytes?: number): Promise<string>;
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  /** Diff of all changes against the base commit (new files included). */
  diff(baseSha: string): Promise<{ diff: string; files: string[] }>;
  /** Commit current changes as a checkpoint; returns the commit sha, or null when nothing changed. */
  checkpoint(message: string): Promise<string | null>;
  resetTo(sha: string): Promise<void>;
  startCheck(check: CheckDef): Promise<string>;
  pollCheck(handle: string): Promise<{ done: false } | { done: true; exitCode: number; output: string }>;
  killCheck(handle: string): Promise<void>;
  stop(): Promise<{ activeMs: number | null }>;
}

export interface WorkspaceFactory {
  (name: string): Workspace;
  available(): { ok: true } | { ok: false; reason: string };
}

/* ------------------------------------------------------------------ Fake */

/** Deterministic in-memory workspace for tests. Checks are scripted. */
export class FakeWorkspace implements Workspace {
  files = new Map<string, string>();
  base = new Map<string, string>();
  checkpoints: { sha: string; files: Map<string, string> }[] = [];
  prepared = false;
  prepareCalls = 0;
  restored: string | null = null;
  readyAfter = 1;
  stopped = false;
  killed: string[] = [];
  /** check id → sequence of results; the last one repeats. */
  script: Record<string, { exitCode: number; output: string; pending?: number }[]> = {};
  private runs = new Map<string, { check: string; result: { exitCode: number; output: string; pending?: number }; polls: number }>();
  private counters: Record<string, number> = {};
  /** Optional hook so tests can make check results depend on file contents. */
  evaluate?: (checkId: string, files: Map<string, string>) => { exitCode: number; output: string } | null;

  constructor(
    public readonly name: string,
    initial: Record<string, string> = {},
  ) {
    for (const [k, v] of Object.entries(initial)) {
      this.files.set(k, v);
      this.base.set(k, v);
    }
  }
  async prepare(opts: { restoreDiff?: string | null }) {
    this.prepareCalls++;
    if (this.prepareCalls < this.readyAfter) return { ready: false as const, detail: "installing" };
    this.prepared = true;
    this.stopped = false;
    this.lost = false;
    if (opts.restoreDiff && this.restored !== opts.restoreDiff) {
      // Apply the fake's own diff format (whole new file contents) like `git apply` would.
      this.restored = opts.restoreDiff;
      for (const block of opts.restoreDiff.split(/^diff --git /m).slice(1)) {
        const path = /^a\/(\S+)/.exec(block)?.[1];
        const body = block.split("\n").slice(3).map((l) => l.slice(1)).join("\n");
        if (path) this.files.set(path, body);
      }
    }
    return { ready: true as const, baseSha: "base000" };
  }
  lost = false;
  async healthy() {
    return this.prepared && !this.stopped && !this.lost;
  }
  async listFiles() {
    return [...this.files.keys()].sort();
  }
  async grep(terms: string[]) {
    const out: string[] = [];
    for (const [p, c] of this.files) c.split("\n").forEach((l, i) => terms.some((t) => l.toLowerCase().includes(t.toLowerCase())) && out.push(`${p}:${i + 1}:${l}`));
    return out.join("\n");
  }
  async readFile(path: string) {
    return this.files.get(path) ?? null;
  }
  async writeFile(path: string, content: string) {
    this.files.set(path, content);
  }
  async diff() {
    const files = [...new Set([...this.files.keys(), ...this.base.keys()])].filter((p) => this.files.get(p) !== this.base.get(p)).sort();
    const diff = files.map((p) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n${(this.files.get(p) ?? "").split("\n").map((l) => `+${l}`).join("\n")}`).join("\n");
    return { diff, files };
  }
  async checkpoint() {
    const sha = `cp${this.checkpoints.length + 1}`;
    this.checkpoints.push({ sha, files: new Map(this.files) });
    return sha;
  }
  async resetTo(sha: string) {
    const cp = sha === "base000" ? { files: this.base } : this.checkpoints.find((c) => c.sha === sha);
    if (cp) this.files = new Map(cp.files);
  }
  async startCheck(check: CheckDef) {
    const n = (this.counters[check.id] = (this.counters[check.id] ?? 0) + 1);
    const seq = this.script[check.id] ?? [{ exitCode: 0, output: `${check.id} ok` }];
    const evaluated = this.evaluate?.(check.id, this.files);
    const result = evaluated ?? seq[Math.min(n - 1, seq.length - 1)]!;
    const handle = `${check.id}#${n}`;
    this.runs.set(handle, { check: check.id, result, polls: 0 });
    return handle;
  }
  async pollCheck(handle: string) {
    const r = this.runs.get(handle);
    if (!r) throw new Error("unknown check handle");
    r.polls++;
    if (r.polls <= (r.result.pending ?? 0)) return { done: false as const };
    return { done: true as const, exitCode: r.result.exitCode, output: r.result.output };
  }
  async killCheck(handle: string) {
    this.killed.push(handle);
  }
  async stop() {
    this.stopped = true;
    return { activeMs: 1000 };
  }
}
