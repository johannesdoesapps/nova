import "server-only";
import { Sandbox } from "@vercel/sandbox";
import { sandboxCredentials } from "@/lib/workforce/sandbox-vercel";
import { ADMIN_MAX_PROJECT_FILES, IGNORED_DIRS, isIgnoredPath, MAX_FILE_BYTES, PREVIEW_PORT, type ProjectFile } from "./projects";

/**
 * Code workspace computers: one Vercel Sandbox microVM per session (1 vCPU,
 * 2 GB), named after the session's first time block so only the API can
 * find it. The project's files are copied in when it starts; commands run in
 * the background with their output in a log the editor reads as it grows;
 * files a command creates, changes or deletes are copied back afterwards.
 *
 * - Network: package registries only (npm, PyPI), so code can install
 *   packages but can't reach anything else.
 * - Nothing from Orbis's own environment (keys, database credentials) is
 *   passed in.
 * - Installed packages are kept between sessions: a stopped computer's disk
 *   is saved (one snapshot, kept WORKSPACE_KEEP_MS), and the project's next
 *   session starts as a copy of it. The project's files are then written in
 *   again and files the project no longer has are removed, so only package
 *   and build folders (IGNORED_DIRS) carry over. Without a saved disk (first
 *   session, or it expired) the computer starts fresh.
 * - The live preview is the app on port 3000, at the sandbox's public URL.
 */

export const WS_ROOT = "/vercel/sandbox";
const JOBS = "/tmp/orbis-jobs";

/** Where the project and the command logs live in the computer (temporary folders in tests). */
export interface WsDirs {
  root: string;
  jobs: string;
}
export const WS_DIRS: WsDirs = { root: WS_ROOT, jobs: JOBS };
export const WORKSPACE_DOMAINS = ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"];
/** Most of a command's output kept, and returned per read. */
export const JOB_LOG_LIMIT = 4_000_000;
export const JOB_READ_CHUNK = 64 * 1024;

/** The parts of a sandbox a workspace uses (a fake one in tests). */
export interface WorkspaceBox {
  writeFiles(files: { path: string; content: string | Uint8Array }[]): Promise<void>;
  runCommand(params: { cmd: string; args: string[]; cwd?: string; env?: Record<string, string>; detached?: boolean }): Promise<{ exitCode: number | null; stdout(): Promise<string> } | unknown>;
  domain(port: number): string;
  extendTimeout(ms: number): Promise<void>;
  stop(): Promise<unknown>;
  readonly status?: string;
}

export interface WorkspaceBackend {
  /**
   * A new computer. `from` names the project's previous one: the new one starts from its saved disk when there is
   * one (`restored`), else fresh.
   */
  create(name: string, minutes: number, from?: string | null): Promise<{ box: WorkspaceBox; restored: boolean }>;
  /** The running computer, or null when it has stopped or doesn't exist. */
  get(name: string): Promise<WorkspaceBox | null>;
  /** Delete a computer that's been copied (the copy doesn't need it; its saved disk expires on its own). */
  remove(name: string): Promise<void>;
}

/** How long a stopped computer's disk (installed packages, build caches) is kept for the project's next session. */
export const WORKSPACE_KEEP_MS = 7 * 24 * 60 * 60_000;

export const workspaceName = (sessionId: string) => `orbis-ws-${sessionId}`;

export const vercelWorkspaces: WorkspaceBackend = {
  async create(name, minutes, from) {
    const params = {
      name,
      resources: { vcpus: 1 },
      timeout: minutes * 60_000,
      ports: [PREVIEW_PORT],
      networkPolicy: { allow: WORKSPACE_DOMAINS },
      // Stopping saves the disk (one snapshot, then it expires), so the next session can start from it.
      persistent: true,
      snapshotExpiration: WORKSPACE_KEEP_MS,
      keepLastSnapshots: { count: 1, expiration: WORKSPACE_KEEP_MS },
      ...sandboxCredentials(),
    };
    if (from) {
      try {
        const box = await Sandbox.fork({ ...params, sourceSandbox: from } as Parameters<typeof Sandbox.fork>[0]);
        return { box: box as unknown as WorkspaceBox, restored: true };
      } catch {
        // The previous computer is gone (deleted, or from before disks were kept): start fresh.
      }
    }
    const box = await Sandbox.create({ ...params, image: "vercel/sandbox/universal" } as Parameters<typeof Sandbox.create>[0]);
    return { box: box as unknown as WorkspaceBox, restored: false };
  },
  async get(name) {
    try {
      const s = await Sandbox.get({ name, ...sandboxCredentials() });
      // Never resume a stopped computer: that would start time nobody reserved.
      if (s.status !== "running") return null;
      return s as unknown as WorkspaceBox;
    } catch {
      return null;
    }
  },
  async remove(name) {
    const s = await Sandbox.get({ name, ...sandboxCredentials() });
    await s.delete();
  },
};

