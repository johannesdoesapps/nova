/**
 * What a finding means and how sure we are, derived from what was actually recorded (rule, evidence,
 * confidence, re-checks and related findings from other sources) — never from new claims. Used by the
 * finding page, the audit report and the release gate.
 *
 *  - classify(): Confirmed / Likely / Needs verification / Informational / False positive.
 *  - findingDetails(): reproduction steps, expected vs observed behaviour, impact, the attacker's
 *    starting point, root cause and how to verify a fix, from a per-rule knowledge base.
 *  - investigation(): the nine investigation steps with what was done for each, and what wasn't.
 */

import { defectRuleById } from "./guardian/defects";

export const CLASSIFICATIONS = ["confirmed", "likely", "needs_verification", "informational", "false_positive"] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export const CLASSIFICATION_LABEL: Record<Classification, string> = {
  confirmed: "Confirmed",
  likely: "Likely",
  needs_verification: "Needs verification",
  informational: "Informational",
  false_positive: "False positive",
};

export interface FindingLike {
  id?: string;
  agent: string;
  rule_id: string;
  title: string;
  description: string;
  severity: string;
  confidence: string;
  asset: string;
  location: string | null;
  evidence: { source: string; detail: string }[];
  evidence_source: string;
  remediation: string;
  status: string;
  verification: string;
  verification_note?: string | null;
  related?: string[];
  patch?: string | null;
  tests?: string | null;
}

/** A different agent or tool independently pointing at the same weakness. */
export function corroborating(f: FindingLike, others: FindingLike[]): FindingLike[] {
  const rel = new Set(f.related ?? []);
  return others.filter((o) => o.id && rel.has(o.id) && (o.agent !== f.agent || o.evidence_source !== f.evidence_source));
}

export function classify(f: FindingLike, others: FindingLike[] = []): Classification {
  if (f.status === "false_positive") return "false_positive";
  if (f.severity === "info") return "informational";
  if (f.confidence === "confirmed") return "confirmed";
  if (f.confidence === "firm") return "likely";
  // A tentative lead backed by independent evidence from another source becomes likely, never confirmed.
  return corroborating(f, others).length ? "likely" : "needs_verification";
}

export interface FindingDetails {
  reproduce: string[];
  expected: string;
  observed: string;
  impact: string;
  /** What an attacker needs before they can use this. */
  privileges: string;
  rootCause: string;
  verify: string[];
  /** CVSS 3.1 base vector where the rule's impact is well-defined; otherwise null (no made-up scores). */
  cvss: string | null;
}

type Kb = Omit<FindingDetails, "observed" | "reproduce" | "verify"> & { reproduce: (f: FindingLike) => string[]; verify: (f: FindingLike) => string[] };

const url = (f: FindingLike) => f.location ?? f.asset;
const firstEvidence = (f: FindingLike) => (f.evidence[0] ? `${f.evidence[0].source}: ${f.evidence[0].detail}` : "See the evidence.");
const curlHeaders = (f: FindingLike) => [`Request the page with response headers shown, e.g. curl -sI ${url(f)}`, "Look for the header named in the finding."];
const rescan = "Re-check this finding from its page (it repeats the same read-only request) and confirm it's marked “not detected”.";
const codeLoc = (f: FindingLike) => `Open ${f.location ?? "the file in the evidence"} and read the flagged code and where its inputs come from.`;
const reaudit = "Run Audit code again on the fixed code under the same project name; the finding should be marked “not detected”.";

