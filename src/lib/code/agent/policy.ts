/**
 * Which commands the coding agent may run on its own, which need the user's
 * approval first, and which are never run. Commands run only in the
 * project's isolated workspace computer (no secrets, package registries
 * only), so the rules protect the user's project and intent rather than
 * Orbis itself.
 */

export type CommandDecision =
  | { kind: "allow"; purpose: CommandPurpose }
  | { kind: "ask"; purpose: CommandPurpose; reason: string }
  | { kind: "block"; reason: string };

export type CommandPurpose = "test" | "build" | "install" | "inspect" | "run" | "other";

/** Never run, even with approval: destructive to the machine, publishing or deploying, or escaping the workspace. */
const BLOCKED: [RegExp, string][] = [
  [/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)[a-z]*\s+(\/|~|\$HOME|\*|\.\.?)(\s|$|\/\s|\/\*)/i, "deletes the whole workspace or system"],
  [/\b(mkfs|fdisk|shutdown|reboot|halt|poweroff)\b/, "changes the machine itself"],
  [/\bdd\s+if=/, "writes raw disk data"],
  [/:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:/, "is a fork bomb"],
  [/\bsudo\b|\bsu\s+-?\s*\w*\s*$/, "needs administrator rights"],
  [/\b(npm|pnpm|yarn)\s+publish\b|\btwine\s+upload\b|\bcargo\s+publish\b/, "publishes a package"],
  [/\bgit\s+push\b/, "pushes to a remote (use “Push to GitHub” in Changes instead)"],
  [/\b(vercel|netlify|firebase|fly|heroku|wrangler)\b.*\b(deploy|--prod|publish)\b|\bkubectl\b|\bterraform\s+apply\b/, "deploys (Orbis doesn't deploy from the agent)"],
  [/\b(curl|wget)\b[^|]*\|\s*(ba|z)?sh\b/, "pipes a download into a shell"],
  [/\bchmod\s+-R\s+[0-7]*7\s+\//, "changes permissions across the system"],
  [/\bkill\s+-9\s+-1\b|\bkillall\b/, "stops every process"],
];

const SAFE: [RegExp, CommandPurpose][] = [
  [/^(npm|pnpm|yarn)\s+(run\s+)?(test|test:\w+)(\s|$)/, "test"],
  [/^(npx\s+)?(vitest|jest|mocha|ava)(\s+run)?(\s|$)/, "test"],
  [/^(python3?\s+-m\s+)?pytest(\s|$)/, "test"],
  [/^python3?\s+-m\s+unittest(\s|$)/, "test"],
  [/^go\s+test(\s|$)/, "test"],
  [/^(npm|pnpm|yarn)\s+run\s+(build|lint|typecheck|check|format:check)(\s|$)/, "build"],
  [/^(npx\s+)?(tsc|eslint|prettier\s+--check|next\s+lint|biome\s+check)(\s|$)/, "build"],
  [/^python3?\s+-m\s+(py_compile|compileall|mypy|ruff|flake8)(\s|$)/, "build"],
  [/^(ruff|flake8|mypy|black\s+--check)(\s|$)/, "build"],
  [/^(npm|pnpm|yarn)\s+(install|ci|i|add)(\s|$)/, "install"],
  [/^(pip3?|python3?\s+-m\s+pip)\s+install(\s|$)/, "install"],
  [/^(ls|cat|head|tail|wc|pwd|tree|file|stat|du|echo|which|env)(\s|$)/, "inspect"],
  [/^(grep|rg)\s/, "inspect"],
  [/^find\s(?!.*(-delete|-exec|-execdir|-ok))/, "inspect"],
  [/^git\s+(status|diff|log|show|branch|ls-files)(\s|$)/, "inspect"],
  [/^(node|python3?|deno|bun)\s+(--version|-v|-V)$/, "inspect"],
  [/^(npm|node|python3?)\s+--version$/, "inspect"],
  [/^(node|python3?|tsx|bun)\s+[\w./-]+\.(m?js|cjs|ts|py)(\s|$)/, "run"],
  [/^(npm|pnpm|yarn)\s+(run\s+)?start(\s|$)/, "run"],
];

/** Split a shell line into the commands it chains (&&, ||, ;, |). Quotes are respected. */
export function splitCommands(line: string): string[] | null {
  const parts: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "`" || (ch === "$" && line[i + 1] === "(")) return null; // command substitution: judged as a whole
    if (ch === ";" || ch === "|" || (ch === "&" && line[i + 1] === "&")) {
      if (ch === "&" || (ch === "|" && line[i + 1] === "|")) i++;
      parts.push(cur.trim());
      cur = "";
      continue;
    }
    if (ch === "&") return null; // background jobs
    cur += ch;
  }
  if (quote) return null;
  parts.push(cur.trim());
  return parts.filter(Boolean);
}

/** Redirecting output into files outside the project, or overwriting with >, needs a look. */
const RISKY_REDIRECT = />\s*\/(?!dev\/null)/;

export function classifyCommand(command: string): CommandDecision {
  const c = command.trim();
  if (!c) return { kind: "block", reason: "is empty" };
  if (c.length > 2000) return { kind: "block", reason: "is too long" };
  for (const [re, why] of BLOCKED) if (re.test(c)) return { kind: "block", reason: `This command ${why}.` };
  const parts = splitCommands(c);
  if (!parts) return { kind: "ask", purpose: "other", reason: "It uses shell features (command substitution or background jobs) that need a look." };
  if (RISKY_REDIRECT.test(c)) return { kind: "ask", purpose: "other", reason: "It writes outside the project." };
  let purpose: CommandPurpose | null = null;
  for (const p of parts) {
    const hit = SAFE.find(([re]) => re.test(p));
    if (!hit) return { kind: "ask", purpose: purpose ?? "other", reason: `“${p.slice(0, 80)}” isn't one of the commands the agent may run on its own.` };
    // The most significant purpose wins (test > build > install > run > inspect).
    const rank: CommandPurpose[] = ["inspect", "run", "install", "build", "test"];
    if (!purpose || rank.indexOf(hit[1]) > rank.indexOf(purpose)) purpose = hit[1];
  }
  // Removing files is reviewable (changes can be reverted) but should still be visible.
  if (/(^|\s)rm\s/.test(c)) return { kind: "ask", purpose: purpose ?? "other", reason: "It deletes files." };
  return { kind: "allow", purpose: purpose ?? "other" };
}
