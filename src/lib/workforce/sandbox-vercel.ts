import "server-only";
import { Sandbox } from "@vercel/sandbox";
import { INSTALL_COMMAND, INSTALL_DOMAINS } from "./checks";
import type { CheckDef } from "./types";
import type { Workspace, WorkspaceFactory } from "./workspace";

/**
 * Vercel Sandbox backend: one disposable Firecracker microVM per task.
 * - The repository is cloned by the platform; nothing from Orbis's own
 *   environment (API keys, database credentials) is passed in.
 * - Network: npm registry only while installing (with lifecycle scripts
 *   disabled), denied afterwards; a check may open specific domains
 *   (e.g. Google Fonts for `next build`) while it runs.
 * - Long commands run detached through a fixed runner script that records
 *   exit codes and output to files, so progress survives across requests.
 */
const ROOT = "/vercel/sandbox";
const STATE = "/tmp/orbis";

const RUNNER = `import { spawn } from "node:child_process";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
const [jobId, b64] = process.argv.slice(2);
if (!/^[a-z0-9-]{1,64}$/.test(jobId)) process.exit(2);
const spec = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
const dir = "${STATE}";
mkdirSync(dir, { recursive: true });
const log = dir + "/" + jobId + ".log";
writeFileSync(log, "");
writeFileSync(dir + "/" + jobId + ".pid", String(process.pid));
const started = Date.now();
let timedOut = false;
let cancelled = false;
let code = 0;
let current = null;
process.on("SIGTERM", () => { cancelled = true; try { if (current) process.kill(-current.pid, "SIGKILL"); } catch {} });
for (const argv of spec.commands) {
  if (cancelled) break;
  appendFileSync(log, "$ " + argv.join(" ") + "\\n");
  code = await new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: "${ROOT}", env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" }, detached: true });
    current = child;
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGKILL"); } catch {} }, spec.timeoutMs);
    child.stdout.on("data", (d) => appendFileSync(log, d));
    child.stderr.on("data", (d) => appendFileSync(log, d));
    child.on("close", (c) => { clearTimeout(timer); resolve(c ?? 1); });
    child.on("error", (e) => { clearTimeout(timer); appendFileSync(log, String(e) + "\\n"); resolve(127); });
  });
  current = null;
  if (code !== 0 || timedOut || cancelled) break;
}
writeFileSync(dir + "/" + jobId + ".json", JSON.stringify({ exitCode: cancelled ? 143 : timedOut ? 124 : code, timedOut, cancelled, durationMs: Date.now() - started }));
`;

export function sandboxCredentials() {
  const token = process.env.ORBIS_SANDBOX_TOKEN?.trim();
  const teamId = process.env.ORBIS_SANDBOX_TEAM_ID?.trim();
  const projectId = process.env.ORBIS_SANDBOX_PROJECT_ID?.trim();
  return token && teamId && projectId ? { token, teamId, projectId } : {};
}

class VercelSandboxWorkspace implements Workspace {
  private sbx: Sandbox | null = null;
  constructor(readonly name: string) {}