const KB: [RegExp, Kb][] = [
  [
    /^transport\./,
    {
      reproduce: (f) => [`Open ${url(f)} in a browser or with curl -sI.`, "Check the certificate, redirect status or Location header shown in the evidence."],
      expected: "Every request is served over valid HTTPS, and plain HTTP redirects straight to HTTPS.",
      impact: "Someone on the same network (public Wi-Fi, a compromised router) can read or alter traffic.",
      privileges: "A network position between the visitor and the site.",
      rootCause: "Web server or hosting configuration doesn't enforce HTTPS.",
      verify: () => [rescan],
      cvss: null,
    },
  ],
  [
    /^headers\.hsts/,
    {
      reproduce: curlHeaders,
      expected: "Strict-Transport-Security with max-age of at least six months.",
      impact: "First visits or visits after expiry can be downgraded to plain HTTP by a network attacker.",
      privileges: "A network position between the visitor and the site.",
      rootCause: "The HSTS header isn't configured at the server, CDN or framework level.",
      verify: () => [rescan],
      cvss: null,
    },
  ],
  [
    /^headers\.csp|^headers\.clickjacking|^headers\.nosniff|^headers\.referrer/,
    {
      reproduce: curlHeaders,
      expected: "The security header is present with a restrictive value.",
      impact: "Defence in depth: it makes another bug (cross-site scripting, clickjacking, content sniffing) easier to exploit; it isn't exploitable alone.",
      privileges: "None for the visitor-facing weakness; exploitation needs a second bug or a user to visit an attacker's page.",
      rootCause: "Security headers aren't set centrally (server, CDN or framework headers config).",
      verify: () => [rescan],
      cvss: null,
    },
  ],
  [
    /^cookies\./,
    {
      reproduce: (f) => [`Request ${url(f)} and read the Set-Cookie headers (curl -sI or the browser's devtools → Application → Cookies).`, "Check the attributes listed as missing."],
      expected: "Session and authentication cookies carry Secure, HttpOnly and SameSite.",
      impact: "Missing HttpOnly lets injected scripts read the session; missing Secure sends it over HTTP; missing SameSite weakens cross-site request protection.",
      privileges: "A second weakness (script injection or a network position), or the victim visiting an attacker's page.",
      rootCause: "Cookie options aren't set where the cookie is created.",
      verify: () => [rescan],
      cvss: null,
    },
  ],
  [
    /^cors\./,
    {
      reproduce: (f) => [
        `Send a request to ${url(f)} with the header Origin: https://example.invalid (curl -sI -H 'Origin: https://example.invalid' …).`,
        "Check whether Access-Control-Allow-Origin echoes it back, and whether Allow-Credentials is true.",
      ],
      expected: "Only your own origins are allowed, and never a reflected arbitrary origin together with credentials.",
      impact: "With credentials allowed, any website a signed-in user visits can read their responses.",
      privileges: "A signed-in victim visiting the attacker's page.",
      rootCause: "The CORS configuration reflects the request Origin instead of checking an allow-list.",
      verify: () => [rescan],
      cvss: "CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:N/A:N",
    },
  ],
  [
    /^exposure\./,
    {
      reproduce: (f) => [`Request ${url(f)} (an ordinary GET).`, "The response is the file itself rather than a not-found page; the evidence shows its first characters with values hidden."],
      expected: "The path returns 404 or 403.",
      impact: "Secrets or source code in the file give direct access to databases, services or your code's weak spots.",
      privileges: "None — anyone who requests the URL.",
      rootCause: "Deployment includes files that should never be in the public web root, and the server doesn't block dotfiles.",
      verify: () => [rescan, "Rotate every secret the file contained — removing the file doesn't undo the exposure."],
      cvss: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N",
    },
  ],
  [
    /^disclosure\.|^policy\.|^content\./,
    {
      reproduce: (f) => [`Request ${url(f)} and look at the part shown in the evidence.`],
      expected: "No version details, no insecure sub-resources, and a published security contact.",
      impact: "Helps attackers target known issues, or weakens page integrity; low on its own.",
      privileges: "None.",
      rootCause: "Default server or page configuration.",
      verify: () => [rescan],
      cvss: null,
    },
  ],
  [
    /^surface\.client-secret/,
    {
      reproduce: (f) => [`Open ${url(f)} (a JavaScript file the site serves to every visitor).`, "Search it for the value shown masked in the evidence."],
      expected: "Only public, restricted keys (for example a publishable or anon key) appear in browser code.",
      impact: "Anyone can copy the key from the browser and use it with the privileges it grants.",
      privileges: "None — the file is public.",
      rootCause: "A server-only secret is referenced from client-side code or a public environment variable (NEXT_PUBLIC_…, VITE_…).",
      verify: () => [rescan, "Rotate the key; it must be treated as leaked."],
      cvss: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N",
    },
  ],
  [
    /^surface\.source-map/,
    {
      reproduce: (f) => [`Request ${url(f)}.`, "It returns JSON with a “sources” list, i.e. the original source code layout."],
      expected: "Source maps aren't public in production (or only uploaded to your error tracker).",
      impact: "Makes it much easier to read your front-end code, find hidden routes and spot weaknesses; not a vulnerability on its own.",
      privileges: "None.",
      rootCause: "The build publishes .map files alongside the bundles.",
      verify: () => [rescan],
      cvss: null,
    },
  ],
  [
    /^surface\.third-party-script/,
    {
      reproduce: (f) => [
        `View the HTML of ${f.evidence[0]?.source.replace(/^HTML of /, "") ?? url(f)} and find the script tag in the evidence.`,
        "It loads from another host with no integrity attribute.",
      ],
      expected: "Third-party scripts are pinned with Subresource Integrity, or served from your own domain.",
      impact: "If that provider or CDN is compromised, the script runs with full access to your pages and users' sessions.",
      privileges: "Control of the third-party host (a supply-chain compromise).",
      rootCause: "Scripts included by URL without integrity pinning.",
      verify: () => [rescan],
      cvss: null,
    },
  ],
  [
    /^surface\.form-|^surface\.password-/,
    {
      reproduce: (f) => [`Open ${f.location ?? "the page in the evidence"} and inspect the form.`, "Its action or the page itself uses plain http://."],
      expected: "Forms and pages that handle credentials or personal data use HTTPS only.",
      impact: "Submitted data, including passwords, can be read on the network.",
      privileges: "A network position between the visitor and the site.",
      rootCause: "Hard-coded http:// action URL or a page served without HTTPS.",
      verify: () => [rescan],
      cvss: null,
    },
  ],
  [
    /^surface\.error-disclosure/,
    {
      reproduce: (f) => [`Request ${url(f)} (a page that doesn't exist).`, "The error page shows internal details (stack trace, file paths or framework debug output)."],
      expected: "A generic error page with no internal details.",
      impact: "Reveals file paths, library versions and code structure that help plan attacks; debug pages can expose settings.",
      privileges: "None.",
      rootCause: "Debug mode or verbose error handling enabled in production.",
      verify: () => [rescan],
      cvss: null,
    },
  ],
  [
    /^surface\.api-/,
    {
      reproduce: (f) => [`Request ${url(f)} without signing in (a plain GET, e.g. curl -s).`, "Compare the response with what a signed-out visitor should see."],
      expected: "Endpoints that return personal data answer 401/403 to signed-out requests.",
      impact: "If the data isn't meant to be public, anyone can read it.",
      privileges: "None.",
      rootCause: "The endpoint doesn't check the caller, or returns more fields than needed.",
      verify: () => [rescan, "Add a test that a signed-out request gets 401/403."],
      cvss: null,
    },
  ],
  [
    /^surface\./,
    {
      reproduce: (f) => [`Open ${url(f)} and look at what the evidence shows.`],
      expected: "See the remediation.",
      impact: "A lead for further review; low on its own.",
      privileges: "Depends on the related weakness.",
      rootCause: "See the description.",
      verify: () => [rescan],
      cvss: null,
    },
  ],
  [
    /^secret\./,
    {
      reproduce: (f) => [codeLoc(f), "The value is masked in the evidence; check git history too (git log -S '<first characters>')."],
      expected: "Secrets are loaded from environment variables or a secret manager, never committed.",
      impact: "Anyone with read access to the code (or its history) can use the credential with all its privileges.",
      privileges: "Read access to the repository, a leaked copy, or a public bundle that includes it.",
      rootCause: "The secret was written into source instead of configuration.",
      verify: () => [reaudit, "Rotate the credential and confirm the old one no longer works."],
      cvss: null,
    },
  ],
  [
    /^deps\./,
    {
      reproduce: (f) => [
        `Check the installed version in your lockfile (${f.location ?? "package-lock.json / requirements.txt"}).`,
        "Compare it with the fixed versions in the advisory linked under References.",
      ],
      expected: "No dependency has a known vulnerability affecting the version in use, or the vulnerable code path is confirmed unreachable.",
      impact: "Depends on the advisory and whether your code uses the affected function; the severity shown is the advisory's.",
      privileges: "See the advisory.",
      rootCause: "An outdated dependency version.",
      verify: () => ["Upgrade to a fixed version, run your tests, then run Audit code again; the finding should be marked “not detected”."],
      cvss: null,
    },
  ],
  [
    /^map\.read-no-auth/,
    {
      reproduce: (f) => [codeLoc(f), "Trace which middleware or wrapper runs before this handler.", `Request the live endpoint without signing in (a plain GET) and compare what comes back with what a signed-out visitor should see.`],
      expected: "Signed-out requests get 401 (or only data meant to be public), and signed-in users get only their own records.",
      impact: "If the data isn't meant to be public, anyone could read it directly from the API.",
      privileges: "None if unprotected.",
      rootCause: "The route returns database data without checking who is asking.",
      verify: () => ["Add a test that a signed-out request gets 401 and another user's records are never returned.", reaudit],
      cvss: null,
    },
  ],
  [
    /^map\.route-no-auth/,
    {
      reproduce: (f) => [
        codeLoc(f),
        "Trace which middleware or wrapper runs before this handler.",
        "In a test environment with a synthetic account, call the route without a session and check the status code.",
      ],
      expected: "Signed-out requests get 401, and signed-in users without permission get 403.",
      impact: "If unprotected, anyone could perform this action directly, without using your pages.",
      privileges: "None if unprotected; otherwise a regular account.",
      rootCause: "Authorisation is enforced in the UI or by convention, not checked on the server for this route.",
      verify: () => ["Add a test that calls the route without a session and expects 401.", reaudit],
      cvss: null,
    },
  ],
  [
    /^map\.object-access/,
    {
      reproduce: (f) => [codeLoc(f), "In a test environment, sign in as synthetic user A, then request a record id that belongs to synthetic user B."],
      expected: "Another user's id returns 404 (or 403), never their data.",
      impact: "Users could read or change each other's records by changing an id.",
      privileges: "A regular account.",
      rootCause: "The query filters by record id only, not by owner, and no row-level rule covers it.",
      verify: () => ["Add a two-user test: user B requesting user A's id gets 404.", reaudit],
      cvss: "CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:N",
    },
  ],
  [
    /^map\.webhook/,
    {
      reproduce: (f) => [codeLoc(f), "In a test environment, send the route a well-formed event with no or a wrong signature header and see whether it's processed."],
      expected: "Requests without a valid signature are rejected with 400/401 before any processing.",
      impact: "Forged events could mark payments as completed, grant credits or change account state.",
      privileges: "Knowing the webhook URL.",
      rootCause: "The handler trusts the request body without verifying the provider's signature.",
      verify: () => ["Add a test that an unsigned event returns 400 and changes nothing.", reaudit],
      cvss: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:H/A:N",
    },
  ],
  [
    /^map\.mass-assignment/,
    {
      reproduce: (f) => [codeLoc(f), "In a test environment, send the request with an extra field the form doesn't have (for example role or plan) and check whether it's saved."],
      expected: "Unknown or protected fields are ignored or rejected.",
      impact: "Users could change protected properties such as their role, plan, owner or balance.",
      privileges: "A regular account (or none, if the route is public).",
      rootCause: "The whole request body is written to the database instead of an allow-listed set of fields.",
      verify: () => ["Add a test that sends a protected field and checks it's unchanged.", reaudit],
      cvss: null,
    },
  ],
  [
    /^map\.server-fetch/,
    {
      reproduce: (f) => [codeLoc(f), "Trace where the URL comes from and what restrictions apply before the request is made."],
      expected: "Only allow-listed hosts are fetched, and private or metadata addresses are blocked at connect time.",
      impact: "Your server could be made to reach internal services or cloud metadata endpoints.",
      privileges: "Whatever access the route requires.",
      rootCause: "A request-supplied URL is fetched without host and address restrictions.",
      verify: () => ["Add a test that a private-address URL is refused.", reaudit],
      cvss: null,
    },
  ],
  [
    /^map\.|^config\./,
    {
      reproduce: (f) => [codeLoc(f)],
      expected: "See the remediation.",
      impact: "See the description.",
      privileges: "Depends on the configuration.",
      rootCause: "Configuration that allows more than intended.",
      verify: () => [reaudit],
      cvss: null,
    },
  ],
  [
    /^(code|py|php|ai)\./,
    {
      reproduce: (f) => [codeLoc(f), "Trace the values used on that line back to their source: do they come from the request, a file or the database?"],
      expected: "Untrusted input is validated and passed through safe APIs (parameterised queries, escaping, allow-lists).",
      impact: "If the input is attacker-controlled, see the description; otherwise the pattern may be harmless.",
      privileges: "Whatever access reaches this code path.",
      rootCause: "Unsafe API use with values that may be untrusted.",
      verify: () => ["Add a unit test with a hostile input value that must be rejected or neutralised.", reaudit],
      cvss: null,
    },
  ],
  [
    /^quality\./,
    {
      reproduce: (f) => [`Open ${f.location ?? "the file in the evidence"} and read the flagged line with its surrounding function.`, defectRuleById(f.rule_id)?.test ?? "Write a test that exercises the failure scenario in the description."],
      expected: "The code behaves correctly in the scenario the description gives (including the edge case).",
      impact: "A correctness or reliability defect: wrong results, crashes or flaky behaviour for the users who hit that path.",
      privileges: "None — this is a code defect, not an attack.",
      rootCause: "A code pattern that's wrong in the situation described (see the finding).",
      verify: () => ["Run the reproducing test: it fails before the fix and passes after.", "Re-run Code Guardian on the fixed repository; the finding should be marked “not detected”."],
      cvss: null,
    },
  ],
  [
    /^compat\./,
    {
      reproduce: () => ["On a clean checkout, run the install the way CI does (`npm ci`), then the build and tests, and note any error or warning about the packages named in the finding."],
      expected: "package.json, the lockfile and the installed packages agree, and every package supports the Node and framework versions you run.",
      impact: "Builds or installs that fail (or differ) between machines, CI and production; runtime errors in code paths that use an incompatible package.",
      privileges: "None — this is a compatibility issue.",
      rootCause: "Dependency declarations, the lockfile and the versions in use have drifted apart.",
      verify: () => ["`npm ci` succeeds on a clean checkout, followed by the build and full test suite.", "Re-run Code Guardian; the finding should be marked “not detected”."],
      cvss: null,
    },
  ],
  [
    /^arch\./,
    {
      reproduce: (f) => [`Open ${f.location ?? "the files in the evidence"} and the other locations listed.`],
      expected: "Modules with clear responsibilities, no import cycles and no copies of the same logic.",
      impact: "Not a defect by itself: it makes changes riskier and bugs easier to introduce. Fix it when you next work in this code, not as an emergency.",
      privileges: "None.",
      rootCause: "Structure that grew without a refactor (see the description).",
      verify: () => ["Run the full test suite after the refactor.", "Re-run Code Guardian; the finding should be marked “not detected”."],
      cvss: null,
    },
  ],
  [
    /^(priv|persist|evasion|exec|cloud|data|dns)\./,
    {
      reproduce: (f) => [`Find the log events cited in the evidence (${f.evidence[0]?.source ?? "the uploaded logs"}).`, "Open the investigation this finding belongs to on its run page to see the related signals and timeline."],
      expected: "The activity matches an approved change, a known job or a known tool.",
      impact: "A behaviour that attackers use at this stage of an intrusion. Logs alone usually can't prove intent: check it against change records and with the person or team responsible.",
      privileges: "Depends on the activity; most of these need an account that already has access.",
      rootCause: "Not determined from logs alone: confirm whether the activity was authorised.",
      verify: () => ["Record the outcome on the investigation (benign, confirmed, contained or resolved) with a note.", "Analyse newer logs to check whether the activity continues."],
      cvss: null,
    },
  ],
  [
    /^web\.|^auth\.|^intel\./,
    {
      reproduce: (f) => [`Find the log lines cited in the evidence (${f.evidence[0]?.source ?? "the uploaded logs"}).`],
      expected: "No successful malicious activity; suspicious attempts are blocked or rate-limited.",
      impact: "Shows attempted (not necessarily successful) attacks; check whether any succeeded.",
      privileges: "Network access to the service.",
      rootCause: "Exposure to automated attack traffic; see the description.",
      verify: () => ["Analyse newer logs after mitigations to see whether the activity continues."],
      cvss: null,
    },
  ],
];

