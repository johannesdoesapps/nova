import { attackPaths, type AttackPath } from "../attack-paths";
import { correlate } from "../correlate";
import type { FindingLike } from "../details";
import { cvesIn } from "../hunt/intel";
import type { Asset, AegisFinding } from "./model";
import { linkedSet, OPEN } from "./model";

/**
 * Cross-agent attack paths: hypotheses about how weaknesses found by different agents could combine. Every step
 * links to the findings it rests on, and every relationship says how it was established — the same route, assets
 * you linked, or merely the same asset name (weak). No path is ever reproduced (there's no authorised red-team
 * capability), so none is a confirmed compromise; each lists the benign explanations, what would raise or lower
 * confidence, the mitigation that breaks it, and how to validate the fix.
 */

export interface PathRelation {
  between: [string, string];
  basis: "same route" | "linked assets (declared)" | "same asset" | "not linked (assumed)";
  detail: string;
}

export interface AegisPath {
  id: string;
  title: string;
  source: "single-domain" | "cross-agent";
  agents: string[];
  assets: string[];
  identities: string[];
  steps: { kind: "prerequisite" | "weakness" | "observation" | "impact"; text: string; findingIds: string[] }[];
  relations: PathRelation[];
  impact: string;
  reproduced: false;
  reproducedNote: string;
  confidence: "low" | "medium" | "high";
  confidenceBasis: string;
  alternatives: string[];
  mitigations: string[];
  validation: string[];
  severity: string;
  findingIds: string[];
}

const NOT_REPRODUCED = "Not reproduced: Orbis has no authorised attack-simulation capability, so this path is a hypothesis built from recorded findings.";
const live = (fs: AegisFinding[]) => fs.filter((f) => OPEN.has(f.status) && !f.duplicate_of);

function relation(assets: Asset[], a: AegisFinding, b: AegisFinding): PathRelation {
  if (a.asset === b.asset) return { between: [a.id, b.id], basis: "same asset", detail: `Both on ${a.asset}.` };
  if (linkedSet(assets, a.asset).has(b.asset)) return { between: [a.id, b.id], basis: "linked assets (declared)", detail: `You linked ${a.asset} and ${b.asset}.` };
  return {
    between: [a.id, b.id],
    basis: "not linked (assumed)",
    detail: `${a.asset} and ${b.asset} aren't linked; link them on the Assets tab if they're the same system, otherwise this path doesn't apply.`,
  };
}

/** Wrap the single-domain paths (Sentinel/Code Guardian chains) in the same shape. */
function fromBase(p: AttackPath, byId: Map<string, AegisFinding>): AegisPath {
  const fs = p.findingIds.map((id) => byId.get(id)).filter((f): f is AegisFinding => !!f);
  return {
    id: `base:${p.id}`,
    title: p.title,
    source: "single-domain",
    agents: [...new Set(fs.map((f) => f.agent))],
    assets: [...new Set(fs.map((f) => f.asset))],
    identities: [],
    steps: p.steps.map((s) => ({ kind: s.kind, text: s.text, findingIds: s.findingIds })),
    relations: [],
    impact: p.impact,
    reproduced: false,
    reproducedNote: NOT_REPRODUCED,
    confidence: p.status === "steps_confirmed" ? "medium" : "low",
    confidenceBasis: p.status === "steps_confirmed" ? "Every weakness in the chain was observed directly; the chain itself wasn't executed." : "At least one step is unverified.",
    alternatives: ["Each weakness may be mitigated by a control Orbis can't see (a WAF rule, a gateway, network restrictions)."],
    mitigations: [p.breakWith],
    validation: ["After fixing, re-check each finding in the path from its page; the path disappears when any step is no longer detected."],
    severity: p.severity,
    findingIds: p.findingIds,
  };
}

