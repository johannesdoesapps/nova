/**
 * Languages the Run button supports, shared by the server and the chat UI.
 * The sandbox image has Python 3 (standard library only) and Node.js (which
 * runs TypeScript by stripping types). No network, so no package installs.
 */
export type CodeLanguageId = "python" | "javascript" | "typescript" | "bash";

export interface CodeLanguage {
  id: CodeLanguageId;
  label: string;
  file: string;
  command: string[];
}

const LANGUAGES: Record<CodeLanguageId, CodeLanguage> = {
  python: { id: "python", label: "Python", file: "main.py", command: ["python3", "main.py"] },
  javascript: { id: "javascript", label: "JavaScript", file: "main.js", command: ["node", "main.js"] },
  typescript: { id: "typescript", label: "TypeScript", file: "main.ts", command: ["node", "main.ts"] },
  bash: { id: "bash", label: "Bash", file: "main.sh", command: ["bash", "main.sh"] },
};

const ALIASES: Record<string, CodeLanguageId> = {
  python: "python",
  py: "python",
  python3: "python",
  javascript: "javascript",
  js: "javascript",
  node: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  typescript: "typescript",
  ts: "typescript",
  bash: "bash",
  sh: "bash",
  shell: "bash",
};

/** The runnable language for a code block's language tag, or null. */
export function codeLanguage(tag: string | null | undefined): CodeLanguage | null {
  const id = tag ? ALIASES[tag.trim().toLowerCase()] : undefined;
  return id ? LANGUAGES[id] : null;
}

/** Largest program the Run button sends, in characters. */
export const MAX_CODE_CHARS = 100_000;
/** Most of each of stdout and stderr returned, in bytes. */
export const CODE_OUTPUT_LIMIT = 64 * 1024;

export interface CodeRunResult {
  language: CodeLanguageId;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}
