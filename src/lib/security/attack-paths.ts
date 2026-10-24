import { classify, type Classification, type FindingLike } from "./details";
import { SEVERITY_ORDER, type Severity } from "./types";

/**
 * Attack paths: how recorded findings could combine into something worse than each one alone. Built only
 * from findings that exist (with their ids, so every step links to its evidence) — the engine never adds
 * weaknesses of its own and never runs the chain.
 *
 * A path is "theoretical" unless every weakness in it is individually confirmed, in which case it is
 * "steps_confirmed": each step was observed, but the chain itself still wasn't executed, so it is never
 * presented as a demonstrated compromise.
 */

export interface PathStep {
  kind: "prerequisite" | "weakness" | "impact";
  text: string;
  findingIds: string[];
  classification?: Classification;
}

export interface AttackPath {
  id: string;
  title: string;
  severity: Severity;
  status: "theoretical" | "steps_confirmed";
  steps: PathStep[];
  impact: string;
  /** The single change that breaks the chain most cheaply. */
  breakWith: string;
  findingIds: string[];
}

type F = FindingLike & { id: string };

const live = (f: F) => !["false_positive", "fixed", "verified"].includes(f.status);
const worst = (fs: F[]) => [...fs].sort((a, b) => SEVERITY_ORDER[a.severity as Severity] - SEVERITY_ORDER[b.severity as Severity])[0];
const names = (fs: F[], n = 3) =>
  fs
    .slice(0, n)
    .map((f) => `“${f.title}”`)
    .join(", ") + (fs.length > n ? ` and ${fs.length - n} more` : "");

/** The weakest classification across a step's findings (one unverified finding makes the step unverified). */
function stepClass(fs: F[], all: F[]): Classification {
  const order: Classification[] = ["needs_verification", "likely", "confirmed", "informational", "false_positive"];
  return fs.map((f) => classify(f, all)).sort((a, b) => order.indexOf(a) - order.indexOf(b))[0] ?? "needs_verification";
}

function weakness(text: string, fs: F[], all: F[]): PathStep {
  return { kind: "weakness", text, findingIds: fs.map((f) => f.id), classification: stepClass(fs, all) };
}

const pathPart = (loc: string | null) => {
  if (!loc) return null;
  try {
    return new URL(loc).pathname.replace(/\/+$/, "") || "/";
  } catch {
    return null;
  }
};
/** "/api/items/:id" matches "/api/items/42"; exact paths match themselves. */
export function routeMatches(pattern: string, path: string) {
  const re = new RegExp(
    "^" +
      pattern
        .replace(/\/+$/, "")
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/:\w+\*/g, ".+")
        .replace(/:\w+/g, "[^/]+") +
      "$",
  );
  return re.test(path.replace(/\/+$/, ""));
}
/** The route a code finding is about, only when a signed-out GET (all Sentinel's live checks send) can say anything about it. */
const getRouteOf = (f: F) => {
  const m = /^(GET|POST|PUT|PATCH|DELETE|ANY) (\S+)/.exec(f.evidence[0]?.detail ?? "");
  return m && (m[1] === "GET" || m[1] === "ANY") ? m[2]! : null;
};