/** Whether workspaces can start here: on Vercel (OIDC) or with ORBIS_SANDBOX_* set for local development. */
export function workspacesAvailable(): boolean {
  return Boolean(process.env.VERCEL || process.env.ORBIS_SANDBOX_TOKEN);
}

/** Environment for commands: a calm, plain-text terminal and the preview port. */
export const COMMAND_ENV: Record<string, string> = {
  PORT: String(PREVIEW_PORT),
  HOST: "0.0.0.0",
  NO_COLOR: "1",
  FORCE_COLOR: "0",
  NPM_CONFIG_UPDATE_NOTIFIER: "false",
  NPM_CONFIG_FUND: "false",
  NPM_CONFIG_AUDIT: "false",
  PYTHONUNBUFFERED: "1",
  PIP_DISABLE_PIP_VERSION_CHECK: "1",
  PIP_BREAK_SYSTEM_PACKAGES: "1",
  PIP_ROOT_USER_ACTION: "ignore",
};

/**
 * Lists the project's files in the computer and prints, as JSON, every path
 * (outside package and build folders) and the text of files changed since a
 * time, so one command copies back what a command did.
 */
export const collectScript = (root: string) => `import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
const root = ${JSON.stringify(root)};
const since = Number(process.argv[2] ?? 0);
const beforeFile = process.argv[3];
const ignored = new Set(${JSON.stringify(IGNORED_DIRS)});
const paths = [];
const changed = {};
const skipped = [];
let overflow = false;
function walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) { if (!ignored.has(e.name)) walk(full); continue; }
    if (!e.isFile()) continue;
    const rel = relative(root, full);
    if (paths.length >= ${ADMIN_MAX_PROJECT_FILES * 2}) { overflow = true; return; }
    paths.push(rel);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.mtimeMs <= since) continue;
    if (st.size > ${MAX_FILE_BYTES}) { skipped.push(rel); continue; }
    const buf = readFileSync(full);
    if (buf.includes(0)) { skipped.push(rel); continue; }
    changed[rel] = buf.toString("utf8");
  }
}
walk(root);
let before = null;
if (beforeFile) { try { before = JSON.parse(readFileSync(beforeFile, "utf8")).paths; } catch {} }
process.stdout.write(JSON.stringify({ paths, changed, skipped, overflow, before }));
`;

/**
 * A local Git history for the session: the project as it was copied in is
 * the first commit, so `git status` and `git diff` show what changed since.
 * It stays in the computer (never pushed from here). Best effort.
 */
export const GIT_SEED = [
  "git init -q -b main 2>/dev/null || git init -q",
  "git config user.name Orbis && git config user.email workspace@tryorbis.app",
  `printf '%s\\n' ${IGNORED_DIRS.map((d) => `'${d}/'`).join(" ")} > .git/info/exclude`,
  "git add -A && git commit -qm 'Project as copied in' --allow-empty",
  "true",
].join(" ; ");

/**
 * Removes files the project doesn't have (outside package and build folders) from a computer that started from the
 * previous session's disk, so files deleted in Orbis since don't come back. Reads the project's paths from a file.
 */
export const pruneScript = (root: string) => `import { readdirSync, readFileSync, rmSync, rmdirSync } from "node:fs";
import { join, relative } from "node:path";
const root = ${JSON.stringify(root)};
const keep = new Set(JSON.parse(readFileSync(process.argv[2], "utf8")));
const ignored = new Set(${JSON.stringify(IGNORED_DIRS)});
let removed = 0;
function walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (ignored.has(e.name)) continue;
      walk(full);
      try { rmdirSync(full); } catch {} // only when it's now empty
      continue;
    }
    if (!keep.has(relative(root, full))) { try { rmSync(full, { force: true }); removed++; } catch {} }
  }
}
walk(root);
process.stdout.write(String(removed));
`;

