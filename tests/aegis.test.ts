import { describe, expect, it } from "vitest";
import { duplicateCandidates } from "@/lib/security/aegis/dedupe";
import { buildModel, EMPTY_FACTS, foldAssetFacts, type AegisFinding, type AegisRun, type AssetFacts } from "@/lib/security/aegis/model";
import { aegisPaths } from "@/lib/security/aegis/paths";
import { activeExceptions, prioritise } from "@/lib/security/aegis/risk";
import { ROSTER } from "@/lib/security/aegis/roster";
import { assembleAegis, executiveReport, operationalReport, technicalReport, type AegisEvent, type AegisInput } from "@/lib/security/aegis/state";
import { canTransition, remediations } from "@/lib/security/aegis/workflow";

/**
 * Orbis Aegis evaluation scenarios: prioritisation that keeps severity, confidence and urgency apart, attack
 * paths that stay hypotheses, remediation that's verified only by a re-check after the fix, honest coverage, and
 * unavailable agents shown as unavailable.
 */

let seq = 0;
function finding(p: Partial<AegisFinding>): AegisFinding {
  const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
  return {
    id,
    agent: "code_guardian",
    rule_id: "code.example",
    title: "Example",
    description: "",
    severity: "medium",
    confidence: "firm",
    status: "open",
    verification: "not_verified",
    asset: "github:acme/shop",
    location: "src/a.ts:1",
    evidence: [{ source: "rule", detail: "matched" }],
    evidence_source: "static analysis",
    remediation: "Fix it.",
    duplicate_of: null,
    related: [],
    first_seen: "2026-10-01T00:00:00.000Z",
    last_seen: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    verification_note: null,
    occurrences: 1,
    ...p,
  };
}
const run = (p: Partial<AegisRun>): AegisRun => ({
  id: `run-${++seq}`,
  agent: "code_guardian",
  action: "audit",
  status: "completed",
  asset: "github:acme/shop",
  started_at: "2026-10-20T00:00:00.000Z",
  finished_at: null,
  tools: [],
  stats: {},
  ...p,
});
const facts = (entries: [string, Partial<AssetFacts>][]) => new Map(entries.map(([k, v]) => [k, { ...EMPTY_FACTS, ...v }]));
const NOW = Date.parse("2026-10-24T00:00:00.000Z");

function input(p: Partial<AegisInput>): AegisInput {
  return { findings: [], runs: [], verifiedHosts: [], events: [], kev: { cves: new Map(), available: true, retrievedAt: "2026-10-23" }, abuseIpdb: false, bastion: null, now: NOW, ...p };
}