export function attackPaths(input: FindingLike[]): AttackPath[] {
  const all = input.filter((f): f is F => Boolean(f.id)).filter(live);
  const by = (re: RegExp, extra: (f: F) => boolean = () => true) => all.filter((f) => re.test(f.rule_id) && extra(f));
  const paths: AttackPath[] = [];
  const add = (p: Omit<AttackPath, "status" | "findingIds">) => {
    const weak = p.steps.filter((s) => s.kind === "weakness");
    const ids = [...new Set(p.steps.flatMap((s) => s.findingIds))];
    if (!weak.length || !ids.length) return;
    const status = weak.every((s) => s.classification === "confirmed") ? "steps_confirmed" : "theoretical";
    paths.push({ ...p, status, findingIds: ids });
  };

  // 1. A secret anyone can fetch → direct use of the service it unlocks.
  const publicSecrets = [...by(/^surface\.client-secret/), ...by(/^exposure\.(env-file|aws-credentials|config-backup)$/)];
  if (publicSecrets.length) {
    add({
      id: "public-secret",
      title: "A secret anyone can download gives direct access to a service",
      severity: (worst(publicSecrets)!.severity as Severity) === "critical" ? "critical" : "high",
      steps: [
        { kind: "prerequisite", text: "No account needed: the file is served to every visitor.", findingIds: [] },
        weakness(`Secret exposed publicly: ${names(publicSecrets)}.`, publicSecrets, all),
        { kind: "impact", text: "The attacker uses the key directly against the service it belongs to (database, cloud, payments), bypassing your application.", findingIds: [] },
      ],
      impact: "Data access or spending on your accounts, limited only by the key's own permissions.",
      breakWith: "Remove the secret from public files and rotate it.",
    });
  }

  // 2. Downloadable source code + secrets committed in it.
  const gitExposed = by(/^exposure\.git-/);
  const committed = by(/^secret\./);
  if (gitExposed.length && committed.length) {
    add({
      id: "git-secrets",
      title: "Downloadable source code reveals committed secrets",
      severity: "critical",
      steps: [
        weakness(`The .git directory is served: ${names(gitExposed)}.`, gitExposed, all),
        weakness(`The code contains secrets: ${names(committed)}.`, committed, all),
        { kind: "impact", text: "Reconstructing the repository from /.git exposes the secrets (including ones only in history).", findingIds: [] },
      ],
      impact: "Credential theft and full knowledge of the source code.",
      breakWith: "Block /.git on the web server, then rotate the committed secrets.",
    });
  }

  // 3. Script injection sink + weak CSP + readable session cookie → session theft.
  const sinks = by(/^(code\.(dangerously-set-html|inner-html)|php\.echo-input)$/);
  const weakCsp = by(/^headers\.csp-/);
  const readableCookie = by(/^cookies\.flags$/, (f) => /HttpOnly/.test(f.title));
  if (sinks.length && (weakCsp.length || readableCookie.length)) {
    const steps: PathStep[] = [weakness(`Code renders HTML from variables: ${names(sinks)}.`, sinks, all)];
    if (weakCsp.length) steps.push(weakness(`The browser isn't told to block injected scripts: ${names(weakCsp)}.`, weakCsp, all));
    if (readableCookie.length) steps.push(weakness(`A session-like cookie is readable by scripts: ${names(readableCookie)}.`, readableCookie, all));
    steps.push({
      kind: "impact",
      text: readableCookie.length
        ? "If attacker-controlled text reaches the sink, an injected script can read the session cookie and act as the user."
        : "If attacker-controlled text reaches the sink, an injected script runs as the user on your site.",
      findingIds: [],
    });
    add({
      id: "xss-session",
      title: "Script injection could take over users' sessions",
      severity: readableCookie.length ? "high" : "medium",
      steps,
      impact: "Actions and data access as any user who views the injected content.",
      breakWith: "Sanitise or escape the HTML at the sink; a strict CSP and HttpOnly cookies limit the damage.",
    });
  }

  // 4. Permissive CORS with credentials + cookies without SameSite → cross-site reading of signed-in data.
  const cors = [...by(/^cors\.reflected-origin$/, (f) => f.severity === "high"), ...by(/^config\.cors-credentials-any$/)];
  const noSameSite = by(/^cookies\.flags$/, (f) => /SameSite/.test(f.title));
  if (cors.length) {
    add({
      id: "cors-read",
      title: "Other websites could read signed-in users' data",
      severity: noSameSite.length ? "high" : "medium",
      steps: [
        { kind: "prerequisite", text: "A signed-in user visits a page the attacker controls.", findingIds: [] },
        weakness(`Cross-origin reads are allowed with credentials: ${names(cors)}.`, cors, all),
        ...(noSameSite.length ? [weakness(`Cookies are sent on cross-site requests by default: ${names(noSameSite)}.`, noSameSite, all)] : []),
        { kind: "impact", text: "The attacker's page reads responses meant only for that user.", findingIds: [] },
      ],
      impact: "Disclosure of any data the user's session can read.",
      breakWith: "Allow only your own origins when credentials are enabled.",
    });
  }

  // 5. Code route without a visible check + the live site answering the same route signed out.
  const codeOpen = by(/^map\.(route-no-auth|read-no-auth|object-access)$/);
  const liveOpen = by(/^surface\.api-/);
  for (const c of codeOpen) {
    const route = getRouteOf(c);
    if (!route) continue;
    const matches = liveOpen.filter((l) => {
      const p = pathPart(l.location);
      return p ? routeMatches(route, p) : false;
    });
    if (!matches.length) continue;
    add({
      id: `api-open-${c.id}`,
      title: `${route} looks unprotected in the code and answers signed-out requests`,
      severity: "high",
      steps: [
        { kind: "prerequisite", text: "No account needed for the live request.", findingIds: [] },
        weakness(`No visible sign-in or owner check: “${c.title}”.`, [c], all),
        weakness(`The live endpoint returned data without a session: ${names(matches)}.`, matches, all),
        { kind: "impact", text: "Anyone may read (or, for write methods, change) records through the API directly.", findingIds: [] },
      ],
      impact: "Unauthorised access to the records this route serves.",
      breakWith: "Check the signed-in user and record ownership on the server in this route.",
    });
  }

  // 6. Unsigned webhook + billing → forged payment events.
  const hooks = by(/^map\.webhook-no-signature$/);
  if (hooks.length) {
    const billing = hooks.filter((h) => /stripe|billing|payment|checkout|paddle|lemon/i.test(`${h.title} ${h.location}`));
    add({
      id: "webhook-forgery",
      title: billing.length ? "Forged payment events could grant paid access" : "Forged webhook events could change account state",
      severity: billing.length ? "high" : "medium",
      steps: [
        { kind: "prerequisite", text: "The attacker learns the webhook URL (often guessable, e.g. /api/stripe/webhook).", findingIds: [] },
        weakness(`The handler doesn't visibly verify signatures: ${names(hooks)}.`, hooks, all),
        {
          kind: "impact",
          text: billing.length ? "A forged “payment succeeded” event could activate a subscription or add credit without paying." : "Forged events are processed as if they came from the provider.",
          findingIds: [],
        },
      ],
      impact: billing.length ? "Free paid features or credit; incorrect billing records." : "Unauthorised state changes.",
      breakWith: "Verify the provider's signature over the raw body before handling the event.",
    });
  }

  // 7. Mass assignment on routes that write user/account records → self-promotion.
  const mass = by(/^map\.mass-assignment$/);
  if (mass.length) {
    add({
      id: "mass-assignment",
      title: "Users could change protected fields such as their role or plan",
      severity: mass.some((m) => /user|account|profile|member|team|role|plan|subscription/i.test(`${m.title} ${m.location}`)) ? "high" : "medium",
      steps: [
        { kind: "prerequisite", text: "A regular account that can call the route.", findingIds: [] },
        weakness(`Request bodies are written to the database as-is: ${names(mass)}.`, mass, all),
        { kind: "impact", text: "Extra fields in the request (role, plan, owner, balance) are saved if the table has them.", findingIds: [] },
      ],
      impact: "Privilege escalation or free upgrades, depending on the table's columns.",
      breakWith: "Write only an allow-listed set of fields.",
    });
  }

  // 8. Table without RLS in an app whose browser code holds the public database key.
  const noRls = by(/^config\.rls-disabled$/);
  if (noRls.length) {
    add({
      id: "rls-open",
      title: "Anyone with the public database key could read or change unprotected tables",
      severity: "critical",
      steps: [
        { kind: "prerequisite", text: "The public (anon) key, which Supabase apps ship to every browser.", findingIds: [] },
        weakness(`Tables without row level security: ${names(noRls)}.`, noRls, all),
        { kind: "impact", text: "The auto-generated API serves these tables to anyone with that key, unless RLS was enabled outside the SQL given.", findingIds: [] },
      ],
      impact: "Full read and write access to those tables.",
      breakWith: "Enable row level security on each table and add owner-based policies.",
    });
  }

  // 9. Redirect parameters + sign-in flows → phishing after sign-in.
  const redirects = [...by(/^code\.open-redirect$/), ...by(/^surface\.redirect-param$/)];
  if (redirects.length && redirects.some((r) => r.rule_id === "code.open-redirect")) {
    add({
      id: "open-redirect",
      title: "A redirect parameter could send users to a look-alike site",
      severity: "medium",
      steps: [
        { kind: "prerequisite", text: "The victim clicks a link to your real domain crafted by the attacker.", findingIds: [] },
        weakness(`Redirect targets come from the request: ${names(redirects)}.`, redirects, all),
        { kind: "impact", text: "After signing in on your real site, the user lands on the attacker's page (credential phishing, or token leakage in OAuth flows).", findingIds: [] },
      ],
      impact: "Phishing that starts on your trusted domain.",
      breakWith: "Allow only relative paths or a list of your own hosts as redirect targets.",
    });
  }

  // 10. Injection attempts in logs aimed at code that builds queries from strings.
  const sqlCode = by(/^(code\.sql-injection|code\.sql-concat|py\.sql-format|php\.sql-input)$/);
  const sqlAttempts = by(/^web\.payload-sqli$/);
  if (sqlCode.length && sqlAttempts.length) {
    add({
      id: "sqli-attempts",
      title: "Logged injection attempts target code that builds SQL from strings",
      severity: "high",
      steps: [
        weakness(`Queries are built from variables: ${names(sqlCode)}.`, sqlCode, all),
        weakness(`The logs show injection attempts: ${names(sqlAttempts)}.`, sqlAttempts, all),
        { kind: "impact", text: "If an attempt reached that code with a usable input, data could be read or changed. The logs don't show whether any succeeded.", findingIds: [] },
      ],
      impact: "Database disclosure or tampering if exploitable.",
      breakWith: "Use parameterised queries in the flagged code.",
    });
  }

  return paths.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.status === b.status ? 0 : a.status === "steps_confirmed" ? -1 : 1));
}
