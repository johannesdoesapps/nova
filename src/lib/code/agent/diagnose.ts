/**
 * The likely cause of a failed command, read from its output: a missing
 * dependency, a blocked download, or a port already in use. Pure, so the
 * agent's tool results, the report and the page word it the same way.
 * Only recognised patterns are named; anything else returns null rather
 * than a guess.
 */

export interface Diagnosis {
  kind: "missing_dependency" | "network_blocked" | "port_in_use";
  /** The missing package, module or command, when the output names it. */
  name: string | null;
  /** One sentence for the user and the agent. */
  hint: string;
}

const MISSING: RegExp[] = [
  /Cannot find module '([^']+)'/,
  /Cannot find package '([^']+)'/,
  /Module not found: (?:Error: )?Can't resolve '([^']+)'/,
  /Failed to resolve import "([^"]+)"/,
  /ModuleNotFoundError: No module named '([^']+)'/,
  /ImportError: No module named '?([\w.]+)'?/,
  /(?:^|\n)(?:sh|bash)(?:: line \d+)?: (?:\d+: )?([\w.@/-]+): (?:command )?not found/,
  /(?:^|\n)([\w.@/-]+): command not found/,
  /ERR_MODULE_NOT_FOUND/,
];

export function diagnoseOutput(output: string | null | undefined): Diagnosis | null {
  if (!output) return null;
  const text = output.slice(-20_000);
  if (/EADDRINUSE|address already in use/i.test(text)) {
    return { kind: "port_in_use", name: null, hint: "The port is already in use: another server is still running. Starting the preview again stops the old one." };
  }
  if (
    /\b(ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET)\b|getaddrinfo|Could not resolve host|Temporary failure in name resolution/.test(text) &&
    !/registry\.npmjs\.org|pypi\.org|files\.pythonhosted\.org/.test(text)
  ) {
    return {
      kind: "network_blocked",
      name: null,
      hint: "A download from the internet failed: the project's computer can only reach npm and PyPI, so other sites (CDNs, APIs, git hosts) aren't reachable from it.",
    };
  }
  for (const re of MISSING) {
    const m = re.exec(text);
    if (!m) continue;
    const name = m[1] ?? null;
    const python = /ModuleNotFoundError|ImportError/.test(m[0]);
    const install = python ? "pip install -r requirements.txt (or pip install the package)" : "npm install";
    return {
      kind: "missing_dependency",
      name,
      hint: `A dependency is missing${name ? ` (${name})` : ""}: install the project's dependencies (${install}) and add it to the project's dependency list if it isn't there.`,
    };
  }
  return null;
}