  private async get(): Promise<Sandbox | null> {
    if (this.sbx) return this.sbx;
    try {
      this.sbx = await Sandbox.get({ name: this.name, ...sandboxCredentials() });
      return this.sbx;
    } catch {
      return null;
    }
  }
  private async must(): Promise<Sandbox> {
    const s = await this.get();
    if (!s) throw new Error("The task workspace no longer exists (it may have timed out). Retry the task to recreate it.");
    return s;
  }
  private async run(cmd: string, args: string[], timeoutMs = 60_000): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const s = await this.must();
    const r = await s.runCommand({ cmd, args, cwd: ROOT, env: { GIT_TERMINAL_PROMPT: "0" } });
    void timeoutMs;
    return { exitCode: r.exitCode, stdout: await r.stdout(), stderr: await r.stderr() };
  }
  private async readText(path: string): Promise<string | null> {
    const s = await this.must();
    const b = await s.readFileToBuffer({ path });
    return b ? b.toString("utf8") : null;
  }
  private async startJob(jobId: string, commands: string[][], timeoutMs: number) {
    const s = await this.must();
    const spec = Buffer.from(JSON.stringify({ commands, timeoutMs })).toString("base64");
    await s.runCommand({ cmd: "node", args: [`${STATE}/runner.mjs`, jobId, spec], cwd: ROOT, detached: true });
  }

  async healthy() {
    try {
      return (await this.readText(`${STATE}/base-sha`)) !== null;
    } catch {
      return false;
    }
  }

  async prepare(opts: { repo: string; branch: string; restoreDiff?: string | null }) {
    let s = await this.get();
    // A stopped non-persistent sandbox resumes as a fresh clone without our state: treat it as new.
    const initialised = s ? await this.healthy() : false;
    if (!s || !initialised) {
      s ??= await Sandbox.create({
        name: this.name,
        source: { type: "git", url: `https://github.com/${opts.repo}.git`, revision: opts.branch, depth: 1 },
        runtime: "node22",
        resources: { vcpus: Number(process.env.ORBIS_SANDBOX_VCPUS ?? 2) === 4 ? 4 : 2 },
        timeout: 45 * 60_000,
        persistent: false,
        ...sandboxCredentials(),
      } as Parameters<typeof Sandbox.create>[0]);
      this.sbx = s;
      const sb = s;
      await sb.updateNetworkPolicy({ allow: INSTALL_DOMAINS });
      const head = await this.run("git", ["rev-parse", "HEAD"]);
      const files: { path: string; content: string }[] = [
        { path: `${STATE}/runner.mjs`, content: RUNNER },
        { path: `${STATE}/base-sha`, content: head.stdout.trim() },
      ];
      if (opts.restoreDiff) files.push({ path: `${STATE}/restore.diff`, content: opts.restoreDiff });
      await sb.writeFiles(files);
      await this.run("git", ["config", "user.email", "workforce@orbis.invalid"]);
      await this.run("git", ["config", "user.name", "Orbis Workforce"]);
      await this.run("git", ["checkout", "-b", "orbis-workforce"]);
      const cmds = [INSTALL_COMMAND, ...(opts.restoreDiff ? [["git", "apply", "--whitespace=nowarn", `${STATE}/restore.diff`]] : [])];
      await this.startJob("install", cmds, 10 * 60_000);
      return { ready: false as const, detail: "Workspace created; installing dependencies." };
    }
    const status = await this.readText(`${STATE}/install.json`);
    if (!status) return { ready: false as const, detail: "Installing dependencies." };
    const r = JSON.parse(status) as { exitCode: number };
    if (r.exitCode !== 0) {
      const log = (await this.readText(`${STATE}/install.log`)) ?? "";
      throw new Error(`Dependency install failed (exit ${r.exitCode}): ${log.slice(-1500)}`);
    }
    await s.updateNetworkPolicy("deny-all");
    const base = ((await this.readText(`${STATE}/base-sha`)) ?? "").trim();
    return { ready: true as const, baseSha: base };
  }

  async listFiles() {
    const r = await this.run("git", ["ls-files"]);
    return r.stdout.split("\n").filter(Boolean);
  }
  async grep(terms: string[], maxBytes = 12000) {
    const safe = terms.filter((t) => t.length >= 3 && t.length <= 60).slice(0, 8);
    if (!safe.length) return "";
    const r = await this.run("git", ["grep", "-n", "-I", "-i", "-F", "--max-count=4", ...safe.flatMap((t) => ["-e", t]), "--", ".", ":(exclude)*.lock", ":(exclude)package-lock.json"]);
    return r.stdout.slice(0, maxBytes);
  }
  async readFile(path: string) {
    return this.readText(`${ROOT}/${path}`);
  }
  async writeFile(path: string, content: string) {
    const s = await this.must();
    await s.writeFiles([{ path: `${ROOT}/${path}`, content }]);
  }
  async diff(baseSha: string) {
    await this.run("git", ["add", "-A"]);
    const d = await this.run("git", ["diff", "--cached", baseSha]);
    const n = await this.run("git", ["diff", "--cached", "--name-only", baseSha]);
    return { diff: d.stdout, files: n.stdout.split("\n").filter(Boolean) };
  }
  async checkpoint(message: string) {
    await this.run("git", ["add", "-A"]);
    const c = await this.run("git", ["commit", "-q", "-m", message.slice(0, 200)]);
    if (c.exitCode !== 0) return null;
    return (await this.run("git", ["rev-parse", "HEAD"])).stdout.trim();
  }
  async resetTo(sha: string) {
    if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error("Invalid checkpoint id.");
    await this.run("git", ["reset", "-q", "--hard", sha]);
    await this.run("git", ["clean", "-q", "-fd"]);
  }
  async startCheck(check: CheckDef) {
    const s = await this.must();
    if (check.network?.length) await s.updateNetworkPolicy({ allow: check.network });
    const jobId = `${check.id}-${Date.now().toString(36)}`;
    await this.startJob(jobId, check.commands, check.timeoutMs ?? 600_000);
    return jobId;
  }
  async pollCheck(handle: string) {
    if (!/^[a-z0-9-]{1,64}$/.test(handle)) throw new Error("Invalid check handle.");
    const status = await this.readText(`${STATE}/${handle}.json`);
    if (!status) return { done: false as const };
    const r = JSON.parse(status) as { exitCode: number };
    const output = (await this.readText(`${STATE}/${handle}.log`)) ?? "";
    const s = await this.must();
    await s.updateNetworkPolicy("deny-all");
    return { done: true as const, exitCode: r.exitCode, output };
  }
  async killCheck(handle: string) {
    if (!/^[a-z0-9-]{1,64}$/.test(handle)) return;
    const pid = (await this.readText(`${STATE}/${handle}.pid`))?.trim();
    if (pid && /^\d+$/.test(pid)) await this.run("kill", ["-TERM", pid]).catch(() => {});
  }
  async stop() {
    const s = await this.get();
    if (!s) return { activeMs: null };
    const r = await s.stop().catch(() => null);
    const ms = (r as { activeCpuDurationMs?: number; duration?: number } | null)?.duration ?? null;
    return { activeMs: typeof ms === "number" ? ms : null };
  }
}

export const vercelWorkspaces: WorkspaceFactory = Object.assign((name: string) => new VercelSandboxWorkspace(name), {
  available(): { ok: true } | { ok: false; reason: string } {
    // On Vercel, credentials come from the function's OIDC token automatically.
    if (process.env.VERCEL || process.env.ORBIS_SANDBOX_TOKEN) return { ok: true };
    return { ok: false, reason: "Isolated workspaces need Vercel Sandbox: run on Vercel, or set ORBIS_SANDBOX_TOKEN, ORBIS_SANDBOX_TEAM_ID and ORBIS_SANDBOX_PROJECT_ID for local development." };
  },
});
