import "server-only";
import { PREVIEW_PORT } from "./projects";
import { killJob, readJob, startJob, WS_DIRS, type WorkspaceBox, type WsDirs } from "./workspace";
import { CHECK_SCRIPT, CHECK_TOOLS, type PreviewCheckRaw } from "./preview-check";

/**
 * The live preview in the project's computer: the website's server runs as a
 * background job with a fixed id (so the Run button and the agent share it,
 * and starting it again replaces the old one), on port 3000 — the only port
 * the computer exposes. Whether it's up is checked by asking it, never
 * assumed. The browser check loads the site in headless Chromium inside the
 * same computer, at a desktop and a phone size.
 */

export const PREVIEW_JOB = "orbispreview";
/** How long a server may take to answer after starting (installs included). */
export const PREVIEW_START_MS = 90_000;
const POLL_MS = 1_500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sh(box: WorkspaceBox, script: string, d: WsDirs): Promise<string> {
  const r = (await box.runCommand({ cmd: "bash", args: ["-c", script], cwd: d.root })) as { stdout(): Promise<string> };
  return r.stdout();
}

export interface PreviewProbe {
  /** HTTP status the server answered with (0: nothing is listening or it didn't answer). */
  http: number;
  /** The preview job is still running. */
  running: boolean;
  /** Its exit code once it has stopped. */
  exitCode: number | null;
  /** Other ports something listens on (a server on the wrong port). */
  otherPorts: number[];
}

/** One look at the preview: does the port answer, is the job alive, what else is listening. */
export async function probePreview(box: WorkspaceBox, d: WsDirs = WS_DIRS, port = PREVIEW_PORT): Promise<PreviewProbe> {
  const j = `${d.jobs}/${PREVIEW_JOB}`;
  const raw = await sh(
    box,
    [
      `H=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://127.0.0.1:${port}/ 2>/dev/null || echo 0)`,
      `E=$(cat ${j}.exit 2>/dev/null || echo -)`,
      `R=0; [ -f ${j}.pid ] && [ "$E" = "-" ] && R=1`,
      `L=$( ( (ss -ltnH 2>/dev/null | awk '{print $4}') || true; (lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $9}') || true) | sed 's/.*://' | grep -E '^[0-9]+$' | sort -un | tr '\\n' ' ')`,
      `echo "$H|$R|$E|$L"`,
    ].join("\n"),
    d,
  );
  const [h, r, e, l] = raw.trim().split("|");
  const exit = e === "-" || e === undefined || e === "" ? null : Number(e);
  return {
    http: Number(h) || 0,
    running: r === "1",
    exitCode: exit !== null && Number.isFinite(exit) ? exit : null,
    otherPorts: (l ?? "")
      .split(/\s+/)
      .map(Number)
      .filter((p) => Number.isInteger(p) && p > 0 && p !== port && p >= 1024 && p !== 26661),
  };
}

/** Stop the preview job and anything else holding the port, and clear its files so the id can be reused. */
export async function stopPreview(box: WorkspaceBox, d: WsDirs = WS_DIRS, port = PREVIEW_PORT): Promise<void> {
  await killJob(box, PREVIEW_JOB, d).catch(() => {});
  const j = `${d.jobs}/${PREVIEW_JOB}`;
  await sh(
    box,
    `P=$(lsof -t -i:${port} -sTCP:LISTEN 2>/dev/null); [ -n "$P" ] && kill $P 2>/dev/null; sleep 0.3; rm -rf ${j}.exit ${j}.exit.tmp ${j}.pid ${j}.log ${j}.start ${j}.before.json ${j}.synced; true`,
    d,
  );
}

export interface PreviewStart {
  state: "running" | "exited" | "timeout";
  /** The status the server answered with when it came up. */
  http: number;
  exitCode: number | null;
  /** The end of the server's output (errors are usually there). */
  log: string;
  waitedMs: number;
  /** Ports something listens on other than the preview port, when the preview port never answered. */
  otherPorts: number[];
}

/** The end of the preview job's output. */
export async function previewLog(box: WorkspaceBox, maxChars = 6_000, d: WsDirs = WS_DIRS): Promise<string> {
  const r = await readJob(box, PREVIEW_JOB, 0, d).catch(() => null);
  if (!r) return "";
  let out = r.output;
  // The first read returns at most one chunk; for long logs, read the end instead.
  if (r.offset > out.length) {
    const tail = await readJob(box, PREVIEW_JOB, Math.max(0, r.offset - maxChars), d).catch(() => null);
    if (tail) out = tail.output;
  }
  return out.length > maxChars ? out.slice(-maxChars) : out;
}

