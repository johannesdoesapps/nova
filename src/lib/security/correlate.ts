import { routeMatches } from "./attack-paths";

/**
 * Links findings from different agents that plausibly concern the same
 * weakness. A link is a lead for the user to check, not proof.
 */
export interface CorrelationInput {
  id: string;
  agent: string;
  rule_id: string;
  title: string;
  location: string | null;
  evidence: { source: string; detail: string }[];
}

const KIND_BY_RULE: Record<string, string> = {
  "code.sql-injection": "sqli",
  "code.sql-concat": "sqli",
  "py.sql-format": "sqli",
  "php.sql-input": "sqli",
  "code.dangerously-set-html": "xss",
  "code.inner-html": "xss",
  "php.echo-input": "xss",
  "headers.csp-missing": "xss",
  "headers.csp-unsafe-inline": "xss",
  "headers.csp-wildcard-scripts": "xss",
  "code.path-traversal": "traversal",
  "code.command-injection": "cmdi",
  "py.shell-true": "cmdi",
  "py.os-system": "cmdi",
};

export function correlate(findings: CorrelationInput[]): { pairs: [string, string][]; notes: string[] } {
  const pairs: [string, string][] = [];
  const notes: string[] = [];
  const attacks = findings.filter((f) => f.rule_id.startsWith("web.payload-"));
  const scans = findings.filter((f) => f.rule_id === "web.scanning");
  for (const f of findings) {
    const kind = KIND_BY_RULE[f.rule_id];
    if (kind) {
      for (const a of attacks.filter((x) => x.rule_id === `web.payload-${kind}`)) {
        pairs.push([f.id, a.id]);
        notes.push(`"${f.title}" (${f.agent}) may be the target of "${a.title}" (threat_hunter).`);
      }
    }
    if (f.rule_id.startsWith("exposure.") && f.location) {
      const path = (() => {
        try {
          return new URL(f.location).pathname;
        } catch {
          return null;
        }
      })();
      if (!path) continue;
      for (const s of scans.filter((x) => x.evidence.some((e) => e.detail.includes(path)))) {
        pairs.push([f.id, s.id]);
        notes.push(`The exposed ${path} found by Sentinel was requested in the logs (${s.title}).`);
      }
    }
  }
  // Code that looks unprotected ↔ the live site answering the same route without a session.
  const liveApi = findings.filter((f) => f.rule_id.startsWith("surface.api-") && f.location);
  for (const c of findings.filter((f) => /^map\.(route-no-auth|read-no-auth|object-access)$/.test(f.rule_id))) {
    // Live checks are signed-out GETs, so they only say something about GET (or any-method) handlers.
    const m = /^(GET|POST|PUT|PATCH|DELETE|ANY) (\S+)/.exec(c.evidence[0]?.detail ?? "");
    if (!m || (m[1] !== "GET" && m[1] !== "ANY")) continue;
    const route = m[2]!;
    for (const l of liveApi) {
      let path: string;
      try {
        path = new URL(l.location!).pathname;
      } catch {
        continue;
      }
      if (!routeMatches(route, path)) continue;
      pairs.push([c.id, l.id]);
      notes.push(`"${c.title}" (code) matches ${path}, which answered a signed-out request on the live site.`);
    }
  }
  // The same key in the code and in JavaScript served to browsers (compared in masked form only).
  const masked = (f: CorrelationInput) => f.evidence.flatMap((e) => e.detail.match(/[A-Za-z0-9_\-]{4}•{3,}[A-Za-z0-9_\-]{2}/g) ?? []);
  const served = findings.filter((f) => f.rule_id === "surface.client-secret");
  for (const c of findings.filter((f) => f.rule_id.startsWith("secret."))) {
    const keys = new Set(masked(c));
    for (const s of served.filter((x) => masked(x).some((k) => keys.has(k)))) {
      pairs.push([c.id, s.id]);
      notes.push(`The secret in ${c.location ?? "the code"} is also served to browsers (${s.location}).`);
    }
  }
  return { pairs, notes };
}
