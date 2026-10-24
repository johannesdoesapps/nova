/**
 * Threat Hunter: parsers and source inventory, the detection library's own test cases, the synthetic
 * validation scenarios (malicious and benign), investigation building, intelligence records and the
 * report QA check. All data is synthetic (documentation IP ranges, example domains).
 */
import { describe, expect, it } from "vitest";
import { analyseLogs, huntSections } from "@/lib/security/hunt/analyse";
import { cleanRaw, filterEvents, mapCloudTrail, mapOkta, mapWindows, parseHuntLogs, parseSyslogLine } from "@/lib/security/hunt/events";
import { cvesIn, ipRecord, matchKev, uncheckedRecord, type KevCatalog } from "@/lib/security/hunt/intel";
import { compactInvestigations, fitHuntStats, HUMAN_STATES, jsonBytes, relatedPrior } from "@/lib/security/hunt/investigate";
import { qaCheck } from "@/lib/security/hunt/qa";
import { entropy, HUNT_RULES, registeredDomain, runRuleTests } from "@/lib/security/hunt/rules";
import { SCENARIOS, runScenario, validate } from "@/lib/security/hunt/scenarios";
import { investigationPatch } from "@/lib/security/schema";

const scenario = (id: string) => SCENARIOS.find((s) => s.id === id)!;

describe("parsers and source inventory", () => {
  it("maps CloudTrail, Okta and Windows records to one event model", () => {
    const ct = mapCloudTrail({
      eventTime: "2026-10-20T10:00:00Z",
      eventName: "ConsoleLogin",
      eventSource: "signin.amazonaws.com",
      sourceIPAddress: "198.51.100.4",
      userIdentity: { type: "Root" },
      responseElements: { ConsoleLogin: "Success" },
    });
    expect(ct).toMatchObject({ source: "cloudtrail", action: "ConsoleLogin", outcome: "success", ip: "198.51.100.4", privileged: true });
    const okta = mapOkta({
      published: "2026-10-20T10:00:00Z",
      eventType: "user.session.start",
      actor: { alternateId: "ana@example.com" },
      client: { ipAddress: "198.51.100.5" },
      outcome: { result: "FAILURE" },
    });
    expect(okta).toMatchObject({ source: "okta", user: "ana@example.com", outcome: "failure" });
    const win = mapWindows({ EventID: 4625, TimeCreated: "2026-10-20T10:00:00Z", TargetUserName: "admin", IpAddress: "198.51.100.6", Computer: "ws1" });
    expect(win).toMatchObject({ source: "windows", category: "auth", outcome: "failure", user: "admin" });
  });

  it("parses Linux auth lines (sudo, useradd) and ignores unrelated lines", () => {
    expect(parseSyslogLine("Oct 20 11:01:00 web1 sudo:   deploy : TTY=pts/0 ; PWD=/home/deploy ; USER=root ; COMMAND=/bin/bash", 2026)).toMatchObject({ user: "deploy", host: "web1" });
    expect(parseSyslogLine("Oct 20 11:02:00 web1 useradd[900]: new user: name=sysupdate, UID=1003", 2026)).toMatchObject({ category: "account" });
    expect(parseSyslogLine("not a log line", 2026)).toBeNull();
  });

  it("records formats, unparsed lines, time range and gaps per file", () => {
    const line = (day: number, s: number) => `Oct ${day} 10:00:${String(s).padStart(2, "0")} web1 sshd[1]: Failed password for root from 203.0.113.1 port ${s} ssh2`;
    const lines = [...Array.from({ length: 12 }, (_, s) => line(20, s)), ...Array.from({ length: 12 }, (_, s) => line(22, s)), "something unrecognised"];
    const p = parseHuntLogs([{ name: "auth.log", content: lines.join("\n") }], 2026);
    const inv = p.inventory[0]!;
    expect(inv.events).toBe(24);
    expect(inv.unparsed).toBe(1);
    expect(inv.first?.startsWith("2026-10-20")).toBe(true);
    expect(inv.gaps.length).toBeGreaterThan(0);
  });

  it("masks credentials before lines are stored as evidence", () => {
    expect(cleanRaw("GET /login?user=a&password=hunter2 HTTP/1.1")).not.toContain("hunter2");
  });

  it("filters events by field:value terms and free text", () => {
    const p = parseHuntLogs(scenario("ssh-takeover").files, 2026);
    expect(filterEvents(p.events, "user:sysupdate").length).toBeGreaterThan(0);
    expect(filterEvents(p.events, "ip:203.0.113.7 outcome:success").every((e) => e.outcome === "success")).toBe(true);
    expect(filterEvents(p.events, "")).toHaveLength(p.events.length);
  });
});