export function findingDetails(f: FindingLike): FindingDetails {
  const kb = KB.find(([re]) => re.test(f.rule_id))?.[1];
  const observed = firstEvidence(f);
  if (!kb)
    return {
      reproduce: [`See the evidence: ${observed}`],
      expected: "See the remediation.",
      observed,
      impact: f.description,
      privileges: "Not determined.",
      rootCause: "Not determined.",
      verify: ["Re-run the agent that produced this finding."],
      cvss: null,
    };
  return { ...kb, reproduce: kb.reproduce(f), verify: kb.verify(f), observed };
}

export interface InvestigationStep {
  id: "detect" | "hypothesize" | "trace" | "test" | "corroborate" | "impact" | "root_cause" | "remediate" | "retest";
  label: string;
  state: "done" | "partial" | "not_done";
  detail: string;
}

const LIVE = /^(orbis:headers|orbis:exposure|orbis:surface)$/;

/** The nine investigation steps, each saying what was actually done. Steps that weren't done say so. */
export function investigation(f: FindingLike, others: FindingLike[] = []): InvestigationStep[] {
  const d = findingDetails(f);
  const corr = corroborating(f, others);
  const live = LIVE.test(f.evidence_source);
  const fromCode = /^orbis:code|^ai-review|^osv/.test(f.evidence_source);
  const retest =
    f.verification === "not_detected"
      ? { state: "done" as const, detail: f.verification_note ?? "A later run checked for it and didn't detect it." }
      : f.verification === "still_present"
        ? { state: "done" as const, detail: f.verification_note ?? "A later run detected it again." }
        : { state: "not_done" as const, detail: "Not re-checked yet." };
  return [
    { id: "detect", label: "Detect", state: "done", detail: `Found by ${toolName(f.evidence_source)}.` },
    { id: "hypothesize", label: "Hypothesis", state: "done", detail: f.description },
    {
      id: "trace",
      label: "Trace",
      state: f.location ? "done" : "partial",
      detail: f.location ? (fromCode ? `Traced to ${f.location}.` : `Observed at ${f.location}.`) : "No precise location recorded.",
    },
    {
      id: "test",
      label: "Test",
      state: live ? "done" : f.agent === "threat_hunter" ? "partial" : "not_done",
      detail: live
        ? "Observed directly in a live, read-only response from the authorised site."
        : f.agent === "threat_hunter"
          ? "Seen in the uploaded logs; whether an attempt succeeded wasn't tested."
          : "Not tested at runtime: this comes from reading the code. Reproduction steps below use a test environment and synthetic accounts.",
    },
    {
      id: "corroborate",
      label: "Corroborate",
      state: corr.length ? "done" : "not_done",
      detail: corr.length ? `Independent evidence: ${corr.map((c) => `“${c.title}” (${toolName(c.evidence_source)})`).join("; ")}.` : "No independent second source yet.",
    },
    { id: "impact", label: "Impact", state: "done", detail: `${d.impact} Attacker needs: ${d.privileges}` },
    { id: "root_cause", label: "Root cause", state: d.rootCause.startsWith("Not determined") ? "not_done" : "done", detail: d.rootCause },
    {
      id: "remediate",
      label: "Remediation",
      state: f.patch ? "done" : f.remediation ? "partial" : "not_done",
      detail: f.patch ? "A patch was proposed (not applied or tested by Orbis)." : f.remediation || "No remediation recorded.",
    },
    { id: "retest", label: "Retest", ...retest },
  ];
}