describe("prioritisation", () => {
  const kevDep = finding({ rule_id: "deps.vulnerable", severity: "critical", confidence: "confirmed", title: "lodash 4.17.0 — CVE-2021-23337" });
  const header = finding({ agent: "sentinel", rule_id: "headers.hsts", severity: "low", asset: "shop.example", location: "https://shop.example/" });
  const tentativeSql = finding({ rule_id: "code.sql-injection", severity: "high", confidence: "tentative", asset: "github:acme/api" });
  const info = finding({ severity: "info", rule_id: "code.note" });
  const accepted = finding({ status: "accepted_risk", severity: "high" });
  const excepted = finding({ severity: "high" });
  const { assets } = buildModel({
    findings: [kevDep, header, tentativeSql, info],
    runs: [],
    verifiedHosts: ["shop.example"],
    facts: facts([["github:acme/shop", { exposure: "internet", criticality: "critical" }]]),
  });
  const ctx = { assets, kev: new Map([["CVE-2021-23337", { ransomware: false }]]), maliciousActivity: new Set<string>(), attempted: new Set<string>(), excepted: new Set([excepted.id]) };
  const { ranked, excluded } = prioritise([kevDep, header, tentativeSql, info, accepted, excepted], ctx);
  const of = (f: AegisFinding) => ranked.find((r) => r.finding.id === f.id)!;

  it("puts a known-exploited, credible weakness on a critical internet-facing asset first, with every reason and its points", () => {
    const r = of(kevDep);
    expect(ranked[0]!.finding.id).toBe(kevDep.id);
    expect(r).toMatchObject({ tier: "immediate", urgency: "now", classification: "confirmed" });
    expect(r.factors.map((x) => x.label)).toEqual([
      "critical severity, confirmed",
      "Asset declared internet-facing",
      "CVE-2021-23337 is in CISA's Known Exploited Vulnerabilities catalogue",
      "Asset declared critical",
      "Touches credentials, authentication, access control or data exposure",
    ]);
    expect(r.points).toBe(r.factors.reduce((n, x) => n + x.points, 0));
  });

  it("keeps severity, confidence and urgency apart: a high-severity tentative lead isn't immediate", () => {
    expect(of(tentativeSql)).toMatchObject({ tier: "priority", classification: "needs_verification", urgency: "this week" });
    expect(of(header)).toMatchObject({ tier: "strategic", urgency: "this quarter" });
    expect(of(info).tier).toBe("strategic");
  });

  it("leaves out accepted risks and says why, and expired exceptions stop counting", () => {
    expect(excluded.map((e) => [e.finding.id, e.reason])).toEqual([
      [accepted.id, "Marked accepted risk (no expiry recorded — review it periodically)"],
      [excepted.id, "Accepted risk (exception still valid)"],
    ]);
    const ev = (until: string, at: string, revoked = false) => ({ detail: { findingId: "f1", until, reason: "compensating WAF rule", revoked }, created_at: at });
    expect(activeExceptions([ev("2026-11-01", "2026-10-01")], NOW).has("f1")).toBe(true);
    expect(activeExceptions([ev("2026-10-20", "2026-10-01")], NOW).has("f1")).toBe(false);
    expect(activeExceptions([ev("2026-11-01", "2026-10-01"), ev("", "2026-10-02", true)], NOW).has("f1")).toBe(false);
  });

  it("raises a finding when logs show attack attempts or malicious activity, without changing its severity", () => {
    const f = finding({ rule_id: "code.path-traversal", severity: "high", confidence: "firm", asset: "github:acme/api" });
    const quiet = prioritise([f], { ...ctx, excepted: new Set() }).ranked[0]!;
    const hot = prioritise([f], { ...ctx, excepted: new Set(), attempted: new Set([f.id]) }).ranked[0]!;
    expect(hot.points - quiet.points).toBe(10);
    expect(hot.finding.severity).toBe("high");
    expect(quiet.tier).toBe("priority");
  });
});

describe("attack paths stay hypotheses", () => {
  const secret = finding({ rule_id: "secret.aws-key", severity: "critical", confidence: "confirmed", title: "AWS key in config.js" });
  const login = finding({ agent: "threat_hunter", rule_id: "auth.success-after-failures", severity: "high", asset: "auth-logs.txt", location: null, title: "Login succeeded after 40 failures" });

  it("connects a leaked credential with suspicious logins, but only as a low-confidence possibility when the systems aren't linked", () => {
    const { assets } = buildModel({ findings: [secret, login], runs: [], verifiedHosts: [], facts: new Map() });
    const p = aegisPaths([secret, login], assets).find((x) => x.id === `cred:${secret.id}`)!;
    expect(p).toMatchObject({ source: "cross-agent", confidence: "low", reproduced: false });
    expect(p.relations[0]!.basis).toBe("not linked (assumed)");
    expect(p.reproducedNote).toMatch(/Not reproduced/);
  });

  it("treats systems you linked as the same system, and only then raises its confidence", () => {
    const f = foldAssetFacts([{ detail: { asset: "github:acme/shop", links: ["auth-logs.txt"] }, created_at: "2026-10-02" }]);
    const { assets } = buildModel({ findings: [secret, login], runs: [], verifiedHosts: [], facts: f });
    const p = aegisPaths([secret, login], assets).find((x) => x.id === `cred:${secret.id}`)!;
    expect(p.confidence).toBe("medium");
    expect(p.relations[0]!.basis).toBe("linked assets (declared)");
  });

  it("doesn't connect a known-exploited dependency to attacks on an unrelated system", () => {
    const dep = finding({ rule_id: "deps.vulnerable", severity: "critical", title: "struts — CVE-2017-5638" });
    const attack = finding({ agent: "threat_hunter", rule_id: "web.payload", asset: "other-logs.txt", severity: "high" });
    const { assets } = buildModel({ findings: [dep, attack], runs: [], verifiedHosts: [], facts: new Map() });
    expect(aegisPaths([dep, attack], assets, { kev: new Set(["CVE-2017-5638"]) }).some((p) => p.id.startsWith("kev:"))).toBe(false);
    const linked = buildModel({ findings: [dep, attack], runs: [], verifiedHosts: [], facts: foldAssetFacts([{ detail: { asset: dep.asset, links: ["other-logs.txt"] }, created_at: "x" }]) }).assets;
    expect(aegisPaths([dep, attack], linked, { kev: new Set(["CVE-2017-5638"]) }).find((p) => p.id === `kev:${dep.id}`)).toMatchObject({ confidence: "low", reproduced: false });
  });

  it("suggests links between similarly named assets as hypotheses, not as facts", () => {
    const a = finding({ asset: "github:acme/storefront" });
    const b = finding({ agent: "sentinel", asset: "storefront.example", location: "https://storefront.example/" });
    const { assets } = buildModel({ findings: [a, b], runs: [], verifiedHosts: ["storefront.example"], facts: new Map() });
    expect(assets.find((x) => x.key === a.asset)!.related).toEqual([expect.objectContaining({ key: b.asset, basis: "suggested" })]);
  });
});