describe("detection library", () => {
  it("every rule documents its logic, tactic, benign causes and queries", () => {
    for (const r of HUNT_RULES) {
      expect(r.version, r.id).toMatch(/^\d+\.\d+/);
      expect(r.benign.length, r.id).toBeGreaterThan(0);
      expect(r.limitations.length, r.id).toBeGreaterThan(0);
      expect(r.queries.splunk || r.queries.sentinel || r.queries.shell, r.id).toBeTruthy();
    }
  });

  it("passes every rule's own positive and negative test cases", () => {
    const results = HUNT_RULES.flatMap((r) => runRuleTests(r));
    expect(results.filter((r) => !r.passed)).toEqual([]);
    expect(results.length).toBeGreaterThan(20);
  });

  it("helpers: entropy and registered domain", () => {
    expect(entropy("aaaa")).toBe(0);
    expect(entropy("a8f3k2q9z1x7")).toBeGreaterThan(3);
    expect(registeredDomain("a.b.example.com")).toBe("example.com");
  });
});

describe("validation scenarios (synthetic)", () => {
  it.each(SCENARIOS.map((s) => [s.id, s] as const))("%s", (_id, s) => {
    const r = runScenario(s);
    expect({ missed: r.missed, unexpected: r.unexpected, noisy: r.noisy, stateOk: r.stateOk }).toEqual({ missed: [], unexpected: [], noisy: [], stateOk: true });
  });

  it("finds every expected detection and escalates no benign scenario", () => {
    const v = validate();
    expect(v.foundDetections).toBe(v.expectedDetections);
    expect(v.benignScenarios).toBeGreaterThanOrEqual(5);
    expect(v.benignWithAlerts).toBe(0);
    expect(v.benignEscalated).toBe(0);
  });
});

describe("investigations", () => {
  it("groups the SSH takeover into one investigation with stages, hypotheses and an approval-gated plan", () => {
    const a = analyseLogs(scenario("ssh-takeover").files, "web1", { year: 2026 });
    const top = a.investigations[0]!;
    expect(top.state).toBe("likely_malicious");
    expect(top.entities.users).toContain("deploy");
    expect(top.chain.length).toBeGreaterThanOrEqual(3);
    expect(top.hypotheses.some((h) => h.kind === "benign")).toBe(true);
    expect(top.response.containment.length).toBeGreaterThan(0);
    expect(top.response.containment.every((c) => typeof c.approval === "boolean")).toBe(true);
    expect(top.handoffs.length).toBeGreaterThan(0);
  });

  it("never sets a state only people may set", () => {
    for (const s of SCENARIOS) for (const i of analyseLogs(s.files, s.id, { year: 2026 }).investigations) expect(["confirmed_malicious", "benign", "contained", "resolved"]).not.toContain(i.state);
  });

  it("treats an address many users sign in from as shared", () => {
    const a = analyseLogs(scenario("office-nat").files, "office", { year: 2026 });
    expect(a.shared.length).toBeGreaterThan(0);
    expect(a.findings.every((f) => f.severity === "low" || f.severity === "info")).toBe(true);
  });

  it("links earlier investigations that share an account", () => {
    const a = analyseLogs(scenario("ssh-takeover").files, "web1", { year: 2026 });
    const prior = relatedPrior(a.investigations[0]!, [{ runId: "r1", at: "2026-10-01T00:00:00Z", investigations: a.investigations }]);
    expect(prior[0]?.overlap.length).toBeGreaterThan(0);
  });

  it("keeps every investigation visible: top ones in full (shorter detail), the rest as summaries", () => {
    const files = ["ssh-takeover", "office-nat", "dns-tunnel", "cloud-root"].flatMap((id) => scenario(id).files.map((f) => ({ ...f, name: `${id}-${f.name}` })));
    const a = analyseLogs(files, "web1", { year: 2026 });
    expect(a.investigations.length).toBeGreaterThanOrEqual(4);
    const { investigations, trimmed } = compactInvestigations(a.investigations, 13_000);
    expect(jsonBytes(investigations)).toBeLessThanOrEqual(13_000);
    expect(investigations.map((i) => i.id)).toEqual(a.investigations.map((i) => i.id));
    expect(investigations[0]!.summaryOnly).toBeFalsy();
    expect(investigations.at(-1)!.summaryOnly).toBe(true);
    expect(trimmed.join(" ")).toMatch(/summaries/);
    // Response items keep their positions, so recorded actions still point at the right item.
    expect(investigations[0]!.response.containment[0]).toEqual(a.investigations[0]!.response.containment[0]);
    // With room to spare, nothing is cut.
    expect(compactInvestigations(a.investigations, 100_000).trimmed).toEqual([]);
  });

  it("fits a whole hunt's stats under the database limit, leaving room for decisions", () => {
    const a = analyseLogs(
      SCENARIOS.flatMap((s) => s.files.map((f) => ({ ...f, name: `${s.id}-${f.name}` }))),
      "all",
      { year: 2026 },
    );
    const intel = Array.from({ length: 20 }, (_, i) =>
      uncheckedRecord("domain", `host${i}.example.net`, "No domain reputation service is connected — a long caveat to take up space in the record.", i),
    );
    const stats = fitHuntStats({ ...a.stats, inventory: a.parsed.inventory, investigations: a.investigations, intel, qa: [], timeline: a.timeline, sharedAddresses: a.shared });
    expect(jsonBytes(stats)).toBeLessThanOrEqual(19_000 - 1_500);
    expect((stats.investigations as unknown[]).length).toBeGreaterThan(0);
    expect(stats.timeline).toBeUndefined();
  });

  it("report input lists sources, investigations and recommendations marked as not performed", () => {
    const a = analyseLogs(scenario("cloud-root").files, "aws", { year: 2026 });
    const text = huntSections(a);
    expect(text).toContain("Sources analysed:");
    expect(text).toContain("Recommended (not performed)");
  });

  it("state changes need a note; action keys are checked", () => {
    expect(investigationPatch.safeParse({ state: "benign" }).success).toBe(false);
    expect(investigationPatch.safeParse({ state: "benign", note: "Approved maintenance window" }).success).toBe(true);
    expect(investigationPatch.safeParse({ action: { key: "containment:0", status: "approved" } }).success).toBe(true);
    expect(investigationPatch.safeParse({ action: { key: "anything:0", status: "approved" } }).success).toBe(false);
    expect(HUMAN_STATES).toContain("confirmed_malicious");
  });
});