/**
 * Copy the project into a new computer, with the helper script, and start its Git history. `restored`: the computer
 * started from the previous session's disk, so files the project no longer has are removed first.
 */
export async function seedWorkspace(box: WorkspaceBox, files: ProjectFile[], d: WsDirs = WS_DIRS, opts: { restored?: boolean } = {}): Promise<void> {
  if (opts.restored) {
    await box.writeFiles([
      { path: `${d.jobs}/prune.mjs`, content: pruneScript(d.root) },
      { path: `${d.jobs}/keep.json`, content: JSON.stringify(files.map((f) => f.path)) },
    ]);
    await box.runCommand({ cmd: "node", args: [`${d.jobs}/prune.mjs`, `${d.jobs}/keep.json`], cwd: d.root });
  }
  await box.writeFiles([
    { path: `${d.jobs}/collect.mjs`, content: collectScript(d.root) },
    ...files.map((f) => ({ path: `${d.root}/${f.path}`, content: f.content })),
  ]);
  try {
    await box.runCommand({ cmd: "bash", args: ["-c", GIT_SEED], cwd: d.root });
  } catch {
    // No Git in the computer: everything else still works.
  }
}

const JOB_ID = /^[a-z0-9]{6,32}$/;

/**
 * Start a command in the background. Its output (stdout and stderr together,
 * up to JOB_LOG_LIMIT) goes to a log; its exit code to a file when it ends.
 * It runs in its own process group so Stop ends everything it started.
 */
export function jobScript(jobId: string, d: WsDirs = WS_DIRS): string {
  if (!JOB_ID.test(jobId)) throw new Error("Invalid job id.");
  const j = `${d.jobs}/${jobId}`;
  return [
    `mkdir -p ${d.jobs}`,
    `date +%s%3N > ${j}.start`,
    // The files present before the command, so only files it removed are deleted from the project afterwards.
    `node ${d.jobs}/collect.mjs 99999999999999 > ${j}.before.json 2>/dev/null`,
    `cd ${d.root}`,
    `setsid bash -c 'bash -c "$ORBIS_CMD" 2>&1 < /dev/null | head -c ${JOB_LOG_LIMIT} > "$0.log"; echo "\${PIPESTATUS[0]}" > "$0.exit.tmp"; mv "$0.exit.tmp" "$0.exit"' ${j} &`,
    `echo $! > ${j}.pid`,
    `wait`,
  ].join("\n");
}

export async function startJob(box: WorkspaceBox, jobId: string, command: string, d: WsDirs = WS_DIRS): Promise<void> {
  await box.runCommand({ cmd: "bash", args: ["-c", jobScript(jobId, d)], cwd: d.root, env: { ...COMMAND_ENV, ORBIS_CMD: command }, detached: true });
}

/** Read the output from a byte offset; prints "<exit or -> <log size> <start ms>" on the first line, then the chunk. */
export function readScript(jobId: string, offset: number, d: WsDirs = WS_DIRS): string {
  if (!JOB_ID.test(jobId)) throw new Error("Invalid job id.");
  const j = `${d.jobs}/${jobId}`;
  const o = Math.max(0, Math.floor(offset));
  return [
    `E=$(cat ${j}.exit 2>/dev/null || echo -)`,
    `S=$(stat -c %s ${j}.log 2>/dev/null || echo 0)`,
    `T=$(cat ${j}.start 2>/dev/null || echo 0)`,
    `N=$(( S - ${o} )); [ $N -gt ${JOB_READ_CHUNK} ] && N=${JOB_READ_CHUNK}; [ $N -lt 0 ] && N=0`,
    `printf '%s %s %s\\n' "$E" "$(( ${o} + N ))" "$T"`,
    `[ $N -gt 0 ] && tail -c +$(( ${o} + 1 )) ${j}.log | head -c $N`,
    `true`,
  ].join("\n");
}

export interface JobRead {
  output: string;
  offset: number;
  done: boolean;
  exitCode: number | null;
  startedAt: number;
}

export function parseRead(raw: string, offset: number): JobRead {
  const nl = raw.indexOf("\n");
  const [e, size, start] = (nl < 0 ? raw : raw.slice(0, nl)).trim().split(/\s+/);
  const exit = e === "-" || e === undefined ? null : Number(e);
  return {
    output: nl < 0 ? "" : raw.slice(nl + 1),
    offset: Number.isFinite(Number(size)) ? Number(size) : offset,
    done: exit !== null && Number.isFinite(exit),
    exitCode: exit !== null && Number.isFinite(exit) ? exit : null,
    startedAt: Number(start) || 0,
  };
}