describe("duplicates", () => {
  it("groups the same CVE reported twice on one asset and keeps the most severe; the same CVE elsewhere is a separate issue", () => {
    const x = finding({ rule_id: "deps.vulnerable", severity: "high", title: "lodash: CVE-2021-23337", location: "package.json" });
    const y = finding({ rule_id: "deps.lockfile", severity: "critical", title: "Locked lodash version has CVE-2021-23337", location: "package-lock.json" });
    const elsewhere = finding({
      agent: "sentinel",
      rule_id: "deps.client-lib",
      severity: "critical",
      title: "Vulnerable lodash served (CVE-2021-23337)",
      asset: "shop.example",
      location: "https://shop.example/app.js",
    });
    const g = duplicateCandidates([x, y, elsewhere]);
    expect(g).toHaveLength(1);
    expect(g[0]!.keep.id).toBe(y.id);
    expect(g[0]!.duplicates.map((d) => d.id)).toEqual([x.id]);
    expect(g[0]!.reason).toMatch(/CVE-2021-23337/);
  });
});

describe("remediation is verified only by a re-check after the fix", () => {
  const ev = (status: string, at: string, extra: Record<string, unknown> = {}): AegisEvent => ({
    action: "aegis.workflow",
    detail: { kind: "remediation", remediationId: "R-abc123", title: "Rotate key", findingIds: extra.ids ?? [], status, ...extra },
    created_at: at,
  });
  const flow = (ids: string[]) => [ev("proposed", "2026-10-05T00:00:00Z", { ids }), ev("approved", "2026-10-06T00:00:00Z", { ids }), ev("verification_required", "2026-10-10T00:00:00Z", { ids })];
  const gone = (p: Partial<AegisFinding> = {}) =>
    finding({ verification: "not_detected", last_seen: "2026-10-01T00:00:00Z", updated_at: "2026-10-12T00:00:00Z", verification_note: "Not detected on 2026-10-12", ...p });
  const still = (p: Partial<AegisFinding> = {}) => finding({ verification: "still_present", last_seen: "2026-10-12T00:00:00Z", updated_at: "2026-10-12T00:00:00Z", ...p });
  const fold = (fs: AegisFinding[]) =>
    remediations(
      flow(fs.map((f) => f.id)).map((e) => ({ ...e, detail: { ...e.detail, findingIds: fs.map((f) => f.id) } })),
      fs,
    )[0]!;

  it("nobody can mark a fix verified, failed or partly resolved by hand", () => {
    for (const s of ["verified", "failed", "partially_resolved"] as const) expect(canTransition("verification_required", s)).toMatch(/set by a re-check/);
    expect(canTransition(null, "in_progress")).toMatch(/Start a remediation/);
    expect(canTransition("proposed", "approved")).toBeNull();
    expect(canTransition("proposed", "verification_required")).toMatch(/Can't go from Proposed/);
  });

  it("stays waiting for a re-check after the fix is applied, whatever happened before", () => {
    const old = finding({ verification: "not_detected", updated_at: "2026-10-08T00:00:00Z", verification_note: "Not detected on 2026-10-08" });
    const r = fold([old]);
    expect(r.status).toBe("verification_required");
    expect(r.remaining).toEqual([`${old.title}: not re-checked since the fix was applied`]);
  });

  it("is verified when every finding is gone on a re-check after the fix, failed when all are still there, partly resolved otherwise", () => {
    expect(fold([gone(), gone()]).status).toBe("verified");
    expect(fold([still()]).status).toBe("failed");
    const mixed = fold([gone(), still({ title: "Second key" })]);
    expect(mixed.status).toBe("partially_resolved");
    expect(mixed.remaining).toEqual(["Second key: still detected"]);
    expect(mixed.history.at(-1)).toMatchObject({ by: "evidence", status: "partially_resolved" });
  });

  it("doesn't take an edit to the finding (a note, a status change) as a re-check", () => {
    // Updated after the fix, but the "not detected" result is dated before it.
    expect(fold([gone({ verification_note: "Not detected on 2026-10-08" })]).status).toBe("verification_required");
  });
});

describe("the assembled command center", () => {
  it("is honest with no data: nothing ranked, unavailable domains shown as unavailable, their tasks blocked", () => {
    const s = assembleAegis(input({}));
    expect(s.ranked).toEqual([]);
    expect(s.paths).toEqual([]);
    const state = Object.fromEntries(s.coverage.domains.map((d) => [d.id, d.state]));
    expect(state).toMatchObject({ cloud: "unavailable", validation: "unavailable", compliance: "unavailable", web: "not_assessed", code: "not_assessed" });
    // Tasks for agents that don't exist are blocked, not pretended; identity can be partly covered by uploading sign-in logs.
    const connect = s.tasks.filter((t) => t.kind === "connect");
    expect(connect.filter((t) => ["cloud_guardian", "red_team", "compliance_privacy"].includes(t.agent)).map((t) => t.state)).toEqual(["blocked", "blocked", "blocked"]);
    expect(connect.find((t) => t.agent === "identity_guardian")?.state).toBe("proposed");
    expect(s.answers.matters[0]).toMatch(/Nothing needs immediate attention/);
  });

  it("never simulates an agent that doesn't exist", () => {
    const unavailable = ROSTER.filter((a) => a.status === "unavailable").map((a) => a.id);
    expect(unavailable).toEqual(expect.arrayContaining(["cloud_guardian", "red_team", "compliance_privacy"]));
    const s = assembleAegis(input({ runs: [run({})] }));
    for (const a of s.agents.filter((x) => unavailable.includes(x.agent.id))) expect(a.runs).toBe(0);
  });

  it("plans investigate → repair → verify for an immediate risk, in that order", () => {
    const f = finding({ rule_id: "deps.vulnerable", severity: "critical", confidence: "confirmed", title: "lodash 4.17.0 — CVE-2021-23337" });
    const s = assembleAegis(
      input({
        findings: [f],
        runs: [run({})],
        kev: { cves: new Map([["CVE-2021-23337", { ransomware: true }]]), available: true, retrievedAt: "2026-10-23" },
        events: [{ action: "aegis.asset", detail: { asset: "github:acme/shop", exposure: "internet", criticality: "critical" }, created_at: "2026-10-02T00:00:00Z" }],
      }),
    );
    const mine = s.tasks.filter((t) => t.findingIds.includes(f.id));
    expect(mine.map((t) => t.kind)).toEqual(["investigate", "repair", "verify"]);
    expect(mine[1]!.dependsOn).toEqual([mine[0]!.id]);
    expect(mine[2]!.dependsOn).toEqual([mine[1]!.id]);
    expect(mine.every((t) => /^T-[0-9A-F]{8}$/.test(t.id))).toBe(true);
    expect(s.investigations[0]!.steps).toHaveLength(10);
    expect(s.investigations[0]!.steps[9]!.content).toEqual(["No conclusion recorded yet."]);
  });

  it("writes reports that call attack paths hypotheses and list what isn't covered", () => {
    const s = assembleAegis(
      input({
        findings: [
          finding({ rule_id: "secret.aws-key", severity: "critical", confidence: "confirmed" }),
          finding({ agent: "threat_hunter", rule_id: "auth.success-after-failures", asset: "auth-logs.txt", location: null }),
        ],
      }),
    );
    expect(executiveReport(s)).toMatch(/Attack paths are hypotheses/);
    expect(executiveReport(s)).toMatch(/Cloud.*no capability/);
    expect(technicalReport(s)).toMatch(/not reproduced/);
    expect(operationalReport(s)).toMatch(/No scheduled monitoring runs/);
  });

  it("reports Bastion's state when it's loaded, and fail-closed when its controls can't be read", () => {
    expect(assembleAegis(input({ bastion: { available: true, lockdown: false, decisions: 3, denied: 2, needsApproval: 1 } })).answers.happening.at(-1)).toMatch(
      /recorded 2 refused and 1 approval-needed/,
    );
    expect(assembleAegis(input({ bastion: { available: false, lockdown: false, decisions: 0, denied: 0, needsApproval: 0 } })).answers.happening.at(-1)).toMatch(/fail closed/);
  });
});