describe("intelligence", () => {
  it("IP reputation records carry source, date and caveats", () => {
    const r = ipRecord(
      {
        ip: "203.0.113.9",
        score: 80,
        reports: 12,
        country: "NL",
        isp: "Example Hosting",
        usageType: "Data Center/Web Hosting/Transit",
        lastReportedAt: "2026-08-01T00:00:00Z",
        retrievedAt: "2026-10-24T00:00:00Z",
      },
      3,
      Date.parse("2026-10-24T00:00:00Z"),
    );
    expect(r.source).toBe("AbuseIPDB");
    expect(r.stale).toBe(true);
    expect(r.caveats.join(" ")).toMatch(/share/i);
    expect(uncheckedRecord("domain", "example.com", "No domain reputation service is connected.").checked).toBe(false);
  });

  it("KEV: dependency CVEs are verified, technology matches are leads", () => {
    const entry = (cveID: string, product: string, dateAdded: string) => ({
      cveID,
      vendorProject: product,
      product,
      vulnerabilityName: `${product} issue`,
      dateAdded,
      shortDescription: "x",
      requiredAction: "Patch",
      dueDate: "2026-11-01",
    });
    const catalog: KevCatalog = {
      version: "test",
      released: "2026-10-20",
      retrievedAt: "2026-10-24T00:00:00Z",
      entries: [entry("CVE-2026-0001", "Nginx", "2026-09-01"), entry("CVE-2020-0002", "Nginx", "2020-01-01"), entry("CVE-2026-0003", "Lodash", "2026-01-01")],
    };
    const out = matchKev(catalog, { cves: [{ cve: "CVE-2026-0003", where: "lodash 4.17.0" }], technologies: ["nginx 1.25"] }, Date.parse("2026-10-24T00:00:00Z"));
    expect(out.find((a) => a.cve === "CVE-2026-0003")?.match.verified).toBe(true);
    expect(out.find((a) => a.cve === "CVE-2026-0001")?.match).toMatchObject({ kind: "technology", verified: false });
    expect(out.find((a) => a.cve === "CVE-2020-0002")).toBeUndefined();
    expect(cvesIn("OSV GHSA-x (cve-2024-1234), CVE-2024-1234")).toEqual(["CVE-2024-1234"]);
  });
});

describe("report QA", () => {
  const open = [{ state: "suspicious" as const, signals: [] }];
  it("flags unsupported attribution, certainty, unseen data and monitoring claims", () => {
    const issues = qaCheck("This was APT29, a nation-state group. The server was compromised. EDR shows the payload. We are monitoring the host.", open);
    expect(new Set(issues.map((i) => i.kind))).toEqual(new Set(["attribution", "overconfidence", "unseen_source", "monitoring_claim"]));
  });
  it("leaves careful wording alone", () => {
    expect(qaCheck("The evidence suggests a possible takeover of deploy. We recommend continuously monitoring sign-ins.", open)).toEqual([]);
  });
});
