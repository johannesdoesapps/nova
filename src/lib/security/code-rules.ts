import { fingerprint, maskSecret, type Confidence, type FindingDraft, type Severity } from "./types";

/**
 * Nova Code Guardian's built-in rules: fast pattern checks for secrets and
 * insecure code. Patterns can't prove exploitability, so each rule declares
 * its confidence honestly; the finding text says what to check.
 */

export interface SourceFile {
  path: string;
  content: string;
}

interface Rule {
  id: string;
  title: string;
  severity: Severity;
  confidence: Confidence;
  langs: "js" | "py" | "php" | "any";
  pattern: RegExp;
  /** Return false to ignore a match (e.g. placeholders or sanitised values). */
  accept?: (match: RegExpExecArray, line: string, file: SourceFile) => boolean | { severity?: Severity; confidence?: Confidence };
  secret?: boolean;
  description: string;
  rationale: string;
  remediation: string;
  references: string[];
}

const CWE = (n: number) => `https://cwe.mitre.org/data/definitions/${n}.html`;
const OWASP_SECRETS = "https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html";
const ROTATE = "Remove it from the code, load it from an environment variable or secret manager, and rotate the key — it should be treated as leaked, including in git history.";

const PLACEHOLDER = /(example|sample|dummy|changeme|change_me|placeholder|your[_-]|xxx|\*\*\*|<|\$\{|process\.env|os\.environ|getenv|test|fake|redacted)/i;

const RULES: Rule[] = [
  // Secrets
  { id: "secret.aws-access-key", title: "AWS access key in source code", severity: "critical", confidence: "firm", langs: "any", secret: true, pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/, description: "An AWS access key ID is committed in the code.", rationale: "AWS keys can grant broad access to cloud resources and billing.", remediation: ROTATE, references: [OWASP_SECRETS, CWE(798)] },
  { id: "secret.github-token", title: "GitHub token in source code", severity: "critical", confidence: "firm", langs: "any", secret: true, pattern: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/, description: "A GitHub access token is committed in the code.", rationale: "Grants access to repositories and possibly organisation settings.", remediation: ROTATE, references: [OWASP_SECRETS, CWE(798)] },
  { id: "secret.stripe-live", title: "Stripe live secret key in source code", severity: "critical", confidence: "firm", langs: "any", secret: true, pattern: /\b[sr]k_live_[A-Za-z0-9]{20,}\b/, description: "A live Stripe secret key is committed in the code.", rationale: "Allows charges, refunds and access to customer payment data.", remediation: ROTATE, references: [OWASP_SECRETS, CWE(798)] },
  { id: "secret.anthropic-key", title: "Anthropic API key in source code", severity: "high", confidence: "firm", langs: "any", secret: true, pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/, description: "An Anthropic API key is committed in the code.", rationale: "Lets others run paid AI requests on your account.", remediation: ROTATE, references: [OWASP_SECRETS, CWE(798)] },
  { id: "secret.openai-key", title: "OpenAI-style API key in source code", severity: "high", confidence: "firm", langs: "any", secret: true, pattern: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{32,}\b/, description: "An API key in OpenAI's format (also used by DeepSeek and others) is committed in the code.", rationale: "Lets others run paid AI requests on your account.", remediation: ROTATE, references: [OWASP_SECRETS, CWE(798)] },
  { id: "secret.slack-token", title: "Slack token in source code", severity: "high", confidence: "firm", langs: "any", secret: true, pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, description: "A Slack token is committed in the code.", rationale: "Can read or post messages in your workspace.", remediation: ROTATE, references: [OWASP_SECRETS, CWE(798)] },
  { id: "secret.google-api-key", title: "Google API key in source code", severity: "medium", confidence: "tentative", langs: "any", secret: true, pattern: /\bAIza[0-9A-Za-z_-]{35}\b/, description: "A Google API key is committed in the code.", rationale: "Browser keys are often meant to be public; check the key is restricted by referrer and API.", remediation: "If it's a server key, move it to an environment variable and rotate it. If it's a browser key, restrict it to your domains and the APIs it needs.", references: [OWASP_SECRETS] },
  { id: "secret.private-key", title: "Private key in source code", severity: "critical", confidence: "firm", langs: "any", secret: true, pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/, description: "A private key block is committed in the code.", rationale: "Private keys can impersonate servers or decrypt traffic.", remediation: ROTATE, references: [OWASP_SECRETS, CWE(321)] },
  {
    id: "secret.supabase-service-role",
    title: "Supabase service-role key in source code",
    severity: "critical",
    confidence: "confirmed",
    langs: "any",
    secret: true,
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
    accept: (m) => {
      try {
        const payload = JSON.parse(Buffer.from(m[0].split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as { role?: string };
        return payload.role === "service_role";
      } catch {
        return false;
      }
    },
    description: "A JWT whose role is service_role is committed in the code. It bypasses Row Level Security.",
    rationale: "Gives full read and write access to the whole database.",
    remediation: ROTATE,
    references: [OWASP_SECRETS, "https://supabase.com/docs/guides/api/api-keys"],
  },
  {
    id: "secret.hardcoded-credential",
    title: "Possible hard-coded password or secret",
    severity: "medium",
    confidence: "tentative",
    langs: "any",
    secret: true,
    pattern: /\b(password|passwd|pwd|secret|api_?key|access_?token|auth_?token|client_?secret)\b["']?\s*[:=]\s*["']([^"'\s]{8,})["']/i,
    accept: (m) => !PLACEHOLDER.test(m[2] ?? "") && !/^[a-z_.]+$/i.test(m[2] ?? ""),
    description: "A variable named like a credential is assigned a literal string.",
    rationale: "Name-based match: it may be a real secret or a harmless constant.",
    remediation: "If this is a real secret, load it from configuration instead and rotate it.",
    references: [CWE(798)],
  },
  // JavaScript / TypeScript
  { id: "code.eval", title: "Use of eval()", severity: "medium", confidence: "firm", langs: "js", pattern: /(?<![\w.])eval\s*\(/, description: "eval() runs a string as code. If any part of that string comes from users, they can run arbitrary code.", rationale: "Dangerous only if input can reach it; review where the argument comes from.", remediation: "Replace eval with JSON.parse, a lookup table, or explicit logic.", references: [CWE(95)] },
  { id: "code.new-function", title: "Dynamic code with new Function()", severity: "medium", confidence: "firm", langs: "js", pattern: /new\s+Function\s*\(/, description: "new Function() compiles a string into code, like eval.", rationale: "Dangerous only if input can reach it.", remediation: "Avoid compiling strings into functions; use explicit logic.", references: [CWE(95)] },
  { id: "code.command-injection", title: "Shell command built from variables", severity: "high", confidence: "firm", langs: "js", pattern: /\b(?:exec|execSync|spawnSync|spawn)\s*\(\s*(?:`[^`]*\$\{|[^)'"`\n]*\+\s*\w)/, accept: (_m, line) => !/execFile/.test(line), description: "A shell command is assembled from variables. If they include user input, attackers can run their own commands.", rationale: "Command injection usually means full server compromise.", remediation: "Use execFile/spawn with an argument array (no shell), and validate inputs against an allow-list.", references: [CWE(78), "https://cheatsheetseries.owasp.org/cheatsheets/OS_Command_Injection_Defense_Cheat_Sheet.html"] },
  { id: "code.sql-injection", title: "SQL query built with string interpolation", severity: "high", confidence: "firm", langs: "js", pattern: /\b(?:query|execute|raw|unsafe|\$queryRawUnsafe|\$executeRawUnsafe|prepare)\s*\(\s*`[^`]*\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^`]*\$\{/i, description: "A SQL statement is built by inserting variables into the query text.", rationale: "If any variable is user-controlled, attackers can read or change the database.", remediation: "Use parameterised queries (placeholders like $1 or ?) or the query builder's safe API.", references: [CWE(89), "https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html"] },
  { id: "code.sql-concat", title: "SQL query built by string concatenation", severity: "high", confidence: "tentative", langs: "any", pattern: /["'`]\s*(?:SELECT|INSERT INTO|UPDATE|DELETE FROM)\b[^"'`\n]*["'`]\s*\+\s*[\w$]/i, description: "A SQL statement is concatenated with a variable.", rationale: "Pattern match; confirm whether the variable can contain user input.", remediation: "Use parameterised queries instead of concatenation.", references: [CWE(89)] },
  { id: "code.dangerously-set-html", title: "Unsanitised HTML rendered with dangerouslySetInnerHTML", severity: "medium", confidence: "tentative", langs: "js", pattern: /dangerouslySetInnerHTML\s*=\s*\{\{\s*__html\s*:\s*(?!["'`])/, accept: (_m, line) => !/sanitiz|DOMPurify|escape/i.test(line), description: "HTML is injected into the page from a variable without visible sanitisation.", rationale: "XSS if the HTML can contain user content.", remediation: "Sanitise with DOMPurify (or render as text) before injecting HTML.", references: [CWE(79)] },
  { id: "code.inner-html", title: "innerHTML assigned from a variable", severity: "medium", confidence: "tentative", langs: "js", pattern: /\.(?:innerHTML|outerHTML)\s*=\s*(?!["'`][^"'`$]*["'`]\s*;?\s*$)[^;\n]+/, accept: (_m, line) => !/sanitiz|DOMPurify|escape/i.test(line), description: "Markup is written into the page from a variable.", rationale: "XSS if the value can contain user content.", remediation: "Use textContent, or sanitise the HTML first.", references: [CWE(79)] },
  { id: "code.tls-disabled", title: "TLS certificate verification disabled", severity: "high", confidence: "firm", langs: "any", pattern: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|verify\s*=\s*False|CURLOPT_SSL_VERIFYPEER\s*,\s*(?:false|0)/, description: "HTTPS certificate checks are turned off, so connections can be intercepted.", rationale: "Lets a network attacker read and change traffic, including credentials.", remediation: "Remove the override; if you need a private CA, configure it explicitly instead.", references: [CWE(295)] },
  { id: "code.weak-hash", title: "MD5 or SHA-1 used", severity: "low", confidence: "tentative", langs: "any", pattern: /createHash\(\s*['"](?:md5|sha1)['"]\)|hashlib\.(?:md5|sha1)\(|\bmd5\(/i, accept: (_m, line) => (/passw|secret|token/i.test(line) ? { severity: "high", confidence: "firm" } : true), description: "MD5/SHA-1 are broken for security purposes. For passwords they are far too fast.", rationale: "Low if used for checksums; high if used for passwords or signatures.", remediation: "For passwords use bcrypt, scrypt or Argon2. For integrity use SHA-256 or better.", references: [CWE(327), CWE(916)] },
  { id: "code.insecure-random", title: "Math.random() used for something security-sensitive", severity: "medium", confidence: "tentative", langs: "js", pattern: /Math\.random\(\)/, accept: (_m, line) => /token|secret|password|salt|nonce|otp|session|key\b|code\b/i.test(line), description: "Math.random() is predictable and must not be used for tokens, codes or secrets.", rationale: "Predictable tokens can be guessed.", remediation: "Use crypto.randomUUID() or crypto.getRandomValues().", references: [CWE(338)] },
  { id: "code.jwt-none", title: "JWT 'none' algorithm accepted", severity: "high", confidence: "firm", langs: "any", pattern: /algorithms?\s*[:=]\s*\[?\s*['"]none['"]/i, description: "The token verifier accepts unsigned tokens.", rationale: "Anyone can forge a token and impersonate any user.", remediation: "Allow only the algorithm you sign with (e.g. ['HS256'] or ['RS256']).", references: [CWE(347)] },
  { id: "code.open-redirect", title: "Redirect to a URL taken from the request", severity: "medium", confidence: "firm", langs: "js", pattern: /\.redirect\(\s*req\.(?:query|body|params)/, description: "The app redirects to an address supplied in the request.", rationale: "Attackers can send users to phishing sites via your trusted domain.", remediation: "Redirect only to relative paths or an allow-list of destinations.", references: [CWE(601)] },
  { id: "code.path-traversal", title: "File path built from request input", severity: "high", confidence: "firm", langs: "js", pattern: /\b(?:readFile|readFileSync|createReadStream|sendFile|unlink|writeFile)\s*\([^)\n]*req\.(?:query|params|body)/, description: "A file system call uses a value from the request.", rationale: "Paths like ../../etc/passwd can read or overwrite files outside the intended folder.", remediation: "Map user input to known file names, or resolve the path and check it stays inside the allowed directory.", references: [CWE(22)] },
  // Python
  { id: "py.shell-true", title: "subprocess with shell=True", severity: "medium", confidence: "firm", langs: "py", pattern: /subprocess\.\w+\([^)\n]*shell\s*=\s*True/, accept: (_m, line) => (/f["']|\+|%|format\(/.test(line) ? { severity: "high" } : true), description: "Runs a command through the shell; variables in it can inject commands.", rationale: "High when the command contains variables.", remediation: "Pass a list of arguments without shell=True.", references: [CWE(78)] },
  { id: "py.os-system", title: "os.system() call", severity: "medium", confidence: "firm", langs: "py", pattern: /os\.(?:system|popen)\s*\(/, accept: (_m, line) => (/f["']|\+|%|format\(/.test(line) ? { severity: "high" } : true), description: "Runs a shell command.", rationale: "High when the command contains variables.", remediation: "Use subprocess.run with an argument list.", references: [CWE(78)] },
  { id: "py.unsafe-deserialize", title: "Unsafe deserialisation (pickle / yaml.load)", severity: "high", confidence: "firm", langs: "py", pattern: /pickle\.loads?\(|yaml\.load\((?![^)]*SafeLoader)/, description: "Deserialising untrusted data with pickle or yaml.load can execute code.", rationale: "Remote code execution if the data can come from users.", remediation: "Use JSON, or yaml.safe_load; never unpickle untrusted data.", references: [CWE(502)] },
  { id: "py.sql-format", title: "SQL query built with string formatting", severity: "high", confidence: "firm", langs: "py", pattern: /\.execute(?:many)?\(\s*(?:f["']|["'][^"']*["']\s*%|["'][^"']*["']\.format\()/, description: "A SQL statement is built with f-strings, % or .format().", rationale: "SQL injection if any value is user-controlled.", remediation: "Pass values as parameters: cursor.execute(sql, (value,)).", references: [CWE(89)] },
  { id: "py.eval", title: "Use of eval()/exec()", severity: "medium", confidence: "firm", langs: "py", pattern: /(?<![\w.])(?:eval|exec)\s*\(/, description: "Runs a string as Python code.", rationale: "Dangerous only if input can reach it.", remediation: "Use ast.literal_eval for data, or explicit logic.", references: [CWE(95)] },
  { id: "py.debug-true", title: "Debug mode enabled", severity: "medium", confidence: "tentative", langs: "py", pattern: /^\s*DEBUG\s*=\s*True\b|\.run\([^)]*debug\s*=\s*True/, description: "Debug mode shows stack traces and sometimes an interactive console.", rationale: "Only a problem if this configuration reaches production.", remediation: "Read DEBUG from the environment and default it to False.", references: [CWE(489)] },
  // PHP
  { id: "php.eval-input", title: "eval() on request input", severity: "critical", confidence: "firm", langs: "php", pattern: /eval\s*\(\s*\$_(?:GET|POST|REQUEST|COOKIE)/, description: "Runs code supplied in the request.", rationale: "Remote code execution.", remediation: "Remove eval of user input entirely.", references: [CWE(95)] },
  { id: "php.sql-input", title: "SQL query with request input", severity: "high", confidence: "firm", langs: "php", pattern: /(?:mysqli?_query|->query)\s*\([^)\n]*\$_(?:GET|POST|REQUEST|COOKIE)/, description: "A query includes request values directly.", rationale: "SQL injection.", remediation: "Use prepared statements with bound parameters.", references: [CWE(89)] },
  { id: "php.echo-input", title: "Request input echoed into the page", severity: "high", confidence: "firm", langs: "php", pattern: /(?:echo|print)\s+\$_(?:GET|POST|REQUEST|COOKIE)/, description: "Request values are written to the page without escaping.", rationale: "Reflected XSS.", remediation: "Escape output with htmlspecialchars($value, ENT_QUOTES, 'UTF-8').", references: [CWE(79)] },
];

export const CODE_RULE_IDS = RULES.map((r) => r.id);

const LANG: Record<string, Rule["langs"]> = { js: "js", jsx: "js", ts: "js", tsx: "js", mjs: "js", cjs: "js", vue: "js", svelte: "js", py: "py", php: "php" };
export const SUPPORTED_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|vue|svelte|py|php|rb|go|java|cs|json|ya?ml|toml|env|ini|cfg|conf|properties|sh|tf|xml|html?|sql|txt|md)$/i;
const SKIP_PATH = /(^|\/)(node_modules|\.git|dist|build|\.next|out|vendor|coverage|__pycache__|\.venv|venv)\//;
const LOCKFILE = /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Pipfile\.lock|composer\.lock)$/;

export function isScannable(path: string): boolean {
  return !SKIP_PATH.test(path) && !LOCKFILE.test(path) && !/\.min\.(js|css)$/.test(path) && (SUPPORTED_EXT.test(path) || /(^|\/)\.env(\.|$)/.test(path) || /Dockerfile$/.test(path));
}

const isComment = (line: string) => /^\s*(\/\/|#(?!!)|\*|\/\*|<!--)/.test(line);
const isExampleFile = (p: string) => /\.(example|sample|template)$|\.env\.(example|sample)|(^|\/)(tests?|__tests__|spec|fixtures?)\//i.test(p);

export function runCodeRules(files: SourceFile[], asset: string): { findings: FindingDraft[]; filesScanned: number; linesScanned: number } {
  const findings = new Map<string, FindingDraft>();
  let filesScanned = 0;
  let linesScanned = 0;
  for (const file of files) {
    if (!isScannable(file.path)) continue;
    filesScanned++;
    const ext = /\.([a-z]+)$/i.exec(file.path)?.[1]?.toLowerCase() ?? "";
    const lang = LANG[ext];
    const lines = file.content.split("\n");
    linesScanned += lines.length;
    const example = isExampleFile(file.path);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.length > 2000) continue;
      for (const rule of RULES) {
        if (rule.langs !== "any" && rule.langs !== lang) continue;
        if (!rule.secret && isComment(line)) continue;
        if (rule.secret && example) continue;
        const m = rule.pattern.exec(line);
        if (!m) continue;
        const ok = rule.accept ? rule.accept(m, line, file) : true;
        if (ok === false) continue;
        const adj = typeof ok === "object" ? ok : {};
        const shown = rule.secret ? line.replace(m[0], maskSecret(m[0])) : line;
        const fp = fingerprint("code_guardian", rule.id, asset, file.path, rule.secret ? maskSecret(m[0]) : line.trim());
        const existing = findings.get(fp);
        const evidence = { source: `${file.path}:${i + 1}`, detail: shown.trim().slice(0, 300) };
        if (existing) {
          if (existing.evidence.length < 3) existing.evidence.push(evidence);
          continue;
        }
        findings.set(fp, {
          agent: "code_guardian",
          ruleId: rule.id,
          fingerprint: fp,
          title: rule.title,
          description: rule.description,
          severity: adj.severity ?? rule.severity,
          confidence: adj.confidence ?? rule.confidence,
          rationale: rule.rationale,
          asset,
          location: `${file.path}:${i + 1}`,
          evidence: [evidence],
          evidenceSource: "nova:code-rules",
          remediation: rule.remediation,
          references: rule.references,
        });
      }
    }
  }
  return { findings: [...findings.values()], filesScanned, linesScanned };
}