export function aegisPaths(findings: AegisFinding[], assets: Asset[], opts: { kev: Set<string> } = { kev: new Set() }): AegisPath[] {
  const fs = live(findings);
  const byId = new Map(fs.map((f) => [f.id, f]));
  const out: AegisPath[] = attackPaths(fs as unknown as FindingLike[]).map((p) => fromBase(p, byId));
  const rule = (re: RegExp) => fs.filter((f) => re.test(f.rule_id));

  // 1. A weakness on a route that logs show being attacked (beyond SQL injection, which the base engine covers).
  const pairs = correlate(fs.map((f) => ({ id: f.id, agent: f.agent, rule_id: f.rule_id, title: f.title, location: f.location, evidence: f.evidence }))).pairs;
  for (const [a, b] of pairs) {
    const x = byId.get(a);
    const y = byId.get(b);
    if (!x || !y || x.agent === y.agent) continue;
    const weak = x.agent === "threat_hunter" ? y : x;
    const attempt = x.agent === "threat_hunter" ? x : y;
    if (/sql/.test(weak.rule_id)) continue;
    const rel: PathRelation = { between: [weak.id, attempt.id], basis: "same route", detail: `The attempts in the logs target the location of "${weak.title}".` };
    out.push({
      id: `probe:${weak.id}:${attempt.id}`,
      title: `"${weak.title}" is being probed`,
      source: "cross-agent",
      agents: [weak.agent, attempt.agent],
      assets: [...new Set([weak.asset, attempt.asset])],
      identities: [],
      steps: [
        { kind: "weakness", text: weak.title, findingIds: [weak.id] },
        { kind: "observation", text: `Attack attempts against the same location: ${attempt.title}`, findingIds: [attempt.id] },
        { kind: "impact", text: "If an attempt succeeded, the weakness's impact applies (see the finding).", findingIds: [] },
      ],
      relations: [rel],
      impact: `Exploitation of ${weak.title.toLowerCase()} by someone already trying.`,
      reproduced: false,
      reproducedNote: NOT_REPRODUCED,
      confidence: "medium",
      confidenceBasis: "Same location in code/site findings and in the logs; whether any attempt succeeded isn't shown.",
      alternatives: ["Automated internet-wide scanning that tries every site the same way.", "The weakness may not be reachable with the payloads used."],
      mitigations: [weak.remediation.slice(0, 300) || "Fix the weakness first.", "Block or rate-limit the sources of the attempts while the fix ships."],
      validation: ["Re-check the weakness after the fix.", "Hunt newer logs for the same attempts and check their responses (errors rather than 2xx)."],
      severity: weak.severity,
      findingIds: [weak.id, attempt.id],
    });
  }

  // 2. An exposed credential, and suspicious identity or cloud activity on the same or a linked system.
  const secrets = rule(/^(secret\.|exposure\.(env-file|aws-credentials|config-backup)|surface\.client-secret)/);
  const identity = rule(/^(auth\.success-after-failures|auth\.new-source|cloud\.root-activity|persist\.credential-added|priv\.admin-grant|auth\.password-spray)/);
  for (const s of secrets.slice(0, 5)) {
    const hits = identity.filter((i) => linkedSet(assets, s.asset).has(i.asset) || i.asset === s.asset);
    const unlinked = hits.length ? [] : identity.slice(0, 2);
    const use = hits.length ? hits.slice(0, 3) : unlinked;
    if (!use.length) continue;
    const rels = use.map((i) => relation(assets, s, i));
    out.push({
      id: `cred:${s.id}`,
      title: `An exposed credential and suspicious identity activity${hits.length ? "" : " (on systems not linked)"}`,
      source: "cross-agent",
      agents: [...new Set([s.agent, ...use.map((u) => u.agent)])],
      assets: [...new Set([s.asset, ...use.map((u) => u.asset)])],
      identities: [],
      steps: [
        { kind: "weakness", text: s.title, findingIds: [s.id] },
        ...use.map((u) => ({ kind: "observation" as const, text: u.title, findingIds: [u.id] })),
        { kind: "impact", text: "If the exposed credential is the one being used, whoever found it has that account's access.", findingIds: [] },
      ],
      relations: rels,
      impact: "Account or service access with the leaked credential's permissions.",
      reproduced: false,
      reproducedNote: NOT_REPRODUCED,
      confidence: hits.length ? "medium" : "low",
      confidenceBasis: hits.length
        ? "Both are on the same or linked systems; Orbis can't tell whether the exposed secret is the credential that was used."
        : "The systems aren't linked, so the connection is only a possibility.",
      alternatives: ["The suspicious activity may come from a different credential or a legitimate change.", "The exposed value may be a test key or already revoked."],
      mitigations: [
        "Rotate the exposed credential now and remove it from the code/site and its history.",
        "Review the activity in the identity investigation and end sessions for the accounts involved.",
      ],
      validation: ["Re-check the exposure finding after removal.", "Confirm the old credential is rejected (with the provider) and hunt newer logs for its use."],
      severity: "high",
      findingIds: [s.id, ...use.map((u) => u.id)],
    });
  }

  // 3. A known-exploited dependency on a system whose traffic shows attacks.
  const kevDeps = rule(/^deps\./).filter((f) => cvesIn(`${f.title} ${f.description}`).some((c) => opts.kev.has(c)));
  const webAttacks = rule(/^(web\.payload|web\.scanning|exec\.|persist\.)/);
  for (const d of kevDeps.slice(0, 5)) {
    const hits = webAttacks.filter((w) => linkedSet(assets, d.asset).has(w.asset));
    if (!hits.length) continue;
    out.push({
      id: `kev:${d.id}`,
      title: `A dependency with a known-exploited vulnerability, and attack activity on a linked system`,
      source: "cross-agent",
      agents: [d.agent, ...new Set(hits.map((h) => h.agent))],
      assets: [...new Set([d.asset, ...hits.map((h) => h.asset)])],
      identities: [],
      steps: [
        { kind: "weakness", text: d.title, findingIds: [d.id] },
        { kind: "prerequisite", text: "The vulnerable code path must be reachable in your deployment (not checked).", findingIds: [] },
        ...hits.slice(0, 3).map((h) => ({ kind: "observation" as const, text: h.title, findingIds: [h.id] })),
      ],
      relations: hits.slice(0, 3).map((h) => relation(assets, d, h)),
      impact: "Depends on the vulnerability (see the advisory); known-exploited issues are being used by attackers somewhere.",
      reproduced: false,
      reproducedNote: NOT_REPRODUCED,
      confidence: "low",
      confidenceBasis: "An affected version is installed and the system is under attack, but neither the vulnerable function's use nor the attack's target was matched.",
      alternatives: ["The vulnerable function may not be used by your code.", "The attack activity may target something else entirely."],
      mitigations: ["Upgrade to a fixed version (check the advisory) and redeploy.", "Until then, apply the advisory's mitigations."],
      validation: ["Re-audit the repository: the dependency finding should be marked not detected.", "Hunt newer logs for the same activity."],
      severity: d.severity,
      findingIds: [d.id, ...hits.slice(0, 3).map((h) => h.id)],
    });
  }

  // 4. Monitoring switched off where serious weaknesses are open: an incident would be harder to detect.
  const blind = rule(/^evasion\./);
  const serious = fs.filter((f) => (f.severity === "critical" || f.severity === "high") && !/^evasion\./.test(f.rule_id) && f.agent !== "threat_hunter");
  for (const b of blind.slice(0, 3)) {
    const near = serious.filter((s) => linkedSet(assets, b.asset).has(s.asset));
    if (!near.length) continue;
    out.push({
      id: `blind:${b.id}`,
      title: "Logging or monitoring was switched off on a system with open serious weaknesses",
      source: "cross-agent",
      agents: [b.agent, ...new Set(near.map((n) => n.agent))],
      assets: [...new Set([b.asset, ...near.map((n) => n.asset)])],
      identities: [],
      steps: [
        { kind: "observation", text: b.title, findingIds: [b.id] },
        ...near.slice(0, 3).map((n) => ({ kind: "weakness" as const, text: n.title, findingIds: [n.id] })),
        { kind: "impact", text: "Exploitation of these weaknesses after the change would leave little or no trace.", findingIds: [] },
      ],
      relations: near.slice(0, 3).map((n) => relation(assets, b, n)),
      impact: "Reduced ability to detect and investigate an incident.",
      reproduced: false,
      reproducedNote: NOT_REPRODUCED,
      confidence: "medium",
      confidenceBasis: "The logging change was observed in logs; the weaknesses were observed separately. The combination is a detection gap, not evidence of an attack.",
      alternatives: ["The change may have been an approved maintenance action."],
      mitigations: ["Turn logging back on and protect its configuration from the accounts that can change it.", "Fix the open weaknesses."],
      validation: ["Upload fresh logs to Threat Hunter and confirm events are flowing.", "Re-check the weaknesses."],
      severity: "high",
      findingIds: [b.id, ...near.slice(0, 3).map((n) => n.id)],
    });
  }

  // 5. Several low-severity weaknesses on one website that combine into account takeover by script injection.
  for (const asset of new Set(fs.map((f) => f.asset))) {
    const on = fs.filter((f) => linkedSet(assets, asset).has(f.asset));
    const csp = on.filter((f) => /^headers\.csp/.test(f.rule_id));
    const cookie = on.filter((f) => /^cookies\./.test(f.rule_id));
    const sink = on.filter((f) => /^code\.(inner-html|dangerously-set-html)|^php\.echo-input/.test(f.rule_id));
    if (!csp.length || !cookie.length || !sink.length || out.some((p) => p.id === "base:xss-session")) continue;
    out.push({
      id: `combo:${asset}`,
      title: "Low-severity weaknesses that together enable session theft",
      source: "cross-agent",
      agents: [...new Set([...csp, ...cookie, ...sink].map((f) => f.agent))],
      assets: [...new Set([...csp, ...cookie, ...sink].map((f) => f.asset))],
      identities: [],
      steps: [
        { kind: "weakness", text: `Code writes unescaped HTML: ${sink[0]!.title}`, findingIds: sink.slice(0, 2).map((f) => f.id) },
        { kind: "weakness", text: `No effective Content-Security-Policy: ${csp[0]!.title}`, findingIds: csp.slice(0, 1).map((f) => f.id) },
        { kind: "weakness", text: `Session cookie readable by scripts: ${cookie[0]!.title}`, findingIds: cookie.slice(0, 1).map((f) => f.id) },
        { kind: "impact", text: "Injected script could read the session cookie and take over accounts.", findingIds: [] },
      ],
      relations: [relation(assets, sink[0]!, csp[0]!), relation(assets, csp[0]!, cookie[0]!)],
      impact: "Account takeover.",
      reproduced: false,
      reproducedNote: NOT_REPRODUCED,
      confidence: "low",
      confidenceBasis: "Each weakness was observed, but whether attacker-controlled data reaches the unescaped HTML wasn't traced.",
      alternatives: ["The HTML may only ever contain trusted, static content."],
      mitigations: ["Mark session cookies HttpOnly (breaks the chain cheapest).", "Add a restrictive Content-Security-Policy.", "Escape or sanitise the HTML."],
      validation: ["Re-check the cookie and header findings on the live site.", "Re-audit the code."],
      severity: "high",
      findingIds: [...sink.slice(0, 2), ...csp.slice(0, 1), ...cookie.slice(0, 1)].map((f) => f.id),
    });
  }
  const SEV: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  return out.sort((a, b) => (SEV[a.severity] ?? 5) - (SEV[b.severity] ?? 5) || (a.confidence === "medium" ? -1 : 1) - (b.confidence === "medium" ? -1 : 1));
}