export function toolName(source: string): string {
  return (
    (
      {
        "orbis:headers": "Sentinel's header & config checks",
        "orbis:exposure": "Sentinel's exposed-file checks",
        "orbis:surface": "Sentinel's site mapping",
        "orbis:code-rules": "Code Guardian's code & secret rules",
        "orbis:code-map": "Code Guardian's application map",
        "osv.dev": "the OSV vulnerability database",
        "ai-review": "AI code review (quote checked against your files)",
        "orbis:log-analyzer": "Threat Hunter's log analyzer",
        abuseipdb: "AbuseIPDB",
      } as Record<string, string>
    )[source] ?? source
  );
}

/**
 * The coding agent's brief for fixing one finding: the smallest change, a regression test, the checks to
 * run, a look at nearby code for the same weakness, and an exact account of what passed, failed or wasn't
 * verified. Unconfirmed findings are checked first and left alone if they aren't real.
 */
export function securityFixTask(f: FindingLike, d: FindingDetails = findingDetails(f)): string {
  return [
    "Fix this security finding with the smallest appropriate change.",
    "",
    `${f.title} (${f.severity}; ${CLASSIFICATION_LABEL[classify(f)]})`,
    `Where: ${f.location ?? f.asset}`,
    `Evidence: ${f.evidence
      .map((e) => `${e.source}: ${e.detail}`)
      .join(" | ")
      .slice(0, 600)}`,
    `Problem: ${f.description}`,
    `Root cause: ${d.rootCause}`,
    `Expected secure behaviour: ${d.expected}`,
    `Suggested fix: ${f.remediation}`,
    "",
    "Steps:",
    classify(f) === "confirmed"
      ? "1. Explain the change you'll make and why it closes the weakness."
      : "1. First check whether the finding is real by reading the code and its callers. If it isn't, say why and change nothing.",
    "2. Make the smallest change that fixes the root cause; don't refactor unrelated code.",
    `3. Add a regression test when the project has a test setup (${d.verify.find((v) => /test/i.test(v)) ?? "a test that fails before the fix and passes after"}).`,
    "4. Run the tests, linting and type checks that exist in the project.",
    "5. Look at nearby and similar code for the same weakness and list any you find (fix them only if they're the same root cause).",
    "6. Report exactly what passed, what failed and what you couldn't verify. Don't call the vulnerability fixed unless a check shows it.",
    "Don't push, deploy or change secrets or infrastructure.",
  ].join("\n");
}