/**
 * (Re)start the preview server with `command` and wait until the port
 * answers, the command exits, or the time is up. Nothing is assumed: the
 * state comes from asking the port and reading the job.
 */
export async function startPreview(box: WorkspaceBox, command: string, opts: { d?: WsDirs; port?: number; timeoutMs?: number; signal?: () => Promise<boolean> } = {}): Promise<PreviewStart> {
  const d = opts.d ?? WS_DIRS;
  const port = opts.port ?? PREVIEW_PORT;
  const started = Date.now();
  await stopPreview(box, d, port);
  await startJob(box, PREVIEW_JOB, command, d);
  let probe: PreviewProbe = { http: 0, running: true, exitCode: null, otherPorts: [] };
  for (;;) {
    await sleep(POLL_MS);
    probe = await probePreview(box, d, port);
    if (probe.http > 0) break;
    if (!probe.running && probe.exitCode !== null) break;
    if (Date.now() - started > (opts.timeoutMs ?? PREVIEW_START_MS)) break;
    if (opts.signal && (await opts.signal())) break;
  }
  const log = await previewLog(box, 6_000, d);
  const state = probe.http > 0 ? "running" : probe.exitCode !== null ? "exited" : "timeout";
  return { state, http: probe.http, exitCode: probe.exitCode, log, waitedMs: Date.now() - started, otherPorts: state === "running" ? [] : probe.otherPorts };
}

/** What the agent and the page are told about a start. */
export function describeStart(s: PreviewStart, command: string): string {
  const head =
    s.state === "running"
      ? `The preview server is running: \`${command}\` answered on port ${PREVIEW_PORT} with HTTP ${s.http} after ${(s.waitedMs / 1000).toFixed(1)}s.`
      : s.state === "exited"
        ? `The preview server stopped: \`${command}\` exited with code ${s.exitCode} before anything answered on port ${PREVIEW_PORT}.`
        : `Nothing answered on port ${PREVIEW_PORT} within ${Math.round(s.waitedMs / 1000)}s of starting \`${command}\`. It's still running in the background.`;
  const ports = s.otherPorts.length
    ? `\nSomething is listening on port ${s.otherPorts.join(", ")} instead. The preview only shows port ${PREVIEW_PORT}: make the server use port ${PREVIEW_PORT} and host 0.0.0.0 (the PORT environment variable is set to ${PREVIEW_PORT}).`
    : "";
  return `${head}${ports}\nServer output (end):\n${s.log.trim() || "(no output)"}`;
}

// ---------------------------------------------------------------- the browser check

const TOOLS_DIR = "/tmp/orbis-tools";

/**
 * Install the browser (headless Chromium and its driver, from npm — the
 * computer can reach npm and nothing else) outside the project, once per
 * computer, and run the check script against the running preview.
 */
export async function runPreviewCheck(box: WorkspaceBox, path: string, d: WsDirs = WS_DIRS, port = PREVIEW_PORT): Promise<PreviewCheckRaw> {
  const script = `${d.jobs}/check.mjs`;
  await box.writeFiles([{ path: script, content: CHECK_SCRIPT }]);
  const install = `mkdir -p ${TOOLS_DIR} && cd ${TOOLS_DIR} && (test -f node_modules/puppeteer-core/package.json || timeout 150 npm i --no-audit --no-fund --no-save --prefix ${TOOLS_DIR} ${CHECK_TOOLS.join(" ")} > ${TOOLS_DIR}/install.log 2>&1 || (tail -c 1500 ${TOOLS_DIR}/install.log; exit 7))`;
  const run = `cd /tmp && AWS_EXECUTION_ENV=AWS_Lambda_nodejs22.x timeout 90 node ${script} ${JSON.stringify(`http://127.0.0.1:${port}`)} ${JSON.stringify(path)} ${TOOLS_DIR}/node_modules/`;
  const raw = await sh(box, `${install} && ${run} || echo '{"error":"The browser check couldn\\u0027t run (exit '$?')."}'`, d);
  const start = raw.indexOf('{"');
  try {
    return JSON.parse(start >= 0 ? raw.slice(start) : raw) as PreviewCheckRaw;
  } catch {
    return { url: path, viewports: [], links: [], error: `The browser check's output couldn't be read: ${raw.slice(0, 300)}` };
  }
}
