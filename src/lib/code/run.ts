import "server-only";
import { Sandbox } from "@vercel/sandbox";
import { sandboxCredentials } from "@/lib/workforce/sandbox-vercel";
import { CODE_OUTPUT_LIMIT, codeLanguage, type CodeRunResult } from "./languages";

/**
 * Runs a snippet from a chat code block in a disposable Vercel Sandbox
 * microVM: one VM per run, no network, 1 vCPU, a hard time limit and a cap on
 * output. Nothing from Orbis's own environment (keys, database credentials) is
 * passed in, and the VM is stopped as soon as the run ends.
 */

/** The parts of a sandbox a run uses (a fake one in tests). */
export interface RunBox {
  writeFiles(files: { path: string; content: string | Uint8Array }[]): Promise<void>;
  runCommand(params: { cmd: string; args: string[]; cwd: string; env: Record<string, string>; signal?: AbortSignal }): Promise<{ exitCode: number | null; stdout(): Promise<string> }>;
  stop(): Promise<unknown>;
}
export type BoxFactory = (opts: { timeoutMs: number; signal?: AbortSignal }) => Promise<RunBox>;

/** Where the program and its output live in the VM (it exists in the image). */
const DIR = "/tmp";

export const vercelBox: BoxFactory = async ({ timeoutMs, signal }) =>
  (await Sandbox.create({
    image: "vercel/sandbox/universal",
    resources: { vcpus: 1 },
    timeout: timeoutMs,
    networkPolicy: "deny-all",
    persistent: false,
    signal,
    ...sandboxCredentials(),
  } as Parameters<typeof Sandbox.create>[0])) as unknown as RunBox;

/** Whether runs can start here: on Vercel (OIDC) or with NOVA_SANDBOX_* set for local development. */
export function codeRunsAvailable(): boolean {
  return Boolean(process.env.VERCEL || process.env.NOVA_SANDBOX_TOKEN);
}

/**
 * The script the VM runs: the program under `timeout`, its output in files
 * capped by `ulimit -f` (so endless printing can't fill memory), then the
 * first CODE_OUTPUT_LIMIT bytes of each and the exit code, separated by markers.
 */
export function runnerScript(command: string[], seconds: number, dir = DIR): string {
  const q = command.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
  return [
    `cd '${dir}'`,
    `( ulimit -f 4096; exec timeout -s KILL ${seconds} ${q} ) > out.txt 2> err.txt < /dev/null`,
    `code=$?`,
    `printf '%s' "$(wc -c < out.txt) $(wc -c < err.txt) $code"`,
    `printf '\\n--NOVA-OUT--\\n'; head -c ${CODE_OUTPUT_LIMIT} out.txt`,
    `printf '\\n--NOVA-ERR--\\n'; head -c ${CODE_OUTPUT_LIMIT} err.txt`,
  ].join("\n");
}

/** Parse what runnerScript prints. */
export function parseRunnerOutput(raw: string): { stdout: string; stderr: string; exitCode: number; truncated: boolean } {
  const outAt = raw.indexOf("\n--NOVA-OUT--\n");
  const errAt = raw.lastIndexOf("\n--NOVA-ERR--\n");
  if (outAt < 0 || errAt < outAt) return { stdout: "", stderr: raw.slice(-CODE_OUTPUT_LIMIT), exitCode: 1, truncated: false };
  const [outBytes, errBytes, code] = raw.slice(0, outAt).trim().split(/\s+/).map(Number);
  return {
    stdout: raw.slice(outAt + 14, errAt),
    stderr: raw.slice(errAt + 14),
    exitCode: Number.isFinite(code) ? code! : 1,
    truncated: (outBytes ?? 0) > CODE_OUTPUT_LIMIT || (errBytes ?? 0) > CODE_OUTPUT_LIMIT,
  };
}

export async function runCode(
  input: { language: string; code: string; seconds: number; signal?: AbortSignal; dir?: string },
  box: BoxFactory = vercelBox,
): Promise<CodeRunResult> {
  const lang = codeLanguage(input.language);
  const dir = input.dir ?? DIR;
  if (!lang) throw new Error(`Unsupported language: ${input.language}`);
  const started = Date.now();
  // The VM lives a little longer than the program may, so stopping is always ours to do.
  const vm = await box({ timeoutMs: (input.seconds + 60) * 1000, signal: input.signal });
  try {
    await vm.writeFiles([{ path: `${dir}/${lang.file}`, content: input.code }]);
    const cmd = await vm.runCommand({
      cmd: "bash",
      args: ["-c", runnerScript(lang.command, input.seconds, dir)],
      cwd: "/",
      env: { PYTHONUNBUFFERED: "1", NODE_NO_WARNINGS: "1", NO_COLOR: "1", HOME: dir },
      signal: input.signal,
    });
    const parsed = parseRunnerOutput(await cmd.stdout());
    const durationMs = Date.now() - started;
    // When timeout(1) had to stop the program it exits 124 (GNU coreutils) or 137 (killed), depending on the build.
    const timedOut = (parsed.exitCode === 124 || parsed.exitCode === 137) && durationMs >= input.seconds * 1000;
    return { language: lang.id, ...parsed, timedOut, durationMs };
  } finally {
    await vm.stop().catch(() => {});
  }
}