async function sh(box: WorkspaceBox, script: string, d: WsDirs): Promise<string> {
  const r = (await box.runCommand({ cmd: "bash", args: ["-c", script], cwd: d.root })) as { stdout(): Promise<string> };
  return r.stdout();
}

export async function readJob(box: WorkspaceBox, jobId: string, offset: number, d: WsDirs = WS_DIRS): Promise<JobRead> {
  return parseRead(await sh(box, readScript(jobId, offset, d), d), offset);
}

/** Stop a command and everything it started; it reads as exit 143 if it hadn't finished. */
export async function killJob(box: WorkspaceBox, jobId: string, d: WsDirs = WS_DIRS): Promise<void> {
  if (!JOB_ID.test(jobId)) throw new Error("Invalid job id.");
  const j = `${d.jobs}/${jobId}`;
  await sh(box, `P=$(cat ${j}.pid 2>/dev/null); [ -n "$P" ] && kill -TERM -- -"$P" 2>/dev/null; sleep 0.3; [ -n "$P" ] && kill -KILL -- -"$P" 2>/dev/null; [ -f ${j}.exit ] || echo 143 > ${j}.exit; true`, d);
}

export interface Collected {
  paths: string[];
  changed: Record<string, string>;
  skipped: string[];
  overflow: boolean;
  /** Files present when the command started (null if unknown). */
  before?: string[] | null;
}

/** Every file in the computer (outside package/build folders) and the text of those changed since `sinceMs`. */
export async function collectFiles(box: WorkspaceBox, sinceMs: number, jobId?: string, d: WsDirs = WS_DIRS): Promise<Collected> {
  if (jobId !== undefined && !JOB_ID.test(jobId)) throw new Error("Invalid job id.");
  const before = jobId ? ` ${d.jobs}/${jobId}.before.json` : "";
  const raw = await sh(box, `node ${d.jobs}/collect.mjs ${Math.max(0, Math.floor(sinceMs))}${before}`, d);
  return JSON.parse(raw) as Collected;
}

/**
 * What copying back means for the saved project: files the command created
 * or changed, and saved files the command removed (present when it started,
 * gone now). Files saved from the editor meanwhile are never deleted, nor are
 * files in package/build folders; when a listing is missing or overflowed
 * nothing is deleted.
 */
export function syncPlan(saved: ProjectFile[], c: Collected): { upserts: ProjectFile[]; deletes: string[] } {
  const byPath = new Map(saved.map((f) => [f.path, f.content]));
  const upserts = Object.entries(c.changed)
    .filter(([path, content]) => !isIgnoredPath(path) && byPath.get(path) !== content)
    .map(([path, content]) => ({ path, content }));
  const present = new Set(c.paths);
  const before = c.before ? new Set(c.before) : null;
  const deletes = c.overflow || !before ? [] : saved.filter((f) => !isIgnoredPath(f.path) && before.has(f.path) && !present.has(f.path)).map((f) => f.path);
  return { upserts, deletes };
}

/** Mirror an edit made in the editor into a running computer. */
export async function writeToWorkspace(box: WorkspaceBox, files: ProjectFile[], d: WsDirs = WS_DIRS): Promise<void> {
  if (files.length) await box.writeFiles(files.map((f) => ({ path: `${d.root}/${f.path}`, content: f.content })));
}

export async function removeFromWorkspace(box: WorkspaceBox, paths: string[], d: WsDirs = WS_DIRS): Promise<void> {
  if (!paths.length) return;
  await box.runCommand({ cmd: "rm", args: ["-f", "--", ...paths.map((p) => `${d.root}/${p}`)], cwd: d.root });
}

/** True the first time it's called for a finished command, so its files are copied back once. */
export async function claimSync(box: WorkspaceBox, jobId: string, d: WsDirs = WS_DIRS): Promise<boolean> {
  if (!JOB_ID.test(jobId)) throw new Error("Invalid job id.");
  const j = `${d.jobs}/${jobId}`;
  return (await sh(box, `mkdir ${j}.synced 2>/dev/null && echo NEW || true`, d)).trim() === "NEW";
}
